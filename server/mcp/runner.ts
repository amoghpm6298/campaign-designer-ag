// Runs one agent turn with no browser, for the MCP. It writes exactly what the
// app writes (chat.json in the app's own shape), so the canvas link shows the
// same conversation and campaign a person in the app would have seen.
//
// A turn takes minutes, so it runs in the background; callers poll status.
import { agentStream } from '../agent/loop';
import type { AgentQuestion, AgentRequest, AgentResponse, AgentState } from '../agent/types';
import { emptyCampaign, emptyContext } from '../agent/state';
import { loadChat, loadStores, loadSubmission, saveChat, LOCKED } from '../campaignFiles';
import { mergeEvent } from '../../src/designer/v2/logic';
import { diffChangedSteps } from '../../src/designer/v2/canvasModel';
import type { AnswerItem, V2Event, V2Turn } from '../../src/designer/v2/types';

/** The app's chat.json, as DesignerV2 saves it. */
export interface StoredChat {
  sessionId: string;
  tenantId: string;
  turns: V2Turn[];
  state: AgentState | null;
  changed?: string[];
  changeFocus?: unknown;
  repairKey?: string;
  lastBuilt?: boolean;
  /** Set by start_campaign: "assume" skips any questions the agent asks, so it assumes and builds. */
  questionMode?: 'ask' | 'assume';
}

type Stream = (req: AgentRequest) => AsyncGenerator<unknown, AgentResponse>;
let stream: Stream = agentStream as unknown as Stream;
/** Tests swap in a fake agent. */
export const setStreamForTests = (s: Stream | null) => {
  stream = s ?? (agentStream as unknown as Stream);
};

/** Campaigns with a turn in progress, and what the agent is doing right now. */
const running = new Map<string, { startedAt: string; step: string; done: Promise<void> }>();
export const isRunning = (sessionId: string) => running.has(sessionId);
export const runningStep = (sessionId: string) => running.get(sessionId)?.step ?? null;
/** Resolves when the current turn ends, or after `ms`, whichever is first. */
export const waitForTurn = async (sessionId: string, ms: number) => {
  const r = running.get(sessionId);
  if (r) await Promise.race([r.done, new Promise((res) => setTimeout(res, ms))]);
};

/** The browser keeps the conversation only; the campaign object and context live in their own files. */
const withoutCampaign = (s: AgentState | null): AgentState | null => (s ? { ...s, campaign: emptyCampaign(), context: emptyContext() } : null);

export interface UserTurn {
  content: string;
  answerSet?: AnswerItem[];
}

/**
 * Starts one turn in the background and returns at once. Refuses a locked
 * campaign or one already working.
 */
export function startTurn(sessionId: string, tenantId: string, user: UserTurn, opts: { answers?: Record<string, string>; skipped?: string[]; questionMode?: 'ask' | 'assume' } = {}): { ok: true } | { ok: false; error: string } {
  if (loadSubmission(sessionId)) return { ok: false, error: LOCKED };
  if (running.has(sessionId)) return { ok: false, error: 'The agent is still working on this campaign. Check back with get_campaign.' };
  const loaded = loadChat(sessionId) as StoredChat | null;
  const chat: StoredChat = loaded ?? { sessionId, tenantId, turns: [], state: null, ...(opts.questionMode ? { questionMode: opts.questionMode } : {}) };
  if (chat.tenantId && chat.tenantId !== tenantId) return { ok: false, error: 'This campaign belongs to another bank.' };

  const entry = { startedAt: new Date().toISOString(), step: 'Thinking…', done: Promise.resolve() };
  const onStep = (step: string) => {
    entry.step = step;
  };
  entry.done = (async () => {
    let asked = await runTurn(chat, sessionId, tenantId, user, opts, onStep);
    // "assume": whatever the agent asks is skipped for the caller, exactly as the app's Skip does,
    // so it makes its own calls, says what it assumed, and goes on. At most twice per request.
    for (let i = 0; i < 2 && chat.questionMode === 'assume' && asked.length; i++) {
      const now = (loadChat(sessionId) as StoredChat | null) ?? chat;
      onStep('Assuming the answers…');
      asked = await runTurn(
        now,
        sessionId,
        tenantId,
        { content: 'Skipped these questions.', answerSet: asked.map((q) => ({ aspect: q.aspect, question: q.text.replace(/\*\*/g, ''), ...(q.why ? { why: q.why } : {}), skipped: true })) },
        { skipped: asked.map((q) => q.id) },
        onStep,
      );
    }
  })().finally(() => running.delete(sessionId));
  running.set(sessionId, entry);
  return { ok: true };
}

/** One agent turn, saved as the app saves it. Returns the questions it asked, if any. */
async function runTurn(chat: StoredChat, sessionId: string, tenantId: string, user: UserTurn, opts: { answers?: Record<string, string>; skipped?: string[] }, onStep: (s: string) => void): Promise<AgentQuestion[]> {
  const before = loadStores(sessionId).campaign;
  const turns: V2Turn[] = [...chat.turns, { role: 'user', content: user.content, ...(user.answerSet ? { answerSet: user.answerSet } : {}) }];
  // Saved straight away, so the link shows the request while the agent works.
  saveChat(sessionId, tenantId, { ...chat, sessionId, tenantId, turns });
  let events: V2Event[] = [];
  try {
    const gen = stream({
      sessionId,
      tenantId,
      messages: turns.filter((t) => !t.error).map((t) => ({ role: t.role, content: t.content })),
      state: chat.state,
      answers: opts.answers,
      skipped: opts.skipped,
      focus: null,
      repair: false,
    });
    let r: AgentResponse;
    while (true) {
      const next = await gen.next();
      if (next.done) {
        r = next.value;
        break;
      }
      const e = next.value as V2Event;
      if (e.type === 'state.updated') continue;
      // What it is doing right now: a tool while one runs, otherwise thinking or writing.
      if (e.type === 'model.tool_call.started' && e.title) onStep(e.title);
      else if (e.type === 'model.tool_call.completed' || e.type === 'model.tool_call.failed') onStep('Thinking…');
      else if (e.type === 'model.text.delta') onStep('Writing its reply…');
      events = mergeEvent(events, e);
    }
    const after = r.state.campaign;
    saveChat(sessionId, tenantId, {
      ...chat,
      sessionId,
      tenantId,
      turns: [...turns, { role: 'assistant', content: r.reply || (r.error ? '' : '…'), questions: r.questionItems as AgentQuestion[] as never, events, ...(r.error ? { error: r.errorDetail ?? r.error } : {}) }],
      state: withoutCampaign(r.state),
      changed: [...diffChangedSteps(before as never, after as never)],
      changeFocus: null,
      lastBuilt: !!r.graph,
    });
    return (r.questionItems ?? []) as AgentQuestion[];
  } catch (e) {
    saveChat(sessionId, tenantId, { ...chat, sessionId, tenantId, turns: [...turns, { role: 'assistant', content: '', events, error: (e as Error).message }] });
    return [];
  }
}
