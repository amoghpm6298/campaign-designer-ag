// The agent loop. One prompt, every tool on every round, the agent decides.
// The application only keeps the record (plan file, flags, timeline) and
// reports what happened; it never switches the prompt or hides a tool.

import { callClaude, resolveModel, streamClaude, type ApiMessage, type ToolUseBlock } from '../anthropic';
import { compactIfNeeded, compactionCutoff, contextWindow, estimateTokens, isTooLong, type ApiMessage as CompactMessage, type Summarise } from './compaction';
import { EventEmitterSeq, type RunEvent } from '../runEvents';
import { resolveTenant } from '../tenants';
import { bankContext, knowledgeForPrompt, seedKnowledgeBase, type KnowledgeBase } from '../knowledge';
import { issuerContext } from '../blueprint';
import type { Channel } from '../../src/data/sharedConstants';
import { systemPrompt, statusBlock } from './prompt';
import { TOOL_TITLES, runToolCall, toolsFor, type ToolEnv } from './tools';
import { runAskData } from './askData';
import { applySplitOutcomes, closingMessage, pendingSplitIdeas, runSplitHelper } from './splitHelper';
import { costSnapshot, type CostSnapshot } from '../costModel';
import { emptyCampaign, emptyContext, normaliseState, recordAnswers, recordSkips } from './state';
import { loadStores, saveCampaignObject, saveContext } from '../campaignFiles';
import { focusSection } from './focus';
import { listLinks } from '../links';
import { getBankSettings } from '../bankSettings';
import { checkJourneys } from './compile';
import { currentEntries } from '../../src/designer/v2/contextView';
import { ensureBaseline, recordVersion, setSummary, summariseVersion, type VersionEntry } from '../campaignVersions';
import { warehouseAvailable } from '../warehouse';
import type { AgentQuestion, AgentRequest, AgentResponse, AgentState } from './types';

// A safety net against runaway turns only; the context window is managed by compaction.
const MAX_ROUNDS = 60;
/** How many times the app sends the agent back to fix problems it left at the end of a turn. */
const MAX_REPAIR_ROUNDS = 2;
const REACH_ORDER: Channel[] = ['WHATSAPP', 'SMS', 'EMAIL', 'RCS'] as Channel[];

export function channelsFor(tenant: NonNullable<ReturnType<typeof resolveTenant>>): Channel[] {
  return tenant.availableChannels
    .filter((c) => c.available)
    .sort((a, b) => REACH_ORDER.indexOf(a.channel as Channel) - REACH_ORDER.indexOf(b.channel as Channel))
    .map((c) => c.channel as Channel);
}

/** If this turn changed the campaign, records it as a version with a short summary. */
async function versionThisTurn(sessionId: string, start: AgentState['campaign'], end: AgentState['campaign'], request: string, source: 'chat' | 'repair' = 'chat', cost?: CostSnapshot | null, costOf?: (c: AgentState['campaign']) => CostSnapshot | null): Promise<VersionEntry | null> {
  if (start === end) return null;
  try {
    ensureBaseline(sessionId, start);
    const v = recordVersion({ sessionId, campaign: end, source, request, cost, costOf });
    if (!v) return null;
    const summary = await summariseVersion(v.diff, request);
    if (summary !== v.summary) setSummary(sessionId, v.n, summary);
    const { campaign: _c, diff: _d, ...entry } = v;
    void _c;
    void _d;
    return { ...entry, summary };
  } catch (e) {
    console.error(`[versions] could not record ${sessionId}: ${(e as Error).message}`);
    return null;
  }
}

/** The tool setup for a tenant: channels and warehouse. Shared with direct edits. */
export function toolEnvFor(tenantId: string | undefined, sessionId: string, goalStatement = ''): ToolEnv | null {
  const tenant = resolveTenant(tenantId);
  if (!tenant) return null;
  return {
    tenant,
    availableChannels: channelsFor(tenant),
    goalStatement,
    sessionId,
    warehouseBank: tenant.warehouse && warehouseAvailable(tenant.warehouse.bank) ? tenant.warehouse.bank : undefined,
    lookupCache: new Map(),
    links: listLinks(tenant.tenantId),
    smsFallback: getBankSettings(tenant.tenantId).smsFallback,
  };
}

/** Alternating user/assistant messages, merging consecutive turns from the same side. */
function toApiMessages(messages: AgentRequest['messages']): ApiMessage[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const m of messages ?? []) {
    if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim()) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += `\n\n${m.content}`;
    else out.push({ role: m.role, content: m.content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

/** The conversation state with both stores as they are on disk (empty if this chat has none yet). */
export function withStoresFromDisk(state: AgentState, sessionId: string, dir?: string): AgentState {
  let stores: { campaign: AgentState['campaign'] | null; context: AgentState['context'] | null } = { campaign: null, context: null };
  try {
    stores = loadStores(sessionId, dir);
  } catch {
    /* not a valid session id: start empty, and nothing will be saved */
  }
  return { ...state, campaign: stores.campaign ?? emptyCampaign(), context: stores.context ?? emptyContext() };
}

/** Writes whichever store changed through to disk, the moment it changes. Returns which were saved. */
export function persistIfChanged(before: AgentState, after: AgentState, sessionId: string, tenantId: string, dir?: string): { campaign: boolean; context: boolean } {
  const saved = { campaign: false, context: false };
  try {
    if (after.campaign !== before.campaign) {
      saveCampaignObject(sessionId, tenantId, after.campaign, dir);
      saved.campaign = true;
    }
    if (after.context !== before.context) {
      saveContext(sessionId, tenantId, after.context, dir);
      saved.context = true;
    }
  } catch (e) {
    console.error(`[campaign] could not save ${sessionId}: ${(e as Error).message}`);
  }
  return saved;
}

export async function* agentStream(req: AgentRequest): AsyncGenerator<RunEvent, AgentResponse> {
  const runId = `run-${Date.now().toString(36)}`;
  const pending: RunEvent[] = [];
  const all: RunEvent[] = [];
  const em = new EventEmitterSeq(runId, (e) => {
    pending.push(e);
    // Deltas and live state snapshots stream to the browser but are not kept in the turn's record.
    if (e.type !== 'model.text.delta' && e.type !== 'state.updated') all.push(e);
  });
  const drain = function* () {
    while (pending.length) yield pending.shift()!;
  };

  // The campaign itself lives on disk, keyed by this chat's session id. The
  // request carries only the conversation; whatever campaign it sends is ignored.
  let state: AgentState = withStoresFromDisk(normaliseState(req.state), req.sessionId);
  // What the campaign was when this turn started: a turn that changes it becomes a version.
  const startCampaign = state.campaign;
  const turnStart = new Date().toISOString();
  let briefAsked = false;
  /** Split helpers run at most once per turn. */
  let splitsRan = false;
  const base = (extra: Partial<AgentResponse>): AgentResponse => ({
    sessionId: req.sessionId,
    runId,
    reply: '',
    state,
    questionItems: [],
    graph: null,
    campaign: null,
    buildNotes: [],
    events: all,
    warehouseAccess: false,
    ...extra,
  });

  const tenant = resolveTenant(req.tenantId);
  if (!tenant) return base({ reply: 'That tenant is not recognised. Pick one from the list and try again.', error: 'unknown-tenant' });
  // The bank's link registry, read once per turn (the agent sees references only).
  const bankLinks = listLinks(tenant.tenantId);
  const delivery = getBankSettings(tenant.tenantId);

  // --- the manager's answers since the last turn ----------------------------
  const latestUser = [...(req.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';
  {
    // The app files the manager's answers (and skips) in the context itself.
    const before = state;
    state = recordAnswers(state, req.answers, req.skipped?.length ? '' : latestUser);
    state = recordSkips(state, req.skipped);
    persistIfChanged(before, state, req.sessionId, tenant.tenantId);
  }

  // --- context: fixed per tenant, so the system prompt stays cacheable --------
  const knowledge = (req.knowledge as KnowledgeBase | undefined) ?? (seedKnowledgeBase() as KnowledgeBase);
  const availableChannels = channelsFor(tenant);
  const warehouseBank = tenant.warehouse && warehouseAvailable(tenant.warehouse.bank) ? tenant.warehouse.bank : undefined;
  const system = [
    systemPrompt(!!warehouseBank, !!tenant.incentives),
    `# Context\nIssuer: ${tenant.issuer} (synthetic tenant).\n${issuerContext(availableChannels, tenant.templateLibraryAccess === 'synthetic-demo' ? 'synthetic-demo' : 'unavailable')}`,
    `# Knowledge base\n${knowledgeForPrompt(knowledge, tenant.tenantId)}`,
  ].join('\n\n');
  void bankContext;

  const conversation: ApiMessage[] = toApiMessages(req.messages);
  if (!conversation.length) return base({ reply: 'Tell me what you want the campaign to achieve.', error: 'no-message' });
  // The status block rides the latest user message, so the system prompt never changes.
  const last = conversation[conversation.length - 1];
  if (last.role === 'user') {
    conversation[conversation.length - 1] = {
      role: 'user',
      content: [
        { type: 'text', text: String(last.content) },
        { type: 'text', text: [statusBlock(state, bankLinks, delivery.smsFallback), focusSection(state, req.focus)].filter(Boolean).join('\n\n') },
      ],
    };
  }

  const env: ToolEnv = {
    tenant,
    availableChannels,
    goalStatement: req.messages.find((m) => m.role === 'user')?.content ?? '',
    sessionId: req.sessionId,
    warehouseBank,
    lookupCache: new Map(),
    links: bankLinks,
    smsFallback: delivery.smsFallback,
  };
  const tools = toolsFor(!!warehouseBank, !!tenant.incentives).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));

  // Compaction (server/agent/compaction.ts): the turn's opening messages are never touched.
  const baseLen = conversation.length;
  const model = resolveModel();
  const window = contextWindow(model);
  const cutoff = compactionCutoff(model);
  const summarise: Summarise = async (sys, text) => (await callClaude({ system: sys, messages: [{ role: 'user', content: text }], maxTokens: 1_200, timeoutMs: 120_000 })).text;
  // Calibrated against the API's real token counts every round. The character estimate undercounts
  // JSON-heavy content, so: scale = real tokens per estimated token, measured from each round's
  // input, and overhead = the fixed part sent every round (system prompt, tools), in real tokens.
  // The cutoff covers the whole request; the conversation's share, in estimate units, is
  // (cutoff - overhead) / scale.
  const fixedEstimate = estimateTokens(system) + estimateTokens(tools);
  let scale = 1;
  let overhead = fixedEstimate;
  const compactNow = async (round: number, force: boolean) => {
    const messagesCutoff = Math.max(1, Math.floor((cutoff - overhead) / scale));
    const r = await compactIfNeeded(conversation as CompactMessage[], { baseLen, cutoff: messagesCutoff, summarise, force });
    if (r.messages === (conversation as CompactMessage[])) return;
    conversation.splice(0, conversation.length, ...(r.messages as ApiMessage[]));
    r.before = Math.round(r.before * scale + overhead);
    r.after = Math.round(r.after * scale + overhead);
    em.emit('model.tool_call.completed', 'understanding', r.tier === 2 ? 'Summarised earlier steps to save space' : 'Shortened earlier results to save space', {
      status: 'ok',
      correlationId: `compaction-${round}`,
      detail: `~${Math.round(r.before / 1000)}k → ~${Math.round(r.after / 1000)}k tokens (window ${Math.round(window / 1000)}k, cutoff ${Math.round(cutoff / 1000)}k)${force ? ' · forced' : ''}`,
      data: { tool: 'compaction', input: { tier: r.tier, force }, result: { before: r.before, after: r.after, masked: r.masked, cutoff, window }, round },
    });
  };

  // Loop check: the same call with the same input a 3rd time is refused; after 3 refusals the turn
  // ends (and says plainly what isn't built). Reads are exempt: re-reading after compaction is right.
  // A build counts as "the same" only when nothing changed since the last one.
  const callCounts = new Map<string, number>();
  let loopRefusals = 0;
  let loopStopped = false;
  let lastBuildOf: { campaign: object; context: object } | null = null;
  const callKey = (name: string, input: unknown) =>
    name === 'build_campaign'
      ? lastBuildOf && lastBuildOf.campaign === state.campaign && lastBuildOf.context === state.context
        ? 'build_campaign:unchanged'
        : null
      : /^(get|list)_/.test(name)
        ? null
        : `${name}:${JSON.stringify(input ?? {})}`;

  const textSegments: string[] = [];
  const asked: AgentQuestion[] = [];
  let built: { graph: unknown; campaign: unknown; notes: string[] } | null = null;
  let wrapUp = false;
  let repairRounds = 0;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const textId = `text-${round}`;
      let roundText = '';
      const toolUses: ToolUseBlock[] = [];
      let content: unknown[] = [];
      let stopReason: string | undefined;

      await compactNow(round, false);
      yield* drain();
      let usage: { input_tokens?: number; output_tokens?: number } | undefined;
      let sentTokens = 0;
      for (let attempt = 0; ; attempt++) {
        try {
          sentTokens = estimateTokens(conversation);
          for await (const chunk of streamClaude({
            system,
            messages: conversation,
            tools,
          })) {
            if (chunk.text) {
              roundText += chunk.text;
              em.emit('model.text.delta', 'understanding', '', { data: { text: chunk.text, round }, correlationId: textId });
              yield* drain();
            }
            if (chunk.toolUse) {
              toolUses.push(chunk.toolUse);
              const t = TOOL_TITLES[chunk.toolUse.name];
              em.emit('model.tool_call.started', 'understanding', t?.running ?? chunk.toolUse.name, {
                status: 'running',
                correlationId: chunk.toolUse.id,
                data: { tool: chunk.toolUse.name, input: chunk.toolUse.input, round },
              });
              yield* drain();
            }
            if (chunk.done) {
              content = chunk.done.content;
              stopReason = chunk.done.stopReason;
              usage = chunk.done.usage;
              if (!roundText && chunk.done.text) roundText = chunk.done.text;
            }
          }
          break;
        } catch (e) {
          // The API refused the prompt as too long (nothing streamed yet): compact hard once, retry.
          if (attempt === 0 && isTooLong(e)) {
            await compactNow(round, true);
            yield* drain();
            continue;
          }
          throw e;
        }
      }
      // What the context actually cost this round: kept with the turn's events, not shown in the chat.
      if (usage?.input_tokens) {
        scale = Math.min(3, Math.max(0.5, usage.input_tokens / Math.max(1, fixedEstimate + sentTokens)));
        overhead = Math.round(fixedEstimate * scale);
        em.emit('model.completed', 'understanding', '', { data: { round, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens ?? 0, pctOfWindow: Math.round((usage.input_tokens / window) * 1000) / 10, cutoff } });
      }
      if (roundText.trim()) textSegments.push(roundText.trim());
      conversation.push({ role: 'assistant', content });

      if (!toolUses.length || stopReason !== 'tool_use') {
        // The agent thinks it is done. If this turn changed the campaign and
        // hard problems remain, send it back to fix them (at most twice).
        if (!wrapUp && !asked.length && repairRounds < MAX_REPAIR_ROUNDS && state.campaign !== startCampaign) {
          const problems = checkJourneys(state.campaign, bankLinks, delivery.smsFallback, false, startCampaign);
          if (problems.length) {
            repairRounds++;
            em.emit('model.tool_call.completed', 'understanding', `Sent back to fix ${problems.length} problem${problems.length === 1 ? '' : 's'}`, {
              status: 'ok',
              correlationId: `repair-${repairRounds}`,
              detail: problems.join(' | ').slice(0, 300),
              data: { tool: 'repair', input: problems, round },
            });
            yield* drain();
            conversation.push({ role: 'user', content: `AUTOMATIC FIX (end of turn): these problems remain in the campaign:\n${problems.map((p) => `- ${p}`).join('\n')}\nFix each one with the least change that works (an undecided ending is yours to design, not to paper over), rebuild, and add what you fixed or decided to your reply.` });
            continue;
          }
        }
        // Split ideas the agent left: one helper each, in parallel, tests and splits (or not).
        // Then the main agent reviews what they did (closing pass).
        if (!wrapUp && !asked.length && !splitsRan && built) {
          const ideas = pendingSplitIdeas(state);
          if (ideas.length) {
            splitsRan = true;
            em.emit('model.tool_call.started', 'understanding', `Testing ${ideas.length} split idea${ideas.length === 1 ? '' : 's'}`, { status: 'running', correlationId: 'splits', data: { tool: 'split_helpers', input: ideas.map((i) => `${i.bucketName}: ${i.hypothesis}`), round } });
            yield* drain();
            const snapshot = state;
            const outcomes = await Promise.all(ideas.map((ref) => runSplitHelper(snapshot, env, ref).catch((e) => ({ ref, status: 'failed' as const, result: `The helper failed: ${(e as Error).message}`, queries: [] }))));
            const before = state;
            state = applySplitOutcomes(state, outcomes);
            persistIfChanged(before, state, req.sessionId, tenant.tenantId);
            em.emit('model.tool_call.completed', 'understanding', `Split ideas: ${outcomes.filter((o) => o.status === 'split').length} split, ${outcomes.filter((o) => o.status !== 'split').length} not`, {
              status: 'ok',
              correlationId: 'splits',
              detail: outcomes.map((o) => `${o.ref.bucketName}: ${o.status}`).join(' · '),
              data: { tool: 'split_helpers', input: ideas, result: outcomes.map((o) => ({ bucket: o.ref.bucketName, hypothesis: o.ref.hypothesis, status: o.status, result: o.result, queries: o.queries })), round },
            });
            em.emit('state.updated', 'generating', '', { data: { campaign: state.campaign, context: state.context, flags: state.flags, graph: null } });
            yield* drain();
            conversation.push({ role: 'user', content: closingMessage(outcomes) });
            continue;
          }
        }
        // The campaign changed and was rebuilt, but the brief still describes the old one.
        if (!wrapUp && !asked.length && !briefAsked && built && state.campaign !== startCampaign) {
          const brief = currentEntries(state.context.entries, { kind: 'note', topic: 'campaign brief' })[0];
          if (!brief || brief.at < turnStart) {
            briefAsked = true;
            em.emit('model.tool_call.completed', 'understanding', 'Sent back to write the campaign brief', { status: 'ok', correlationId: 'brief', data: { tool: 'repair', input: ['campaign brief'], round } });
            yield* drain();
            conversation.push({ role: 'user', content: 'AUTOMATIC CHECK (end of turn): the campaign changed but the campaign brief was not rewritten. Write it now with add_context (kind "note", topic "campaign brief") so it describes the campaign as it is now, then finish. Change nothing else.' });
            continue;
          }
        }
        break;
      }

      const results: unknown[] = [];
      let endsTurn = false;
      for (const tu of toolUses) {
        const t0 = Date.now();
        const key = callKey(tu.name, tu.input);
        const times = key ? (callCounts.get(key) ?? 0) + 1 : 0;
        if (key) callCounts.set(key, times);
        if (key && (times >= 3 || key === 'build_campaign:unchanged')) {
          loopRefusals++;
          const said = key === 'build_campaign:unchanged' ? 'Not rebuilt: nothing changed since the last build. Use its result above.' : `Not run: this exact call (${tu.name}, same input) already ran twice this turn. Use the result above, or do something different.`;
          em.emit('model.tool_call.failed', 'understanding', 'Skipped a repeated step', { status: 'failed', correlationId: tu.id, detail: said, data: { tool: tu.name, input: tu.input, round } });
          yield* drain();
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: said, is_error: true });
          if (loopRefusals >= 3) loopStopped = true;
          continue;
        }
        // ask_data runs its own analyst model, so it is the one async tool.
        const out = tu.name === 'ask_data' ? await runAskData(tu.input ?? {}, state, env) : runToolCall(tu.name, tu.input ?? {}, state, env);
        const planChanged = out.state.campaign !== state.campaign || out.state.context !== state.context || out.state.flags !== state.flags;
        persistIfChanged(state, out.state, req.sessionId, tenant.tenantId);
        state = out.state;
        if (out.asked) asked.push(...out.asked);
        if (out.build) {
          built = out.build;
          lastBuildOf = { campaign: out.state.campaign, context: out.state.context };
        }
        if (out.endsTurn) endsTurn = true;
        const titles = TOOL_TITLES[tu.name];
        em.emit(out.ok ? 'model.tool_call.completed' : 'model.tool_call.failed', 'understanding', out.doneTitle ?? titles?.done ?? tu.name, {
          status: out.ok ? 'ok' : 'failed',
          correlationId: tu.id,
          detail: out.summary,
          durationMs: Date.now() - t0,
          data: { tool: tu.name, input: tu.input, result: out.result, round },
        });
        // The canvas fills in live: a snapshot of the plan file after each change.
        if (planChanged) em.emit('state.updated', 'generating', '', { data: { campaign: state.campaign, context: state.context, flags: state.flags, graph: out.build?.graph ?? null } });
        yield* drain();
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: out.forModel, ...(out.ok ? {} : { is_error: true }) });
      }
      conversation.push({ role: 'user', content: results });

      // Questions asked or sign-off requested: the manager has to act next.
      // The agent gets one more round, tools still on, to file anything it
      // has not filed yet and write the sentence that goes with it; then the
      // turn ends whatever it does.
      if (wrapUp || loopStopped) break;
      if (endsTurn) wrapUp = true;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    yield* drain();
    return base({
      reply: textSegments.join('\n\n') || 'Something went wrong talking to the model. Nothing you said was lost; send your message again.',
      error: 'model-error',
      errorDetail: msg,
      state,
      questionItems: asked,
      graph: built?.graph ?? null,
      campaign: built?.campaign ?? null,
      buildNotes: built?.notes ?? [],
      warehouseAccess: !!warehouseBank,
    });
  }

  // Anything still broken after the repair rounds is said plainly, never hidden.
  const remaining = state.campaign !== startCampaign ? checkJourneys(state.campaign, bankLinks, delivery.smsFallback, false, startCampaign) : [];
  if (remaining.length) textSegments.push(`Still to fix (I could not resolve ${remaining.length === 1 ? 'this' : 'these'} on my own):\n${remaining.map((p) => `- ${p}`).join('\n')}`);
  // A turn that stops (e.g. at its step limit) with changes not yet built says so plainly: the canvas and
  // anything that reads the build would otherwise show an older or half-finished campaign as if it were done.
  if (state.campaign.buckets.length && !state.flags.campaignBuilt && !asked.length) {
    const empty = state.campaign.buckets.filter((b) => !b.journey?.length).map((b) => `"${b.name}"`);
    textSegments.push(
      `I stopped before finishing: my latest changes are not built yet${empty.length ? `, and ${empty.join(', ')} ${empty.length === 1 ? 'has' : 'have'} no journey yet` : ''}. Say "continue" and I'll finish and build.`,
    );
  }
  yield* drain();
  const version = await versionThisTurn(req.sessionId, startCampaign, state.campaign, latestUser, req.repair ? 'repair' : 'chat', costSnapshot(state.campaign, state.context, tenant), (c) => costSnapshot(c, state.context, tenant));
  return base({
    ...(version ? { version } : {}),
    reply: textSegments.join('\n\n'),
    state,
    questionItems: asked,
    graph: built?.graph ?? null,
    campaign: built?.campaign ?? null,
    buildNotes: built?.notes ?? [],
    warehouseAccess: !!warehouseBank,
  });
}
