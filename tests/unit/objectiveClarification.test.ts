// Clarifying an objective does not destroy the discovery behind it.
//
// THE DEFECT, measured live. `objectiveChangedMaterially` is a bag-of-words
// overlap test, and the orchestrator treated a positive result as licence to
// rebuild the brief from the user's latest sentence. Asking "What conversion
// rate should we expect?" scored 0.067 against a 0.5 threshold, so a brief
// holding the user's own confirmed entry-trigger decision was replaced by the
// question text: facts 1 -> 0, objective overwritten.
//
// WHY THE FIX IS STRUCTURAL rather than a better threshold. Measured on a
// domain-mixed corpus (targets, channel changes, geography, constraints,
// freezes, plus three genuinely different campaigns):
//
//   clarifications / constraints : 0.000 - 0.067
//   genuinely different objective: 0.000 - 0.125
//
// The ranges overlap, a real change scores HIGHER than the worst
// clarification, and six clarifications score exactly 0.000 alongside two real
// changes. No threshold separates them. Nor does a question mark: "Our target
// is a 5% uplift." has none and is still a refinement. So the predicate keeps
// its safety role — withdrawing an approval, which is reversible — and loses
// its licence to delete, which was not.
//
// Nothing here is domain-specific: no term list, no campaign vocabulary, no
// threshold change. The tests use several unrelated objectives on purpose.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { orchestrateStream } from '../../server/orchestrator';
import { seedKnowledgeBase } from '../../server/knowledge';
import { newBrief, recordDimensions, fingerprint, objectiveChangedMaterially, type WorkingBrief } from '../../server/discovery';
import type { SessionState } from '../../server/campaignState';

const OBJECTIVE = 'I want to increase OS-to-EMI conversions. Design a drip campaign for this.';
const PRIOR_FACT = 'The goal event is EMI_STATUS_CHANGED, New Status = Successful, Source = OS-to-EMI.';
const LIMITATION = 'No outstanding-balance attribute exists, so amount targeting is not expressible.';

/** A brief mid-conversation, with every question already answered. */
function established(objective = OBJECTIVE): WorkingBrief {
  return recordDimensions(
    {
      ...newBrief(objective),
      rounds: 2,
      questions: [{ id: 'q1-0', text: 'Entry on a pending request?', askedInRound: 1, answeredInRound: 1 }],
      answers: [{ round: 1, text: 'Yes, target the pending requests.' }],
      facts: [{ statement: PRIOR_FACT, source: 'retrieved-context', round: 1, confidence: 'confirmed' }],
      limitations: [LIMITATION],
    },
    [
      { name: 'Audience and eligibility', rationale: 'Who should enter.', status: 'retained', basis: 'user' },
      { name: 'Outstanding statement amount', rationale: 'Amount may change the offer.', status: 'unavailable', basis: 'tool' },
    ],
  );
}

const CONFIRMED: SessionState = {
  state: 'AWAITING_STRATEGY_CONFIRMATION',
  strategyVersion: 2,
  confirmation: { objectiveFingerprint: fingerprint(OBJECTIVE), strategyVersion: 2, confirmedAt: '2026-10-14T00:00:00.000Z' },
};

/** A thinking-only turn: the model's answer is irrelevant to these tests, and
 *  failing early keeps them deterministic and free of a live call. */
function mockEmptyTurn() {
  const ev = [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'r' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  ];
  const body = ev.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  vi.stubGlobal('fetch', async () =>
    new Response(new TextEncoder().encode(body), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
}

const knowledge = seedKnowledgeBase();

/** One real orchestrator turn: the user says `text` with nothing outstanding. */
async function turn(text: string, brief = established(), session = CONFIRMED) {
  mockEmptyTurn();
  const gen = orchestrateStream({
    sessionId: 'clarify',
    tenantId: 'TEN-IBL',
    knowledge,
    discoveryRounds: 2,
    messages: [
      { role: 'user', content: brief.objective },
      { role: 'assistant', content: 'Entry on a pending request?' },
      { role: 'user', content: 'Yes, target the pending requests.' },
      { role: 'assistant', content: 'Understood.' },
      { role: 'user', content: text },
    ],
    brief,
    session,
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

describe('a clarification keeps the brief intact', () => {
  it('asking for a conversion-rate target does not erase anything', async () => {
    // The exact message that wiped a real brief.
    const res = await turn(
      'What conversion rate should we expect from this campaign, and how many of our eligible customers will convert? I need numbers for the business case.',
    );
    expect(res.brief!.objective).toBe(OBJECTIVE);
    expect(res.brief!.facts.map((f) => f.statement)).toContain(PRIOR_FACT);
    expect(res.brief!.limitations).toContain(LIMITATION);
    expect(res.brief!.dimensions).toHaveLength(2);
    expect(res.brief!.answers).toHaveLength(1);
    expect(res.brief!.rounds).toBe(2);
  });

  it('stating a success criterion does not reset the objective', async () => {
    // Has no question mark, so no punctuation heuristic would have saved it.
    const res = await turn('Our target is a 5% uplift, measured over 30 days.');
    expect(res.brief!.objective).toBe(OBJECTIVE);
    expect(res.brief!.facts.map((f) => f.statement)).toContain(PRIOR_FACT);
    expect(res.brief!.dimensions).toHaveLength(2);
  });

  it('adding a constraint does not reset the objective', async () => {
    for (const text of ['Keep it to two messages.', 'Only target customers in Mumbai.', 'Avoid the festive freeze.']) {
      const res = await turn(text);
      expect(res.brief!.objective, text).toBe(OBJECTIVE);
      expect(res.brief!.facts.map((f) => f.statement), text).toContain(PRIOR_FACT);
      expect(res.brief!.dimensions, text).toHaveLength(2);
    }
  });

  it('works the same for an unrelated objective, so nothing is tuned to one campaign', async () => {
    const other = 'Get new cardholders to activate their card in the first two weeks.';
    const res = await turn('Keep it to two messages.', established(other));
    expect(res.brief!.objective).toBe(other);
    expect(res.brief!.facts.map((f) => f.statement)).toContain(PRIOR_FACT);
    expect(res.brief!.dimensions).toHaveLength(2);
  });
});

describe('a genuinely different objective still triggers the reset that matters', () => {
  const DIFFERENT = 'New cardholders are not completing activation. Get them activated in their first two weeks.';

  it('is still detected as materially different', () => {
    expect(objectiveChangedMaterially(OBJECTIVE, DIFFERENT)).toBe(true);
  });

  it('withdraws the confirmation and restarts discovery', async () => {
    const res = await turn(DIFFERENT);
    // THE RESET THAT MATTERS: the old approval authorises nothing.
    expect(res.session!.confirmation).toBeNull();
    expect(res.session!.state).toBe('UNDERSTANDING_GOAL');
    expect(res.session!.strategyVersion).toBe(3);
  });

  it('keeps what was learned rather than deleting it', async () => {
    // Deliberate change of behaviour: withdrawing an approval is reversible,
    // deleting confirmed discovery is not, and the test above proves the
    // safety property is intact without the deletion.
    const res = await turn(DIFFERENT);
    expect(res.brief!.facts.map((f) => f.statement)).toContain(PRIOR_FACT);
    expect(res.brief!.dimensions).toHaveLength(2);
  });
});

describe('confirmation and strategy-version protections are untouched', () => {
  it('a clarification leaves the confirmation withdrawn, so nothing stale can be built', async () => {
    const res = await turn('Our target is a 5% uplift, measured over 30 days.');
    // Conservative direction: the user re-confirms. Nothing is generated here.
    expect(res.session!.confirmation).toBeNull();
    expect(res.campaign).toBeNull();
    expect(res.graph).toBeNull();
  });

  it('an answer to an outstanding question is still recorded as an answer, not an objective change', async () => {
    const pending = established();
    pending.questions = [{ id: 'q2-0', text: 'Which channel first?', askedInRound: 2 }];
    const res = await turn('Email first, then SMS.', pending);
    expect(res.brief!.objective).toBe(OBJECTIVE);
    expect(res.brief!.answers.map((a) => a.text)).toContain('Email first, then SMS.');
    // Answering is not a change, so the approval survives.
    expect(res.session!.confirmation).not.toBeNull();
  });
});
