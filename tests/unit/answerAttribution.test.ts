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
const gateSource = readFileSync(new URL('../../server/gate.ts', import.meta.url), 'utf8');
const gateSrc2 = readFileSync(new URL('../../server/gate.ts', import.meta.url), 'utf8');
import {
  newBrief,
  recordQuestions,
  recordAnswer,
  recordAddressedQuestions,
  recordUncoveredQuestions,
  recordQuestionResolutions,
  unaddressedQuestions,
  briefForPrompt,
  type WorkingBrief,
} from '../../server/discovery';
import { OUTPUT_TOOLS, outputToolsForPhase } from '../../server/outputTools';
import { receive, reopen, outstanding, exhausted } from '../../server/record';

/** Three questions on screen, and the manager's reply to them. */
const asked = (): WorkingBrief =>
  recordQuestions(newBrief('Increase OS-to-EMI conversions'), [
    'How do you want success judged here?',
    'Is the gap customers who never started a request, or ones already Pending?',
    'What do you believe is the main reason customers do not convert?',
  ]);

const THE_REPLY =
  'No fixed target. Success is more EMI Requests reaching Successful. We think interest-cost hesitation is the barrier.';

/** The production shape: the questions were asked, and a reply arrived. */
const scenarioA = (): WorkingBrief => receive(asked(), THE_REPLY).brief;

// A REPLY ADDRESSES WHAT WAS ON SCREEN. One write, in one place.
//
// REWRITTEN 2026-10-24, and the contract it replaces is what stalled a live
// conversation. This group used to pin model-claimed `answered` as the ONLY
// closer — "a reply nobody attributes leaves every question open" — on the
// reasoning that the application cannot tell which question a sentence
// addresses. True, and the wrong conclusion: `eval/runs/ui-s-1792839251135`
// shows the manager settling success, who converts, the barrier and the
// extra-axis probe across three turns, every question ending
// `answeredInRound: 0` / `addressedInRound: undefined`, and the gate holding
// `awaiting-reply` on all four. The record could not hear them.
//
// What the application guarantees instead: a reply closes the questions it was
// a reply to, `notCovered` / `reopen` is the one bounded way to say a specific
// question went untouched, and a resolution is commentary rather than a second
// gate. The verification rules below — ids must be real, counts come from
// state, a proposal cannot silently drop a question — are untouched.
describe('a reply addresses the questions that were on screen', () => {
  it('closes all three, in the same write as the answer text', () => {
    const b = scenarioA();
    expect(unaddressedQuestions(b)).toHaveLength(0);
    expect(outstanding(b)).toHaveLength(0);
    expect(b.answers.map((a) => a.text)).toEqual([THE_REPLY]);
    // And the reply is on the record as a confirmed fact carrying the ids it
    // settled, which is what lets the gate tell "they told us" from "we
    // assumed" without reading wording.
    expect(b.facts.some((f) => f.statement === THE_REPLY && f.source === 'user-answer')).toBe(true);
  });

  it('needs no claim from the model, and a claim adds nothing', () => {
    const plain = scenarioA();
    const claimed = recordAddressedQuestions(scenarioA(), ['q1-0', 'q1-1', 'q1-2']);
    expect(unaddressedQuestions(plain)).toHaveLength(0);
    expect(unaddressedQuestions(claimed)).toHaveLength(0);
  });

  it('notCovered is the exception, and it is bounded', () => {
    // The protection the old default was buying: a fork discharged by
    // inference builds the wrong campaign. It is bought here instead, where
    // the model states which question went untouched — and `REOPEN_LIMIT`
    // stops the same question coming back for ever.
    const back = reopen(scenarioA(), ['q1-1']);
    expect(outstanding(back).map((q) => q.id)).toEqual(['q1-1']);
    const out = briefForPrompt(back);
    expect(out).toContain('Asked, but the reply did NOT appear to answer these');
    expect(out).toContain('[q1-1] Is the gap customers who never started a request, or ones already Pending?');

    const answeredAgain = receive(back, 'the ones already Pending').brief;
    expect(outstanding(answeredAgain)).toHaveLength(0);
    expect(outstanding(reopen(answeredAgain, ['q1-1']))).toHaveLength(0);
    expect(exhausted(answeredAgain).map((q) => q.id)).toContain('q1-1');
  });

  it('a question asked AFTER the reply stays open', () => {
    // Attribution is to what was on screen, so a question raised later cannot
    // have been answered by a reply that predates it.
    let b = scenarioA();
    b = recordQuestions(b, ['Which channel do you prefer?']);
    expect(outstanding(b).map((q) => q.id)).toEqual(['q2-0']);
    expect(briefForPrompt(b)).toContain('Already asked and ANSWERED');
  });

  it('a resolution is commentary, not a closer', () => {
    // `questionResolutions` records WHY the agent carried or deferred
    // something. It does not decide whether the manager answered, and a
    // reasoned note on a question nobody replied to leaves it outstanding.
    const open = asked();
    const withNote = recordQuestionResolutions(open, [
      { questionId: 'q1-1', kind: 'carried', why: 'I will assume never-started and test it.' },
    ]);
    expect(outstanding(withNote).map((q) => q.id)).toEqual(['q1-0', 'q1-1', 'q1-2']);
  });

  it('an answered question is not asked again', () => {
    const out = briefForPrompt(scenarioA());
    expect(out).toContain('Already asked and ANSWERED. Do not ask these again:');
    expect(out).toContain('How do you want success judged here?');
  });

  it('re-claiming an already-answered question does not move its round', () => {
    let b = scenarioA();
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
    // Read on a brief where nothing has been replied to yet, which is the
    // only state where a claim is the thing doing any work.
    // `outstanding`, not `unaddressedQuestions`: the latter means "a reply
    // arrived and this one was skipped", and nothing has replied here. All
    // three are still on screen, which is what a bogus id cannot change.
    const b = recordAddressedQuestions(asked(), ['q9-9', 'not-a-question']);
    expect(outstanding(b)).toHaveLength(3);
  });

  it('treats an empty or missing claim as claiming nothing', () => {
    const b = asked();
    expect(outstanding(recordAddressedQuestions(b, []))).toHaveLength(3);
    expect(outstanding(recordAddressedQuestions(b, undefined as unknown as string[]))).toHaveLength(3);
  });

  it('counts come from recorded state, never from the model\'s narrative', () => {
    // The reply closed all three and the model said one went untouched, so
    // the counts come out of `reopen` rather than out of a partial claim.
    const b = reopen(scenarioA(), ['q1-1']);
    expect(briefForPrompt(b)).toContain(
      '3 question(s) asked across 1 round(s), 2 answered, 1 asked but not answered, 0 awaiting any reply',
    );
  });

  it('separates "asked and ignored" from "asked, no reply yet"', () => {
    // Three distinct states the old record collapsed into two. A question
    // awaiting any reply is not the same as one the user read and skipped.
    let b = reopen(scenarioA(), ['q1-1']);
    b = recordQuestions(b, ['A brand new question']);
    expect(briefForPrompt(b)).toContain(
      '4 question(s) asked across 2 round(s), 2 answered, 1 asked but not answered, 1 awaiting any reply',
    );
  });

  it('states both exits for an unanswered question, and forbids dropping it', () => {
    const out = briefForPrompt(reopen(scenarioA(), ['q1-1']));
    expect(out).toMatch(/carry it \(it stays a live uncertainty the strategy works around\) or defer it \(a stated default applies\)/);
    expect(out).toMatch(/A reason attached to no question resolves no question/);
    expect(out).toMatch(/Silently dropping one is not an option/);
    expect(out).toMatch(/recording it as a settled finding when nobody answered it is worse/);
  });
});

describe('a proposal cannot quietly drop an unanswered question', () => {
  const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');

  it('refuses a strategy that says nothing about one', () => {
    expect(gateSrc2).toMatch(/code: 'awaiting-reply'/);
    // One decider now; the four vetoes ORed with it are deleted.
    expect(src).toMatch(/if \(!decision\.proceed && !approvedPlan\) \{/);
  });

  it('is satisfied only by a reason naming that specific question', () => {
    // Changed deliberately. It used to accept ANY assumption anywhere in the
    // strategy as discharging EVERY outstanding question — which is how the
    // biggest fork in the OS-to-EMI conversation got settled by inference.
    // Resolution is now per-question, by id (see unresolvedQuestions).
    expect(gateSource).toMatch(/code: 'awaiting-reply'/);
    const disc = readFileSync(new URL('../../server/discovery.ts', import.meta.url), 'utf8');
    expect(disc).toMatch(/!\(brief\.questionResolutions \?\? \[\]\)\.some\(\(r\) => r\.questionId === q\.id\)/);
  });

  it('only ever fires on a propose turn', () => {
    expect(gateSource).toMatch(/clears: \{ field: 'reply'/);
  });

  it('quotes the question back to the user rather than citing an id', () => {
    // The accusation is gone, deliberately. A refusal now states what it is
    // waiting on; it never tells the user their reply failed to count.
    expect(src).not.toMatch(/your reply did not cover it/);
    expect(gateSource).toMatch(/I am still waiting on this/);
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
  // answered. Forks were held back as an exception for five days and are
  // not any more — see the block below for the live failure that decided
  // it. `recordUncoveredQuestions` is where the rule lives, and
  // `notCovered` is the only thing that keeps anything open.
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

  it('tells the model forks are not an exception, and what does keep one open', () => {
    // The prompt has to match the application. While the fork exception
    // existed the prompt described it correctly; now that it is gone, leaving
    // the old sentence in would teach the model a rule the code does not
    // follow — which is how a prompt starts producing confident wrong
    // bookkeeping.
    expect(SYSTEM).toMatch(/FORKS ARE NOT AN EXCEPTION/);
    expect(SYSTEM).toMatch(/"notCovered" is the only thing that keeps one open/);
    expect(SYSTEM).not.toMatch(/FORKS ARE THE EXCEPTION/);
  });

  it('keeps a skipped question distinct from a refusal', () => {
    expect(SYSTEM).toMatch(/A skipped question is not a refusal/);
  });

  it('carries notCovered in the one slot that records findings', () => {
    // There used to be two hand-written payload templates and the field had to
    // appear in both. There is now one tool, reachable on every turn, so the
    // "which payload did we forget" class of bug cannot recur.
    const findings = OUTPUT_TOOLS.find((t) => t.name === 'record_findings')!;
    expect(findings.input_schema.properties.notCovered).toBeDefined();
    expect(findings.description).toMatch(/leaving it empty is normal and correct/);
    for (const turn of [true, false]) {
      expect(outputToolsForPhase(turn ? 'build' : 'asking').map((t) => t.name)).toContain('record_findings');
    }
  });
});

describe('silence from the model is read as an answer, forks included', () => {
  // The behaviour itself, not the prompt. These are the tests that would
  // have caught the original defect.
  //
  // THE FORK EXCEPTION IS GONE, 2026-10-21, and this fixture is the run that
  // removed it — verbatim. The agent asked these two questions and declared
  // the audience one a fork. The manager replied "1. Activation means setting
  // the PIN 2. We measure how many new cardholders activate". The agent's own
  // prose came back "Confirmed so far: activation means setting the PIN, and
  // success is read as more cardholders activating" — and the client listed
  // both questions again underneath it, because the model had not emitted
  // `answered` and the exception kept them outstanding. By turn three there
  // were five numbered questions on screen and nothing had been designed.
  //
  // The asymmetry the exception rested on is still true: discharging a fork
  // wrongly builds the wrong campaign. It was the wrong trade anyway. A
  // default that cannot be cleared by answering is not caution, and the model
  // has a precise instrument for the case the exception was protecting —
  // `notCovered`, tested below on a fork.
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

  it('closes the fork on that same reply, with nothing else needed', () => {
    // The live failure, inverted into the assertion. Both questions were
    // answered in one message and both are now off the record.
    const b = recordUncoveredQuestions(asked(), undefined);
    expect(unaddressedQuestions(b)).toHaveLength(0);
  });

  it('still honours a positive claim on the fork, which is now redundant', () => {
    // `answered` keeps working. It is no longer the ONLY way through, which
    // is the whole change.
    const b = recordUncoveredQuestions(recordAddressedQuestions(asked(), ['q1-1']), undefined);
    expect(unaddressedQuestions(b)).toHaveLength(0);
  });

  it('honours an explicit notCovered against a plain question', () => {
    const b = recordUncoveredQuestions(asked(), ['q1-0']);
    expect(unaddressedQuestions(b).map((q) => q.id)).toEqual(['q1-0']);
  });

  it('honours an explicit notCovered against a fork, which is the real guard', () => {
    // This is what protects against a fork discharged by inference, and it is
    // a claim about the reply in front of the model rather than a standing
    // default. If this ever stops working, the exception was worth something
    // after all and its removal has to be revisited.
    const b = recordUncoveredQuestions(asked(), ['q1-1']);
    expect(unaddressedQuestions(b).map((q) => q.id)).toEqual(['q1-1']);
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
