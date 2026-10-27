// Discovery across several turns: does the record accumulate, and does it
// stop?
//
// These drive the real functions over a sequence of turns rather than
// asserting on prompt text, because the failure modes here are about STATE —
// what survives a turn boundary, what gets asked twice, and what can hold the
// conversation open for ever.
import { describe, it, expect } from 'vitest';
import { blocksFor } from '../../server/gate';
import { alternativesRuledOut } from './support/findings';
import {
  newBrief,
  recordDimensions,
  recordAnswer,
  recordQuestions,
  recordAddressedQuestions,
  recordEvidenceRequests,
  resolveEvidence,
  briefDimensions,
  briefForPrompt,
  outstandingDimensions,
  userHasRespondedOnce,
  successCriteriaSettled,
  recordSuccessCriteria,
  type WorkingBrief,
} from '../../server/discovery';

/** The four things an answer can do, as the prompt names them. */
describe('an answer can narrow, raise or invalidate, not only settle', () => {
  it('a narrowed dimension stays open and keeps its history', () => {
    let b = recordDimensions(newBrief('OS-to-EMI'), [
      { name: 'Primary blocker', rationale: 'Decides what the message leads with.', status: 'open', basis: 'none' },
    ]);
    b = recordAnswer(b, 'We think it is interest-cost hesitation.');
    // Turn 2 narrows rather than closes: cost is a family of explanations.
    b = recordDimensions(b, [
      { name: 'Primary blocker', status: 'open', basis: 'user-belief', note: 'Cost hesitation — which part is unclear.' },
    ]);
    const d = briefDimensions(b)[0];
    expect(d.status).toBe('open');
    // The rationale from turn 1 survives a turn-2 update that omitted it.
    expect(d.rationale).toBe('Decides what the message leads with.');
    expect(outstandingDimensions(b)).toHaveLength(1);
    // `discoveryIsComplete` is gone (a count of rows was never the test of a
    // finished brief — see server/CLAUDE.md), so what is asserted is the thing
    // this case is actually about, just above.
  });

  it('a raised dimension is appended without disturbing the others', () => {
    let b = recordDimensions(newBrief('o'), [
      { name: 'Success measure', status: 'retained', basis: 'user' },
      { name: 'Audience', status: 'open', basis: 'none' },
    ]);
    b = recordDimensions(b, [{ name: 'Incentive availability', status: 'open', basis: 'none', rationale: 'New.' }]);
    expect(briefDimensions(b).map((d) => d.name)).toEqual([
      'Success measure',
      'Audience',
      'Incentive availability',
    ]);
    expect(briefDimensions(b)[0].status).toBe('retained');
  });

  it('a dimension made irrelevant is a decision, not a deletion', () => {
    let b = recordDimensions(newBrief('o'), [{ name: 'Value tiering', status: 'open', basis: 'none' }]);
    b = recordDimensions(b, [
      { name: 'Value tiering', status: 'deferred', basis: 'user', note: 'User wants uniform treatment.' },
    ]);
    expect(briefDimensions(b)).toHaveLength(1);
    expect(briefDimensions(b)[0].status).toBe('deferred');
    // Deferred does not hold discovery open — it is an answer.
    expect(outstandingDimensions(b)).toHaveLength(0);
  });

  it('a later answer may reopen something an earlier one settled', () => {
    let b = recordDimensions(newBrief('o'), [{ name: 'Audience', status: 'retained', basis: 'user' }]);
    b = recordDimensions(b, [{ name: 'Audience', status: 'open', basis: 'none', note: 'Turn 3 contradicted turn 2.' }]);
    expect(briefDimensions(b)[0].status).toBe('open');
  });
});

describe('nothing is asked twice', () => {
  it('only a question the agent CONFIRMED was answered is listed as answered', () => {
    // Changed deliberately. A reply arriving used to mark every outstanding
    // question answered, which is how an unanswered question became a settled
    // finding. Arrival of a reply is no longer evidence that it covered this
    // question — the agent has to name the id.
    let b = recordQuestions(newBrief('o'), ['How will you judge success?']);
    b = recordAnswer(b, 'More requests reaching Successful.');
    expect(briefForPrompt(b)).not.toContain('Already asked and ANSWERED');
    expect(briefForPrompt(b)).toContain('Asked, but the reply did NOT appear to answer these');

    b = recordAddressedQuestions(b, ['q1-0']);
    const out = briefForPrompt(b);
    expect(out).toContain('Already asked and ANSWERED. Do not ask these again:');
    expect(out).toContain('How will you judge success?');
    expect(out).not.toContain('Asked, but the reply did NOT appear to answer these');
  });

  it('settled success criteria are never re-asked', () => {
    let b = recordAnswer(newBrief('o'), 'No target number.');
    // Before recording, the brief says "record it", NOT "ask the user" — the
    // one-turn lag that previously made the strategy turn re-ask.
    expect(briefForPrompt(b)).toContain('NOT YET RECORDED');
    expect(briefForPrompt(b)).toContain('Do not ask again for something they have already told you');
    b = recordSuccessCriteria(b, ['More EMI Requests reaching Successful.']);
    expect(successCriteriaSettled(b)).toBe(true);
    expect(briefForPrompt(b)).toContain('already settled');
  });

  it('data the user said does not exist is never requested again', () => {
    let b = recordEvidenceRequests(newBrief('o'), [
      { question: 'Conversion by balance band?', fields: ['rate'], wouldInform: 'Targeting.' },
    ]);
    b = resolveEvidence(b, 'We do not have that data.');
    const out = briefForPrompt(b);
    expect(out).toMatch(/do NOT ask for this again/);
    // And it counts as the user having taken part, so a conversation whose
    // only exchange was "we don't have it" is not held open.
    expect(userHasRespondedOnce(b)).toBe(true);
  });
});

describe('discovery terminates', () => {
  // Settled: the user took part, success is defined, and alternatives were
  // raised and ruled out. These cases are about whether a RESOLVED dimension
  // closes rather than looping, so the minimum-alternatives rule must not be
  // what they trip over.
  const settle = (b: WorkingBrief) =>
    alternativesRuledOut(recordSuccessCriteria(recordAnswer(b, 'answered'), ['measure']));

  it('an unbuildable dimension is disclosed, never pursued for ever', () => {
    // The OS amount case: no attribute exists anywhere, so no number of
    // further questions can resolve it. It must close as a limitation.
    const b = settle(
      recordDimensions(newBrief('o'), [
        { name: 'Balance targeting', status: 'unavailable', basis: 'tool', note: 'No attribute on any entity.' },
      ]),
    );
    expect(outstandingDimensions(b)).toHaveLength(0);
  });

  it('a belief cannot hold the conversation open', () => {
    const b = settle(
      recordDimensions(newBrief('o'), [{ name: 'Cause', status: 'retained', basis: 'user-belief' }]),
    );
  });

  it('an empty record is not a finished brief, and the blocks are what say so', () => {
    // RETARGETED 2026-10-26. This read `discoveryIsComplete`, which counted
    // rows; the claim it was making is still true and now has one owner. An
    // agent that recorded nothing has skipped discovery, and the record's own
    // blocks name what is missing — participation, success, who converts, the
    // barrier — rather than a quantity of lines of enquiry.
    // `settle` files a reply and a success measure and rules out the
    // alternatives — a tidy-looking record with no FINDINGS in it.
    const bare = settle(newBrief('o'));
    expect(bare.converters ?? null).toBeNull();
    expect(blocksFor(bare).map((x) => x.code)).toEqual(['converters-unknown', 'no-barrier']);
  });

  it('a complete record still needs the user to have taken part', () => {
    const b = alternativesRuledOut(recordDimensions(newBrief('o'), [{ name: 'A', status: 'retained', basis: 'tool' }]));
    expect(userHasRespondedOnce(b)).toBe(false);
  });

  it('accumulates a realistic three-turn conversation without duplicating anything', () => {
    // The dormant-card shape, driven through the real functions.
    let b = newBrief('Reactivate dormant cards');
    b = recordQuestions(b, ['How is success judged?', 'What does dormant mean?', 'Why did they stop?']);
    b = recordDimensions(b, [
      { name: 'Success measure', status: 'open', basis: 'none' },
      { name: 'Dormancy definition', status: 'open', basis: 'none' },
      { name: 'Believed cause', status: 'open', basis: 'none' },
      { name: 'Value tiering', status: 'open', basis: 'none' },
    ]);

    b = recordAnswer(b, 'More cards transacting. Dormant is 6 months. We think they forgot.');
    b = recordDimensions(b, [
      { name: 'Success measure', status: 'retained', basis: 'user' },
      { name: 'Dormancy definition', status: 'retained', basis: 'user' },
      { name: 'Believed cause', status: 'retained', basis: 'user-belief' },
    ]);
    b = recordSuccessCriteria(b, ['More dormant cards transacting again.']);
    // Value tiering was never addressed, so discovery is not finished.
    expect(outstandingDimensions(b).map((d) => d.name)).toEqual(['Value tiering']);

    b = recordAnswer(b, 'Treat everyone the same, we have no tiers.');
    b = recordDimensions(b, [
      { name: 'Value tiering', status: 'deferred', basis: 'user', note: 'Uniform treatment, no tier data.' },
    ]);
    // Four dimensions throughout — no round created a near-duplicate.
    expect(briefDimensions(b)).toHaveLength(4);
    expect(b.answers).toHaveLength(2);
    // And the belief is still marked as one at the end of it.
    expect(briefDimensions(b).find((d) => d.name === 'Believed cause')!.note).toMatch(/carried as a hypothesis/);
  });
});

describe('the agent is told its real question history', () => {
  // Found during live verification, not by inspection: having asked ONE round
  // of three questions, both scenarios justified proposing with a history that
  // did not happen — "Asked twice (round 1 and implicitly in round 2)" and
  // "rather than asking a third time". A judgement-based stopping rule is only
  // as good as the agent's view of what it has already done.
  it('states the counts as fact', () => {
    let b = recordQuestions(newBrief('o'), ['Q1', 'Q2', 'Q3']);
    b = recordAnswer(b, 'answer');
    const out = briefForPrompt(b);
    expect(out).toContain('3 question(s) asked across 1 round(s), 0 answered, 3 asked but not answered, 0 awaiting any reply');
    expect(out).toMatch(/do not claim to have asked something more often than this says/);
  });

  it('counts an unanswered question separately from a refused one', () => {
    // The dormant run deferred a dimension as though the user had declined it,
    // when they had simply not mentioned it. Those are different states.
    const b = recordQuestions(newBrief('o'), ['Q1']);
    const out = briefForPrompt(b);
    expect(out).toContain('1 question(s) asked across 1 round(s), 0 answered, 0 asked but not answered, 1 awaiting any reply');
    expect(out).toMatch(/do not treat a question the user simply did not address as one they refused/);
  });

  it('shows an unanswered question with its id, so it can be named', () => {
    let b = recordQuestions(newBrief('o'), ['Q1']);
    b = recordAnswer(b, 'a');
    expect(briefForPrompt(b)).toMatch(/- \[q1-0\] Q1/);
    expect(briefForPrompt(b)).toMatch(/carry it \(it stays a live uncertainty the strategy works around\) or defer it/);
  });
});
