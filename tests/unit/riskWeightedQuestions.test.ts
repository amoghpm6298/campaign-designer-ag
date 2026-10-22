// Which unanswered questions may the agent proceed past?
//
// ROOT CAUSE, read off the OS-to-EMI transcript. Answer attribution was fixed,
// so the funnel-stage question ("customers who never started a request, or
// ones already Pending?") correctly stayed open. The agent still proposed,
// because the guard was:
//
//   questionDropped = pendingQuestions.length > 0 && proposed !== null
//     && !strategyNamesAHypothesis && !proposed.strategy?.assumptions?.length
//
// Two defects in one line. It treated every unanswered question as equally
// droppable — including the one the agent had itself called the central fork.
// And it accepted ANY assumption anywhere in the strategy as discharging ALL
// of them, so a sentence about channel cost could retire a question about who
// the campaign is for.
//
// The agent inferred Pending from the success measure and built an entry on
// EMI_STATUS_CHANGED. The user then said the opposite — never-started — and
// the entry changed entity, event and audience. One short question would have
// avoided designing the wrong campaign.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const gateSource2 = readFileSync(new URL('../../server/gate.ts', import.meta.url), 'utf8');
const recordSource = readFileSync(new URL('../../server/record.ts', import.meta.url), 'utf8');
import { renderStrategy, type Strategy } from '../../server/orchestrator';
import {
  newBrief,
  recordQuestions,
  recordAnswer,
  recordAddressedQuestions,
  recordQuestionResolutions,
  unansweredForks,
  unresolvedQuestions,
  unaddressedQuestions,
  briefForPrompt,
  type WorkingBrief,
} from '../../server/discovery';

/** The real shape: a fork and a detail asked together, neither answered. */
const asked = (): WorkingBrief =>
  recordAnswer(
    recordQuestions(newBrief('Increase OS-to-EMI conversions'), [
      { text: 'Never started a request, or already Pending?', impact: 'fork' },
      { text: 'Which channel do you prefer to lead with?', impact: 'detail' },
    ]),
    'Success is more requests reaching Successful.',
  );

describe('impact is recorded when the question is asked', () => {
  it('keeps the declared impact on the question', () => {
    const b = asked();
    expect(b.questions.map((q) => q.impact)).toEqual(['fork', 'detail']);
  });

  it('still accepts a plain string, with no impact claimed', () => {
    // Backward compatible: an older payload, or a model that omits it, must
    // not crash — it simply makes no claim, and a question with no claimed
    // impact is not treated as a fork.
    const b = recordQuestions(newBrief('o'), ['A plain question']);
    expect(b.questions[0].impact).toBeUndefined();
    expect(unansweredForks(recordAnswer(b, 'hi'))).toHaveLength(0);
  });

  it('shows the fork to the next turn, marked, with its id', () => {
    const out = briefForPrompt(asked());
    expect(out).toContain('[q1-0] [FORK] Never started a request, or already Pending?');
    expect(out).toContain('[q1-1] [detail] Which channel do you prefer to lead with?');
  });

  it('tells the agent a fork may not be assumed past', () => {
    const out = briefForPrompt(asked());
    expect(out).toMatch(/You may not proceed by assuming an answer: ask it, plainly and on its own, and wait/);
    expect(out).toMatch(/An assumption here picks one of two different campaigns on the user's behalf/);
    // And re-labelling it later has to be said out loud, not done quietly.
    expect(out).toMatch(/If you now believe it is not actually a fork, say so explicitly and why/);
  });

  it('says nothing about forks when none is outstanding', () => {
    const b = recordAddressedQuestions(asked(), ['q1-0']);
    expect(briefForPrompt(b)).not.toContain('[FORK]');
  });
});

describe('A — a material, answerable question blocks the proposal', () => {
  it('an unanswered fork is reported as blocking', () => {
    expect(unansweredForks(asked()).map((q) => q.id)).toEqual(['q1-0']);
  });

  it('an unrelated resolution cannot discharge it', () => {
    // The precise defect: a reason about something else used to clear
    // everything. A fork cannot be resolved this way at all.
    let b = recordQuestionResolutions(asked(), [
      { questionId: 'q1-1', kind: 'deferred', why: 'EMAIL is the cheapest default.' },
    ]);
    expect(unansweredForks(b).map((q) => q.id)).toEqual(['q1-0']);
  });

  it('not even a resolution naming the fork itself discharges it', () => {
    // Carrying or deferring is for questions whose answer shapes the design.
    // A fork decides WHICH design, so there is nothing to carry it into.
    const b = recordQuestionResolutions(asked(), [
      { questionId: 'q1-0', kind: 'carried', why: 'I will assume Pending and test it.' },
    ]);
    expect(unansweredForks(b)).toHaveLength(1);
  });

  it('is cleared the moment the user actually answers it', () => {
    const b = recordAddressedQuestions(asked(), ['q1-0']);
    expect(unansweredForks(b)).toHaveLength(0);
  });
});

describe('B and C — carrying and deferring, per question', () => {
  it('a named carry-forward resolves that question and no other', () => {
    let b = recordQuestions(asked(), [
      { text: 'Do larger balances behave differently?', impact: 'shaping' },
    ]);
    b = recordAnswer(b, 'Not sure.');
    b = recordQuestionResolutions(b, [
      { questionId: 'q2-0', kind: 'carried', why: 'No attribute exists; carried as a limitation.' },
    ]);
    const open = unresolvedQuestions(b).map((q) => q.id);
    expect(open).not.toContain('q2-0');
    expect(open).toContain('q1-1'); // the detail, still unresolved
  });

  it('a low-impact question can be deferred with a stated default', () => {
    const b = recordQuestionResolutions(asked(), [
      { questionId: 'q1-1', kind: 'deferred', why: 'Defaulting to EMAIL first, the cheapest channel.' },
    ]);
    expect(unresolvedQuestions(b).map((q) => q.id)).not.toContain('q1-1');
  });

  it('the resolution is shown back on the next turn', () => {
    const b = recordQuestionResolutions(asked(), [
      { questionId: 'q1-1', kind: 'deferred', why: 'Defaulting to EMAIL first.' },
    ]);
    expect(briefForPrompt(b)).toContain('you said: deferred, Defaulting to EMAIL first.');
  });

  it('a resolution naming no real question is discarded', () => {
    const b = recordQuestionResolutions(asked(), [
      { questionId: 'nope', kind: 'deferred', why: 'x' },
      { questionId: '', kind: 'carried', why: 'y' },
    ]);
    expect(b.questionResolutions ?? []).toHaveLength(0);
  });

  it('a resolution with no reason is discarded', () => {
    // "deferred" with no rationale is a silent drop wearing a label.
    const b = recordQuestionResolutions(asked(), [{ questionId: 'q1-1', kind: 'deferred', why: '  ' }]);
    expect(b.questionResolutions ?? []).toHaveLength(0);
    expect(unresolvedQuestions(b).map((q) => q.id)).toContain('q1-1');
  });

  it('does not let a later resolution overwrite an earlier one', () => {
    let b = recordQuestionResolutions(asked(), [{ questionId: 'q1-1', kind: 'deferred', why: 'first' }]);
    b = recordQuestionResolutions(b, [{ questionId: 'q1-1', kind: 'carried', why: 'second' }]);
    expect(b.questionResolutions).toHaveLength(1);
    expect(b.questionResolutions![0].why).toBe('first');
  });

  it('an answered question needs no resolution', () => {
    const b = recordAddressedQuestions(asked(), ['q1-0', 'q1-1']);
    expect(unresolvedQuestions(b)).toHaveLength(0);
    expect(unansweredForks(b)).toHaveLength(0);
  });
});

describe('the orchestrator enforces the three outcomes', () => {
  const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');

  it('routes an unanswered fork away from the strategy path', () => {
    expect(recordSource).toMatch(/export const REOPEN_LIMIT = 1;/);
    expect(recordSource).toMatch(/if \(\(q\.reopened \?\? 0\) >= REOPEN_LIMIT\) return q;/);
    expect(src).toMatch(/if \(!decision\.proceed && !approvedPlan\) \{/);
  });

  it('no longer lets any assumption discharge every question', () => {
    expect(gateSource2).toMatch(/code: 'awaiting-reply'/);
    expect(src).not.toMatch(/questionDropped =[\s\S]{0,120}strategy\?\.assumptions\?\.length/);
  });

  it('asks the fork back in the user\'s own terms', () => {
    // Copy rewritten: it used to say "Your reply did not cover it, and I was
    // about to pick one for you." Measured live, that fired on a reply that
    // HAD answered — the model omitted the `answered` ids, and the
    // application told the manager their answer did not count. Never put a
    // bookkeeping failure on the user; just ask again.
    expect(gateSource2).toMatch(/I am still waiting on this/);
    expect(src).not.toMatch(/Your reply did not cover it/);
  });

  it('records resolutions before the gate reads the brief', () => {
    const rec = src.indexOf('brief = recordQuestionResolutions(brief, parsed.value.questionResolutions)');
    expect(rec).toBeGreaterThan(-1);
    expect(rec).toBeLessThan(src.indexOf('const gate = evaluateDiscovery'));
  });

  it('returns no strategy through the fork branch', () => {
    const branch = src.slice(
      src.indexOf('if (!decision.proceed && !approvedPlan) {'),
      src.indexOf('// Discovery is complete. If the model only asked questions'),
    );
    expect(branch).toMatch(/strategy: null/);
    expect(branch).toMatch(/pendingBlueprint: null/);
  });
});

describe('a limitation that reaches the wrong customer is a decision', () => {
  const SYSTEM = (() => {
    const s = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    return /const SYSTEM = `([\s\S]*?)`;\n/.exec(s)![1];
  })();

  it('separates a disclosable limitation from a targeting risk', () => {
    // The OS-to-EMI pre-request entry could not exclude customers who had
    // already raised or completed a request. Filed as an operational
    // limitation, that is a footnote; it is actually a person receiving a
    // message telling them to do something they have already done.
    expect(SYSTEM).toMatch(/A LIMITATION THAT REACHES THE WRONG CUSTOMER IS NOT A LIMITATION, IT IS A DECISION/);
    expect(SYSTEM).toMatch(/that is not a footnote — someone will receive it/);
    expect(SYSTEM).toMatch(/raise it as a "strategic-ambiguity" so they decide/);
    expect(SYSTEM).toMatch(/not as an "operational-limitation" you have quietly accepted on their behalf/);
  });

  it('teaches impact at ask time, and says why then', () => {
    expect(SYSTEM).toMatch(/WEIGH EVERY QUESTION BEFORE YOU ASK IT/);
    expect(SYSTEM).toMatch(/"fork" if two different answers mean two different campaigns/);
    expect(SYSTEM).toMatch(/Decide this when you ASK, not later/);
    expect(SYSTEM).toMatch(/an awkward question is tempting to call a detail/);
  });

  it('states the asymmetry that justifies asking', () => {
    expect(SYSTEM).toMatch(/A FORK YOU HAVE NOT HAD ANSWERED STOPS YOU/);
    expect(SYSTEM).toMatch(/The cost of one short question is a turn; the cost of guessing is a campaign aimed at the wrong people/);
  });

  it('requires a resolution to name its question', () => {
    expect(SYSTEM).toMatch(/each naming its question id in "questionResolutions" with the reason/);
    expect(SYSTEM).toMatch(/A reason attached to no question resolves no question/);
  });
});

describe('the earlier protections still hold', () => {
  it('attribution, history counts and belief handling are untouched', () => {
    const b = recordAddressedQuestions(asked(), ['q1-1']);
    expect(unaddressedQuestions(b).map((q) => q.id)).toEqual(['q1-0']);
    expect(briefForPrompt(b)).toContain(
      '2 question(s) asked across 1 round(s), 1 answered, 1 asked but not answered, 0 awaiting any reply',
    );
    const disc = readFileSync(new URL('../../server/discovery.ts', import.meta.url), 'utf8');
    // The four customer-facing bases now live in server/findings.ts and
    // DimensionBasis derives from them, so both halves are pinned. Same
    // intent as before: the vocabulary must not shrink unnoticed.
    expect(disc).toMatch(/export type DimensionBasis = FindingBasis \| 'tool';/);
    expect(readFileSync(new URL('../../server/findings.ts', import.meta.url), 'utf8')).toMatch(
      /export type FindingBasis = 'user' \| 'user-belief' \| 'assumption' \| 'none';/,
    );
  });
});

describe('a carried decision stays visible at the moment of confirmation', () => {
  // MEASURED, reproduced in BOTH scenarios. A material targeting risk is raised
  // under "Worth settling before this is built" on the proposal turn. The user
  // replies without addressing it ("Looks good"). On the next turn the agent
  // records the decision honestly in `questionResolutions` — in the dormant run
  // it even wrote that the item was "kept as a strategic-ambiguity open item
  // rather than quietly accepted as an operational limitation" — but stops
  // re-emitting the openItem, so that whole section disappears from the reply.
  //
  // The internal record and what the user reads disagreed, at exactly the point
  // the user is being asked to confirm.
  const base: Strategy = { summary: 'S.', approach: ['A'], assumptions: [], unknowns: [] };
  const questions = [
    { id: 'q2-1', text: 'Should blocked or locked cards be excluded from this audience?' },
  ];

  it('renders what it proceeded past, and why', () => {
    const out = renderStrategy(base, [], null, [
      { questionId: 'q2-1', kind: 'carried', why: 'No cross-entity exclusion exists in the builder.' },
    ], questions);
    expect(out).toContain('**Proceeding without an answer on**');
    // The question in the user's own words, not an internal id.
    expect(out).toContain('Should blocked or locked cards be excluded from this audience?');
    expect(out).toContain('carried as a live uncertainty');
    expect(out).toContain('No cross-entity exclusion exists in the builder.');
    expect(out).not.toContain('q2-1 —');
  });

  it('distinguishes a default applied from a live uncertainty', () => {
    const out = renderStrategy(base, [], null, [
      { questionId: 'q2-1', kind: 'deferred', why: 'Defaulting to include them.' },
    ], questions);
    expect(out).toContain('a default applies');
    expect(out).not.toContain('carried as a live uncertainty');
  });

  it('falls back to the id when the question text is gone', () => {
    const out = renderStrategy(base, [], null, [{ questionId: 'q9-9', kind: 'carried', why: 'r' }], []);
    expect(out).toContain('q9-9');
  });

  it('says nothing when nothing was carried', () => {
    expect(renderStrategy(base, [], null, [], questions)).not.toContain('Proceeding without an answer on');
    expect(renderStrategy(base)).not.toContain('Proceeding without an answer on');
  });

  it('is wired to the real brief, not just callable', () => {
    // The defect was never in renderStrategy's ability to print this — it was
    // that the orchestrator never passed it.
    const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/const replyText = renderStrategy\(\s*\n\s*strategy, gate\.openItems, readiness, brief\.questionResolutions \?\? \[\], brief\.questions, unsupportedClaims\(optionAudits\),\s*\n\s*\)/);
  });
});

describe('a question the user later answered is not reported as unanswered', () => {
  // MEASURED on a live OS-to-EMI run. Resolutions are first-wins and never
  // cleared, so one recorded before the user answered survived to the proposal
  // turn. The confirmation-ready strategy listed the success measure and the
  // believed barrier under "Proceeding without an answer on" — both answered
  // two turns earlier, with reasons that began "Answered: ...".
  //
  // A section built to stop a risk going quiet was instead telling the user
  // that settled things were still open. Introduced by the fix for the
  // previous defect, which rendered every resolution regardless of state.
  const base: Strategy = { summary: 'S.', approach: ['A'], assumptions: [], unknowns: [] };
  const resolutions = [
    { questionId: 'q1-0', kind: 'carried' as const, why: 'Answered: success is more requests reaching Successful.' },
    { questionId: 'q1-1', kind: 'carried' as const, why: 'No cross-entity exclusion exists.' },
  ];

  it('omits a resolution whose question has since been answered', () => {
    const out = renderStrategy(base, [], null, resolutions, [
      { id: 'q1-0', text: 'How will you judge success?', addressedInRound: 2 },
      { id: 'q1-1', text: 'Should blocked cards be excluded?' },
    ]);
    expect(out).toContain('**Proceeding without an answer on**');
    expect(out).toContain('Should blocked cards be excluded?');
    expect(out).not.toContain('How will you judge success?');
  });

  it('drops the whole section when every carried question got answered', () => {
    const out = renderStrategy(base, [], null, resolutions, [
      { id: 'q1-0', text: 'How will you judge success?', addressedInRound: 2 },
      { id: 'q1-1', text: 'Should blocked cards be excluded?', addressedInRound: 3 },
    ]);
    expect(out).not.toContain('Proceeding without an answer on');
  });

  it('still shows one whose question text is gone, since it cannot be checked', () => {
    // A resolution naming an id no longer in the record is reported rather
    // than silently dropped — the opposite failure would hide a real one.
    const out = renderStrategy(base, [], null, [resolutions[1]], []);
    expect(out).toContain('q1-1');
  });
});
