// The agent loop. One prompt, every tool on every round, the agent decides.
// The application only keeps the record (plan file, flags, timeline) and
// reports what happened; it never switches the prompt or hides a tool.

import { streamClaude, type ApiMessage, type ToolUseBlock } from '../anthropic';
import { EventEmitterSeq, type RunEvent } from '../runEvents';
import { resolveTenant } from '../tenants';
import { bankContext, knowledgeForPrompt, seedKnowledgeBase, type KnowledgeBase } from '../knowledge';
import { issuerContext } from '../blueprint';
import type { Channel } from '../../src/data/sharedConstants';
import { systemPrompt, statusBlock } from './prompt';
import { TOOL_TITLES, runToolCall, toolsFor, type ToolEnv } from './tools';
import { emptyCampaign, emptyContext, normaliseState, recordAnswers, recordSkips } from './state';
import { loadStores, saveCampaignObject, saveContext } from '../campaignFiles';
import { focusSection } from './focus';
import { ensureBaseline, recordVersion, setSummary, summariseVersion, type VersionEntry } from '../campaignVersions';
import { warehouseAvailable } from '../warehouse';
import type { AgentQuestion, AgentRequest, AgentResponse, AgentState } from './types';

const MAX_ROUNDS = 24;
const REACH_ORDER: Channel[] = ['WHATSAPP', 'SMS', 'EMAIL', 'RCS'] as Channel[];

export function channelsFor(tenant: NonNullable<ReturnType<typeof resolveTenant>>): Channel[] {
  return tenant.availableChannels
    .filter((c) => c.available)
    .sort((a, b) => REACH_ORDER.indexOf(a.channel as Channel) - REACH_ORDER.indexOf(b.channel as Channel))
    .map((c) => c.channel as Channel);
}

/** If this turn changed the campaign, records it as a version with a short summary. */
async function versionThisTurn(sessionId: string, start: AgentState['campaign'], end: AgentState['campaign'], request: string): Promise<VersionEntry | null> {
  if (start === end) return null;
  try {
    ensureBaseline(sessionId, start);
    const v = recordVersion({ sessionId, campaign: end, source: 'chat', request });
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
    systemPrompt(!!warehouseBank),
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
        { type: 'text', text: [statusBlock(state), focusSection(state, req.focus)].filter(Boolean).join('\n\n') },
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
  };
  const tools = toolsFor(!!warehouseBank).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));

  const textSegments: string[] = [];
  const asked: AgentQuestion[] = [];
  let built: { graph: unknown; campaign: unknown; notes: string[] } | null = null;
  let wrapUp = false;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const textId = `text-${round}`;
      let roundText = '';
      const toolUses: ToolUseBlock[] = [];
      let content: unknown[] = [];
      let stopReason: string | undefined;

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
          if (!roundText && chunk.done.text) roundText = chunk.done.text;
        }
      }
      if (roundText.trim()) textSegments.push(roundText.trim());
      conversation.push({ role: 'assistant', content });

      if (!toolUses.length || stopReason !== 'tool_use') break;

      const results: unknown[] = [];
      let endsTurn = false;
      for (const tu of toolUses) {
        const t0 = Date.now();
        const out = runToolCall(tu.name, tu.input ?? {}, state, env);
        const planChanged = out.state.campaign !== state.campaign || out.state.context !== state.context || out.state.flags !== state.flags;
        persistIfChanged(state, out.state, req.sessionId, tenant.tenantId);
        state = out.state;
        if (out.asked) asked.push(...out.asked);
        if (out.build) built = out.build;
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
      if (wrapUp) break;
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

  yield* drain();
  const version = await versionThisTurn(req.sessionId, startCampaign, state.campaign, latestUser);
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
