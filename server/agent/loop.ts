// The v2 agent loop. One prompt, every tool on every round, the agent decides.
// The application only keeps the record (plan file, flags, timeline) and
// reports what happened; it never switches the prompt or hides a tool.

import { streamClaude, type ApiMessage, type ToolUseBlock } from '../anthropic';
import { EventEmitterSeq, type RunEvent } from '../runEvents';
import { resolveTenant } from '../tenants';
import { bankContext, knowledgeForPrompt, seedKnowledgeBase, type KnowledgeBase } from '../knowledge';
import { issuerContext } from '../blueprint';
import type { Channel } from '../../src/data/sharedConstants';
import { V2_SYSTEM, statusBlock } from './prompt';
import { V2_TOOLS, V2_TOOL_TITLES, runV2Tool, type ToolEnv } from './tools';
import { normaliseState, recordAnswers, requestChanges, signOff } from './state';
import type { AgentQuestion, AgentRequest, AgentResponse, AgentState } from './types';

const MAX_ROUNDS = 10;
const REACH_ORDER: Channel[] = ['WHATSAPP', 'SMS', 'EMAIL', 'RCS'] as Channel[];

function channelsFor(tenant: NonNullable<ReturnType<typeof resolveTenant>>): Channel[] {
  return tenant.availableChannels
    .filter((c) => c.available)
    .sort((a, b) => REACH_ORDER.indexOf(a.channel as Channel) - REACH_ORDER.indexOf(b.channel as Channel))
    .map((c) => c.channel as Channel);
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

export async function* agentStream(req: AgentRequest): AsyncGenerator<RunEvent, AgentResponse> {
  const runId = `v2-${Date.now().toString(36)}`;
  const pending: RunEvent[] = [];
  const all: RunEvent[] = [];
  const em = new EventEmitterSeq(runId, (e) => {
    pending.push(e);
    if (e.type !== 'model.text.delta') all.push(e);
  });
  const drain = function* () {
    while (pending.length) yield pending.shift()!;
  };

  let state: AgentState = normaliseState(req.state);
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
    ...extra,
  });

  const tenant = resolveTenant(req.tenantId);
  if (!tenant) return base({ reply: 'That tenant is not recognised. Pick one from the list and try again.', error: 'unknown-tenant' });

  // --- what the manager did since the last turn ----------------------------
  const action = req.action ?? null;
  if (action?.type === 'signoff') state = signOff(state, action.section, 'user', '');
  if (action?.type === 'request_changes') state = requestChanges(state, action.section, action.note ?? '');
  const latestUser = [...(req.messages ?? [])].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (!action || req.answers) state = recordAnswers(state, req.answers, action ? '' : latestUser);

  // --- context: fixed per tenant, so the system prompt stays cacheable --------
  const knowledge = (req.knowledge as KnowledgeBase | undefined) ?? (seedKnowledgeBase() as KnowledgeBase);
  const availableChannels = channelsFor(tenant);
  const system = [
    V2_SYSTEM,
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
        { type: 'text', text: statusBlock(state) },
      ],
    };
  }

  const env: ToolEnv = {
    tenant,
    availableChannels,
    goalStatement: req.messages.find((m) => m.role === 'user')?.content ?? '',
    sessionId: req.sessionId,
    lookupCache: new Map(),
  };
  const tools = V2_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));

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
          const t = V2_TOOL_TITLES[chunk.toolUse.name];
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
        const out = runV2Tool(tu.name, tu.input ?? {}, state, env);
        state = out.state;
        if (out.asked) asked.push(...out.asked);
        if (out.build) built = out.build;
        if (out.endsTurn) endsTurn = true;
        const titles = V2_TOOL_TITLES[tu.name];
        em.emit(out.ok ? 'model.tool_call.completed' : 'model.tool_call.failed', 'understanding', out.doneTitle ?? titles?.done ?? tu.name, {
          status: out.ok ? 'ok' : 'failed',
          correlationId: tu.id,
          detail: out.summary,
          durationMs: Date.now() - t0,
          data: { tool: tu.name, input: tu.input, result: out.result, round },
        });
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
    });
  }

  yield* drain();
  return base({
    reply: textSegments.join('\n\n'),
    state,
    questionItems: asked,
    graph: built?.graph ?? null,
    campaign: built?.campaign ?? null,
    buildNotes: built?.notes ?? [],
  });
}
