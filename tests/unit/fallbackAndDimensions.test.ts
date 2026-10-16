// The two P0 guards, and the reasons neither is a hack.
//
// P0a — a refusal must escalate and then apply a stated default. MEASURED: the
// fork guard refused on turn 3 and again on turn 4 with WORD-FOR-WORD identical
// text, then never proposed at all across five turns. The application was doing
// the exact thing this codebase forbids the agent from doing: treating
// repetition as a fallback.
//
// P0b — a dimension raised and never investigated may not reach a proposal.
// MEASURED: a proposal arrived with "What is currently stopping customers from
// converting" at basis `none`. Deferring was free, so it was free to skip the
// one question the campaign turned on.
import { describe, it, expect } from 'vitest';
import {
  newBrief, recordQuestions, recordAnswer, recordDimensions,
  unansweredForks, forksFallenBack, recordForkRefusal, unresolvedDimensions,
  MAX_FORK_REFUSALS, type WorkingBrief,
} from '../../server/discovery';

const OBJ = 'I want to increase OS-to-EMI conversions. Design a drip campaign for this.';
const contingency = {
  ifA: 'They mean a submitted request', thenA: 'Goal on request created',
  ifB: 'They mean a booked conversion', thenB: 'Goal on status Successful',
  ifUnknown: 'Treat a booked conversion as the goal, and say so',
};

/** A brief with one live fork that the user keeps not answering. */
function withFork(c = contingency): WorkingBrief {
  let b = recordQuestions(newBrief(OBJ), [{ text: 'Submitted, or booked?', impact: 'fork', contingency: c }]);
  b = recordAnswer(b, 'Something about targeting that does not address it.');
  return b;
}

describe('P0a — a refusal escalates, then falls back', () => {
  it('blocks the first time', () => {
    const b = withFork();
    expect(unansweredForks(b)).toHaveLength(1);
    expect(forksFallenBack(b)).toHaveLength(0);
  });

  it('still blocks the second time, and knows it is the second', () => {
    const b = recordForkRefusal(withFork(), ['q1-0']);
    expect(unansweredForks(b)).toHaveLength(1);
    expect(b.questions[0].blockedCount).toBe(1);
  });

  it('stops blocking once it has refused its limit', () => {
    // The point of the whole fix: asking a third time is a deadlock, and the
    // live run proved it — five turns, zero proposals.
    let b = withFork();
    for (let i = 0; i < MAX_FORK_REFUSALS; i++) b = recordForkRefusal(b, ['q1-0']);
    expect(unansweredForks(b)).toHaveLength(0);
    expect(forksFallenBack(b)).toHaveLength(1);
  });

  it('carries the uncertainty forward rather than deleting it', () => {
    let b = withFork();
    for (let i = 0; i < MAX_FORK_REFUSALS; i++) b = recordForkRefusal(b, ['q1-0']);
    const fallen = forksFallenBack(b)[0];
    // It is still unanswered. It simply no longer blocks.
    expect(fallen.addressedInRound).toBeUndefined();
    expect(fallen.contingency?.ifUnknown).toContain('booked conversion');
  });

  it('falls back even when no default was ever stated', () => {
    // Without a contingency the fork still blocks twice, then stops. There is
    // nothing to apply, so the proposal must say so — but a question nobody can
    // answer must never be able to deadlock the conversation forever.
    let b = recordQuestions(newBrief(OBJ), [{ text: 'Unanswerable', impact: 'fork' }]);
    b = recordAnswer(b, 'Unrelated.');
    expect(unansweredForks(b)).toHaveLength(1);
    for (let i = 0; i < MAX_FORK_REFUSALS; i++) b = recordForkRefusal(b, ['q1-0']);
    expect(unansweredForks(b)).toHaveLength(0);
    expect(forksFallenBack(b)[0].contingency).toBeUndefined();
  });

  it('counts only the forks that actually caused the refusal', () => {
    let b = recordQuestions(newBrief(OBJ), [
      { text: 'The blocking one', impact: 'fork', contingency },
      { text: 'A detail', impact: 'detail' },
    ]);
    b = recordAnswer(b, 'Unrelated.');
    b = recordForkRefusal(b, ['q1-0']);
    expect(b.questions[0].blockedCount).toBe(1);
    expect(b.questions[1].blockedCount).toBeUndefined();
  });
});

describe('P0b — a dimension you raised cannot be walked away from', () => {
  const dim = (over: Record<string, unknown> = {}) => ({
    name: 'What is stopping customers converting', rationale: 'Decides the message.',
    status: 'open' as const, basis: 'none' as const, ...over,
  });

  it('catches the measured case: named, never investigated, proposed anyway', () => {
    const b = recordDimensions(newBrief(OBJ), [dim({ status: 'deferred' })]);
    expect(unresolvedDimensions(b)).toHaveLength(1);
  });

  it('accepts every honest exit', () => {
    for (const basis of ['user', 'tool', 'user-belief'] as const) {
      const b = recordDimensions(newBrief(OBJ), [dim({ basis })]);
      expect(unresolvedDimensions(b), basis).toHaveLength(0);
    }
  });

  it('accepts an assumption that actually states the assumption', () => {
    const b = recordDimensions(newBrief(OBJ), [dim({ basis: 'assumption', note: 'Assuming cost is the barrier; saying so.' })]);
    expect(unresolvedDimensions(b)).toHaveLength(0);
  });

  it('rejects an assumption with nothing assumed', () => {
    // Otherwise the escape is a one-word relabel and the rule is a spelling
    // test rather than a requirement.
    const b = recordDimensions(newBrief(OBJ), [dim({ basis: 'assumption', note: '   ' })]);
    expect(unresolvedDimensions(b)).toHaveLength(1);
  });

  it('leaves platform-unavailable dimensions alone', () => {
    // "The platform cannot express this" is a finding, not an evasion.
    const b = recordDimensions(newBrief(OBJ), [dim({ status: 'unavailable', basis: 'tool' })]);
    expect(unresolvedDimensions(b)).toHaveLength(0);
  });

  it('says nothing when there are no dimensions at all', () => {
    expect(unresolvedDimensions(newBrief(OBJ))).toEqual([]);
  });
});
