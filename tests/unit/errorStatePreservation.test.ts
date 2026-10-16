// Step 1: a failed turn is a no-op, not a reset.
//
// THE DEFECT, measured in a real OS-to-EMI conversation: the model ended a
// turn with a thinking block and no text. The orchestrator correctly reported
// "no text at all ... You can retry", then returned `base` — which carries
// brief:null and session:null. Every established fact, every question and
// answer, and the state machine itself were discarded by the act of failing.
// The offered retry had nothing left to resume from: the brief that had just
// recorded the user's APPROVED-vs-SETTLED decision came back empty, and the
// confirmation recorded in the session was gone.
//
// Deterministic. The API is faked, because a thinking-only turn cannot be
// requested on demand and a live call could not reproduce it reliably — the
// same input failed twice and succeeded once.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { orchestrateStream } from '../../server/orchestrator';
import { seedKnowledgeBase } from '../../server/knowledge';
import { newBrief, type WorkingBrief } from '../../server/discovery';
import type { SessionState } from '../../server/campaignState';

const OBJECTIVE = 'I want to increase OS-to-EMI conversions. Design a drip campaign for this.';
/** Established in an earlier round. Losing this is the regression. */
const PRIOR_FACT = 'The goal event is EMI_STATUS_CHANGED, New Status = Successful, Source = OS-to-EMI.';
const LIMITATION = 'No outstanding-balance attribute exists, so amount targeting is not expressible.';
/** The real answer whose loss made this defect visible. */
const ANSWER = 'Fire on APPROVED, right after authorization, while the purchase is still fresh.';

/**
 * A brief as it genuinely stands mid-conversation: one fact already settled,
 * one question outstanding. The outstanding question matters — it is what
 * makes the newest message an ANSWER rather than a new objective, per the
 * ordering documented at orchestrator.ts:318-325. A fixture without it trips
 * the objective-change path instead and never reaches an error return.
 */
function briefWithProgress(): WorkingBrief {
  return {
    ...newBrief(OBJECTIVE),
    rounds: 1,
    questions: [{ id: 'q1-0', text: 'Entry on SETTLED only, or also APPROVED?', askedInRound: 1 }],
    facts: [{ statement: PRIOR_FACT, source: 'retrieved', round: 1, confidence: 'confirmed' }],
    limitations: [LIMITATION],
  };
}

const SESSION: SessionState = {
  state: 'AWAITING_STRATEGY_CONFIRMATION',
  strategyVersion: 2,
  confirmation: { objectiveFingerprint: 'fp', strategyVersion: 2, confirmedAt: '2026-10-14T00:00:00.000Z' },
};

/** Replays an SSE body. */
function mockStream(events: Record<string, unknown>[]) {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  vi.stubGlobal('fetch', async () =>
    new Response(new TextEncoder().encode(body), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
}

/** The exact failure observed live: the turn ends having produced only thinking. */
function mockThinkingOnlyTurn() {
  mockStream([
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reasoned but said nothing' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } },
  ]);
}

const knowledge = seedKnowledgeBase();

async function run(over: Record<string, unknown> = {}) {
  const gen = orchestrateStream({
    sessionId: 'err-state',
    tenantId: 'TEN-IBL',
    knowledge,
    discoveryRounds: 1,
    messages: [
      { role: 'user', content: OBJECTIVE },
      { role: 'assistant', content: 'Entry on SETTLED only, or also APPROVED?' },
      { role: 'user', content: ANSWER },
    ],
    brief: briefWithProgress(),
    session: SESSION,
    ...over,
  } as never);
  let out = await gen.next();
  while (!out.done) out = await gen.next();
  return out.value;
}

const OLD_KEY = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.ANTHROPIC_API_KEY = OLD_KEY ?? 'test-key-not-real';
});

describe('an empty model turn does not destroy discovery', () => {
  it('reports the failure AND returns the brief and session intact', async () => {
    mockThinkingOnlyTurn();
    const res = await run();

    // It still fails loudly — this fix must not paper over the error.
    expect(res.phase).toBe('error');
    expect(res.stage).toBe('error');
    expect(res.reply).toMatch(/no text at all/i);
    expect(res.reply).toMatch(/You can retry/);

    // ...and the retry has something to resume from. THIS is the regression.
    expect(res.brief).not.toBeNull();
    expect(res.session).not.toBeNull();
    // The fact settled in an earlier round survives.
    expect(res.brief!.facts.map((f) => f.statement)).toContain(PRIOR_FACT);
    // So does the answer this very turn supplied, before the model failed.
    expect(res.brief!.facts.map((f) => f.statement)).toContain(ANSWER);
    expect(res.brief!.answers.map((a) => a.text)).toContain(ANSWER);
    expect(res.brief!.questions[0].answeredInRound).toBe(1);
    expect(res.brief!.limitations).toContain(LIMITATION);
    // The objective is NOT rewritten into the user's latest sentence.
    expect(res.brief!.objective).toBe(OBJECTIVE);
  });

  it('preserves the session state machine and its confirmation', async () => {
    mockThinkingOnlyTurn();
    const res = await run();
    expect(res.session!.state).toBe('AWAITING_STRATEGY_CONFIRMATION');
    expect(res.session!.strategyVersion).toBe(2);
    // Losing this silently de-authorised an approval the user had given.
    expect(res.session!.confirmation).not.toBeNull();
    expect(res.session!.confirmation!.strategyVersion).toBe(2);
  });

  it('resumes from the preserved state: the retry SENDS the kept facts to the model', async () => {
    mockThinkingOnlyTurn();
    const failed = await run();
    expect(failed.phase).toBe('error');

    // Round-trip exactly what the client now holds, as a retry would. The
    // request body is captured so the claim being tested is the one that
    // matters: the preserved discovery actually reaches the next call,
    // rather than merely existing in a field nobody reads.
    let sentBody = '';
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      sentBody = init.body;
      return new Response(new TextEncoder().encode(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    await run({
      brief: failed.brief,
      session: failed.session,
      messages: [{ role: 'user', content: OBJECTIVE }],
    });

    expect(sentBody).toContain(PRIOR_FACT);
    expect(sentBody).toContain(ANSWER);
    expect(sentBody).toContain(LIMITATION);
  });
});

describe('every other failure path preserves state too', () => {
  it('a transport failure keeps the brief', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('socket hang up');
    });
    const res = await run();
    expect(res.phase).toBe('error');
    expect(res.reply).toMatch(/socket hang up/);
    expect(res.brief!.facts.map((f) => f.statement)).toContain(PRIOR_FACT);
    expect(res.session!.confirmation).not.toBeNull();
  });

  it('an unknown tenant keeps the brief', async () => {
    const res = await run({ tenantId: 'TEN-NOPE' });
    expect(res.phase).toBe('error');
    expect(res.reply).toMatch(/Unknown tenant/);
    expect(res.brief!.facts.map((f) => f.statement)).toContain(PRIOR_FACT);
    expect(res.session!.strategyVersion).toBe(2);
  });

  it('a configuration error keeps the brief', async () => {
    process.env.ANTHROPIC_API_KEY = '';
    const res = await run();
    expect(res.phase).toBe('error');
    expect(res.brief).not.toBeNull();
    expect(res.brief!.facts.map((f) => f.statement)).toContain(PRIOR_FACT);
    expect(res.session).not.toBeNull();
  });
});
