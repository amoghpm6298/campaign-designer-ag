// Which question did that reply actually answer?
//
// ROOT CAUSE, traced end to end on the OS-to-EMI run. `recordAnswer` did this:
//
//     questions: brief.questions.map((q) =>
//       q.answeredInRound === undefined ? { ...q, answeredInRound: round } : q)
//
// Every outstanding question was marked answered the moment ANY free-text
// reply arrived. The user had been asked three things; their reply covered two
// of them and never mentioned the third — "is the gap customers who never
// started a request, or ones already sitting Pending?", which decides the
// entry event and which they could have answered in three words.
//
// The brief then told the agent all three were answered. The agent could see
// the reply did not cover it, and reconciled the contradiction by inventing a
// history — "Asked twice (round 1 and implicitly in round 2); user repeated
// the general hunch both times without picking one" — and filing the dimension
// as a deferred ASSUMPTION. No part of that happened.
//
// `OpenQuestion.id` carried the comment "Stable id so an answer can be
// attributed to the question it answers". Nothing used it.
//
// WHAT IS AND IS NOT GUARANTEED HERE. Attribution is ASSERTED BY THE MODEL:
// the application cannot tell which question a free-text sentence addresses
// without semantic matching, which was investigated and rejected (overlap
// scores could not separate a clarification from a genuine change). What the
// application does guarantee is tested below — ids must be real, an unclaimed
// question stays visible, counts come from state and not from narrative, and a
// proposal cannot silently drop one.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  newBrief,
  recordQuestions,
  recordAnswer,
  recordAddressedQuestions,
  recordUncoveredQuestions,
  unaddressedQuestions,
  briefForPrompt,
  type WorkingBrief,
} from '../../server/discovery';

/** The Scenario A shape: three questions, one reply covering two of them. */
const scenarioA = (): WorkingBrief => {
  let b = recordQuestions(newBrief('Increase OS-to-EMI conversions'), [
    'How do you want success judged here?',
    'Is the gap customers who never started a request, or ones already Pending?',
    'What do you believe is the main reason customers do not convert?',
  ]);
  return recordAnswer(
    b,
    'No fixed target. Success is more EMI Requests reaching Successful. We think interest-cost hesitation is the barrier.',
  );
};

describe('one reply does not answer every outstanding question', () => {
  it('answering Q1 and Q3 leaves Q2 open', () => {
    let b = scenarioA();
    b = recordAddressedQuestions(b, ['q1-0', 'q1-2']);
    expect(unaddressedQuestions(b).map((q) => q.id)).toEqual(['q1-1']);
  });

  it('the unanswered question survives into the next model turn, with its id', () => {
    let b = recordAddressedQuestions(scenarioA(), ['q1-0', 'q1-2']);
    const out = briefForPrompt(b);
    expect(out).toContain('Asked, but the reply did NOT appear to answer these');
    expect(out).toContain('[q1-1] Is the gap customers who never started a request, or ones already Pending?');
    // ...and is not simultaneously claimed as answered.
    const answeredBlock = out.slice(out.indexOf('Already asked and ANSWERED'), out.indexOf('Asked, but the reply'));
    expect(answeredBlock).not.toContain('never started a request');
  });

  it('a reply nobody attributes leaves every question open', () => {
    // The pre-fix behaviour, now impossible: arrival of a reply is not
    // evidence that it answered anything.
    const b = scenarioA();
    expect(unaddressedQuestions(b)).toHaveLength(3);
    expect(briefForPrompt(b)).not.toContain('Already asked and ANSWERED');
  });

  it('a reply may genuinely answer several questions at once', () => {
    const b = recordAddressedQuestions(scenarioA(), ['q1-0', 'q1-1', 'q1-2']);
    expect(unaddressedQuestions(b)).toHaveLength(0);
    expect(briefForPrompt(b)).not.toContain('Asked, but the reply did NOT appear to answer these');
  });

  it('a later reply can answer an older question', () => {
    // Attribution is by id, never by recency: the user may circle back to
    // something asked two rounds ago while a newer question goes unaddressed.
    let b = recordAddressedQuestions(scenarioA(), ['q1-0']);
    b = recordQuestions(b, ['Which channel do you prefer?']);
    b = recordAnswer(b, 'Sorry — on the earlier one, it is customers already Pending.');
    b = recordAddressedQuestions(b, ['q1-1']);

    const open = unaddressedQuestions(b).map((q) => q.id);
    expect(open).toContain('q1-2'); // never answered
    expect(open).toContain('q2-0'); // the newer question, still open
    expect(open).not.toContain('q1-1'); // the old one, now resolved
  });

  it('an answered question is not asked again', () => {
    const b = recordAddressedQuestions(scenarioA(), ['q1-0']);
    const out = briefForPrompt(b);
    expect(out).toContain('Already asked and ANSWERED. Do not ask these again:');
    expect(out).toContain('How do you want success judged here?');
  });

  it('re-claiming an already-answered question does not move its round', () => {
    let b = recordAddressedQuestions(scenarioA(), ['q1-0']);
    const first = b.questions[0].addressedInRound;
    b = recordQuestions(b, ['Another question']);
    b = recordAddressedQuestions(b, ['q1-0']);
    expect(b.questions[0].addressedInRound).toBe(first);
  });
});

describe('the application does not accept attribution it cannot verify', () => {
  it('ignores an id that was never asked', () => {
    // The only deterministic check available on the claim itself. A model
    // naming a question that does not exist cannot close anything with it.
    const b = recordAddressedQuestions(scenarioA(), ['q9-9', 'not-a-question']);
    expect(unaddressedQuestions(b)).toHaveLength(3);
  });

  it('treats an empty or missing claim as claiming nothing', () => {
    const b = scenarioA();
    expect(unaddressedQuestions(recordAddressedQuestions(b, []))).toHaveLength(3);
    expect(unaddressedQuestions(recordAddressedQuestions(b, undefined as unknown as string[]))).toHaveLength(3);
  });

  it('counts come from recorded state, never from the model\'s narrative', () => {
    const b = recordAddressedQuestions(scenarioA(), ['q1-0', 'q1-2']);
    expect(briefForPrompt(b)).toContain(
      '3 question(s) asked across 1 round(s), 2 answered, 1 asked but not answered, 0 awaiting any reply',
    );
  });

  it('separates "asked and ignored" from "asked, no reply yet"', () => {
    // Three distinct states the old record collapsed into two. A question
    // awaiting any reply is not the same as one the user read and skipped.
    let b = recordAddressedQuestions(scenarioA(), ['q1-0', 'q1-2']);
    b = recordQuestions(b, ['A brand new question']);
    expect(briefForPrompt(b)).toContain(
      '4 question(s) asked across 2 round(s), 2 answered, 1 asked but not answered, 1 awaiting any reply',
    );
  });

  it('states both exits for an unanswered question, and forbids dropping it', () => {
    const out = briefForPrompt(recordAddressedQuestions(scenarioA(), ['q1-0']));
    expect(out).toMatch(/carry it \(it stays a live uncertainty the strategy works around\) or defer it \(a stated default applies\)/);
    expect(out).toMatch(/A reason attached to no question resolves no question/);
    expect(out).toMatch(/Silently dropping one is not an option/);
    expect(out).toMatch(/recording it as a settled finding when nobody answered it is worse/);
  });
});

describe('a proposal cannot quietly drop an unanswered question', () => {
  const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');

  it('refuses a strategy that says nothing about one', () => {
    expect(src).toMatch(/const pendingQuestions = unresolvedQuestions\(brief\)/);
    expect(src).toMatch(/const questionDropped =/);
    expect(src).toMatch(/if \(gate\.outcome === 'continue_discovery' \|\| beliefUntreated \|\| questionDropped \|\| forkUnanswered \|\| dimensionUnresolved\)/);
  });

  it('is satisfied only by a reason naming that specific question', () => {
    // Changed deliberately. It used to accept ANY assumption anywhere in the
    // strategy as discharging EVERY outstanding question — which is how the
    // biggest fork in the OS-to-EMI conversation got settled by inference.
    // Resolution is now per-question, by id (see unresolvedQuestions).
    expect(src).toMatch(/const questionDropped = !limitReached && pendingQuestions\.length > 0 && proposed !== null;/);
    const disc = readFileSync(new URL('../../server/discovery.ts', import.meta.url), 'utf8');
    expect(disc).toMatch(/!\(brief\.questionResolutions \?\? \[\]\)\.some\(\(r\) => r\.questionId === q\.id\)/);
  });

  it('only ever fires on a propose turn', () => {
    expect(src).toMatch(/pendingQuestions\.length > 0 && proposed !== null/);
  });

  it('quotes the question back to the user rather than citing an id', () => {
    expect(src).toMatch(/and your reply did not cover it/);
  });

  it('records the attribution before the gate reads the brief', () => {
    const record = src.indexOf('brief = recordAddressedQuestions(brief, parsed.value.answered)');
    expect(record).toBeGreaterThan(-1);
    expect(record).toBeLessThan(src.indexOf('const gate = evaluateDiscovery'));
  });
});

describe('the prompt asks for the claim, and the default favours the user', () => {
  // THE CONTRACT FLIPPED, 2026-10-16, and this block records why.
  //
  // It used to read "FIRST, SAY WHAT THEY ACTUALLY ANSWERED" and set
  // `addressedInRound` only from a positive `answered` array. That made a
  // field the model could simply forget into the difference between
  // "answered" and "not answered" — and a model that forgot it caused the
  // application to tell a campaign manager, who had just answered both
  // questions plainly, that their reply did not cover either, and then ask
  // again. Measured in a real session, twice.
  //
  // The default is now the other way: silence from the model means they
  // answered. Forks are the one exception, because a fork decides which
  // campaign gets built rather than how well, so it still needs a positive
  // claim. The asymmetry is the point, and `recordUncoveredQuestions` is
  // where it lives.
  const SYSTEM = (() => {
    const s = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    return /const SYSTEM = `([\s\S]*?)`;\n/.exec(s)![1];
  })();

  it('tells the model to read a reply as an answer first', () => {
    expect(SYSTEM).toMatch(/READ THEIR REPLY AS AN ANSWER FIRST/);
    expect(SYSTEM).toMatch(/Assume it answers every question you asked, because it usually does/);
  });

  it('names the cost of flagging an answer they did give', () => {
    // The cost that was actually paid, stated in the prompt in those terms.
    expect(SYSTEM).toMatch(/telling them a reply you did receive did not count is wrong and insulting/);
    expect(SYSTEM).toMatch(/Never flag one for being short or not in the words you expected/);
  });

  it('keeps forks as the explicit exception, with the reason', () => {
    expect(SYSTEM).toMatch(/FORKS ARE THE EXCEPTION/);
    expect(SYSTEM).toMatch(/a fork decides which campaign this is, so silence leaves it open/);
  });

  it('keeps a skipped question distinct from a refusal', () => {
    expect(SYSTEM).toMatch(/A skipped question is not a refusal/);
  });

  it('carries both fields in both payloads that can follow an answer', () => {
    // Both, not one: `answered` is how a fork gets discharged and
    // `notCovered` is how anything else gets held open. A payload shape
    // offering only one of them cannot express the contract above.
    expect(SYSTEM).toMatch(/"action":"ask"[\s\S]*?"answered":\[[\s\S]*?"notCovered":\[/);
    expect(SYSTEM).toMatch(/"action":"propose",\s*\n\s*"answered":\[[\s\S]*?\n\s*"notCovered":\[/);
  });
});

describe('silence from the model is read as an answer, except on a fork', () => {
  // The behaviour itself, not the prompt. These are the tests that would
  // have caught the original defect.
  const asked = () =>
    recordAnswer(
      recordQuestions(newBrief('o'), [
        { text: 'What does activation mean to you?', impact: 'shaping' },
        { text: 'Reach the never-started cohort, or the pending one?', impact: 'fork' },
      ]),
      'Activation means the PIN is set. We measure how many new cardholders activate.',
    );

  it('treats a plain question as answered when the model says nothing', () => {
    const b = recordUncoveredQuestions(asked(), undefined);
    expect(unaddressedQuestions(b).map((q) => q.id)).not.toContain('q1-0');
  });

  it('leaves a fork open when the model says nothing', () => {
    const b = recordUncoveredQuestions(asked(), undefined);
    expect(unaddressedQuestions(b).map((q) => q.id)).toEqual(['q1-1']);
  });

  it('discharges the fork only on a positive claim', () => {
    const b = recordUncoveredQuestions(recordAddressedQuestions(asked(), ['q1-1']), undefined);
    expect(unaddressedQuestions(b)).toHaveLength(0);
  });

  it('honours an explicit notCovered against a plain question', () => {
    const b = recordUncoveredQuestions(asked(), ['q1-0']);
    expect(unaddressedQuestions(b).map((q) => q.id)).toEqual(['q1-0', 'q1-1']);
  });

  it('never marks a question the user has not replied to yet', () => {
    // A question asked THIS turn has no reply to have covered it, so the
    // flipped default must not reach it.
    const b = recordUncoveredQuestions(
      recordQuestions(asked(), [{ text: 'A brand new question.', impact: 'shaping' }]),
      undefined,
    );
    expect(b.questions.find((q) => q.text === 'A brand new question.')?.addressedInRound).toBeUndefined();
  });

  it('is idempotent, so a second call cannot restamp the round', () => {
    const once = recordUncoveredQuestions(asked(), undefined);
    const twice = recordUncoveredQuestions({ ...once, rounds: once.rounds + 1 }, undefined);
    const q = twice.questions.find((x) => x.id === 'q1-0')!;
    expect(q.addressedInRound).toBe(once.questions.find((x) => x.id === 'q1-0')!.addressedInRound);
  });
});
