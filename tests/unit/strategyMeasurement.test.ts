// Success criteria and measurement are first-class, and discovery does not
// finish until the business measure is settled.
//
// THE BASELINE GAP. The agreed OS-to-EMI simulation agrees the outcome and how
// it will be judged at T2-T4, and its strategy at T18 has eight sections
// including Measurement and Hypotheses. The implementation had none of it: the
// prompt contained no occurrence of "measure", "success criteria",
// "observation window", "holdout" or "baseline"; `Strategy` had no field; the
// renderer had no section; and `brief.successCriteria` was declared but never
// written or read. The live run produced six sections and never discussed
// success.
//
// Deterministic throughout. The model's side is supplied as fixtures.
import { describe, it, expect } from 'vitest';
import { discovered } from './support/findings';
import { readFileSync } from 'node:fs';
import { renderStrategy, type Strategy } from '../../server/orchestrator';
import {
  evaluateDiscovery,
  newBrief,
  recordAnswer,
  recordDimensions,
  recordSuccessCriteria,
  successCriteriaSettled,
  type WorkingBrief,
} from '../../server/discovery';

const OBJECTIVE = 'I want to increase OS-to-EMI conversions. Design a drip campaign for this.';
const SYSTEM = (() => {
  const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
  return /const SYSTEM = `([\s\S]*?)`;\n/.exec(src)![1];
})();

const STRATEGY: Strategy = {
  summary: 'Nudge customers with a pending request before it expires.',
  approach: ['Entry on the pending request.'],
  assumptions: ['Quiet hours are enforced by the platform.'],
  unknowns: [],
  successCriteria: ['Completed OS-to-EMI conversions among customers who entered the journey.'],
  measurement: ['Track entrants and completed conversions over the 7-day request window.'],
  hypotheses: ['Outstanding amount may affect willingness to convert.'],
};

describe('the renderer shows the new sections', () => {
  it('renders success criteria, measurement and hypotheses as named sections', () => {
    const out = renderStrategy(STRATEGY);
    expect(out).toContain('**Success criteria**');
    expect(out).toContain('**Measurement**');
    expect(out).toContain('**Hypotheses for future testing**');
    expect(out).toContain('Completed OS-to-EMI conversions among customers who entered the journey.');
    expect(out).toContain('Track entrants and completed conversions');
  });

  it('keeps every section the baseline asks for, in a readable order', () => {
    const out = renderStrategy(STRATEGY);
    const order = ['**Approach**', '**Success criteria**', '**Measurement**', '**Assumptions**', '**Hypotheses for future testing**'];
    let at = -1;
    for (const h of order) {
      const i = out.indexOf(h);
      expect(i, h).toBeGreaterThan(at);
      at = i;
    }
  });

  it('omits a section the model did not supply, rather than printing an empty heading', () => {
    const out = renderStrategy({ ...STRATEGY, measurement: [], hypotheses: undefined });
    expect(out).toContain('**Success criteria**');
    expect(out).not.toContain('**Measurement**');
    expect(out).not.toContain('**Hypotheses for future testing**');
  });
});

describe('the prompt asks for them, and forbids inventing numbers', () => {
  it('requests success criteria and measurement in the propose payload', () => {
    expect(SYSTEM).toMatch(/"successCriteria":\[/);
    expect(SYSTEM).toMatch(/"measurement":\[/);
    expect(SYSTEM).toMatch(/"hypotheses":\[/);
  });

  it('tells the agent to settle how success is judged, and to ask when unclear', () => {
    expect(SYSTEM).toMatch(/settle HOW SUCCESS WOULD BE JUDGED/);
    expect(SYSTEM).toMatch(/This is the business's own measure, not the goal event, and it is THEIRS to give/);
    // THE OPENING FIX. The agent used to write itself a "working definition"
    // on turn 1 and carry on, which decided what the campaign optimised for
    // without ever asking. Measured live: successCriteria had 2 self-assigned
    // entries before the user had said anything.
    expect(SYSTEM).toMatch(/On your FIRST turn you must ASK for it/);
    expect(SYSTEM).toMatch(/do not write yourself a "working definition" and carry on/);
    expect(SYSTEM).toMatch(/Only once they have answered, or said they have no target/);
  });

  it('keeps measurement qualitative: no target, no history, no forecast', () => {
    expect(SYSTEM).toMatch(/what to TRACK and how to EVALUATE it/);
    expect(SYSTEM).toMatch(/Keep it qualitative and actionable/);
    expect(SYSTEM).toMatch(/Never state a target, a historical result or a forecast of lift/);
    expect(SYSTEM).toMatch(/any number here would be invented/);
  });
});

describe('the brief records the business measure', () => {
  it('replaces the criteria rather than accumulating rewordings', () => {
    // DELIBERATE BEHAVIOUR CHANGE, not a corrected test. This recorded
    // additively and deduplicated only on an exact lowercase match. The model
    // restates the objective on every propose turn with small rewordings, so
    // a live run ended up showing the user "ongoing optimisation, not tied to
    // a campaign cycle" and "ongoing, open-ended optimisation, not tied to a
    // campaign cycle" as two separate measures of success.
    //
    // There is one definition of success. The latest statement supersedes the
    // earlier one. Fuzzy-matching near-identical strings was the alternative
    // and was rejected: it is a guess that will one day merge two criteria
    // that genuinely differ, silently.
    let b = recordSuccessCriteria(newBrief(OBJECTIVE), ['Completed conversions.']);
    b = recordSuccessCriteria(b, ['  completed conversions.  ', 'Conversion rate among entrants.']);
    expect(b.successCriteria).toEqual(['completed conversions.', 'Conversion rate among entrants.']);
  });

  it('ignores blank entries', () => {
    const b = recordSuccessCriteria(newBrief(OBJECTIVE), ['', '   ']);
    expect(b.successCriteria).toEqual([]);
  });

  it('treats "no target yet" as settled, because that is an explicit decision', () => {
    const b = recordSuccessCriteria(newBrief(OBJECTIVE), ['No target set yet; using completed conversions as the working measure.']);
    expect(successCriteriaSettled(b)).toBe(true);
  });

  it('treats silence as unsettled', () => {
    expect(successCriteriaSettled(newBrief(OBJECTIVE))).toBe(false);
  });

  it('works on a brief saved before the field was used', () => {
    const legacy = newBrief(OBJECTIVE) as Record<string, unknown>;
    delete legacy.successCriteria;
    const b = legacy as unknown as WorkingBrief;
    expect(successCriteriaSettled(b)).toBe(false);
    expect(recordSuccessCriteria(b, ['Completed conversions.']).successCriteria).toEqual(['Completed conversions.']);
  });
});

describe('the gate will not accept a strategy that cannot say what success means', () => {
  const participated = (b: WorkingBrief) => recordAnswer(discovered(b), 'Target the pending requests.');
  const considered = (b: WorkingBrief) =>
    recordDimensions(b, [{ name: 'Audience', rationale: 'Who enters.', status: 'retained', basis: 'user' }]);

  const gate = (brief: WorkingBrief, over: Record<string, unknown> = {}) =>
    evaluateDiscovery({
      brief,
      modelAction: 'propose',
      modelQuestions: [],
      modelEvidence: [],
      openItems: [],
      forced: false,
      maxRounds: 8,
      ...over,
    });

  it('refuses while success is unsettled, even with dimensions done and a round answered', () => {
    const d = gate(participated(considered(newBrief(OBJECTIVE))));
    expect(d.outcome).toBe('continue_discovery');
    expect(d.reason).toMatch(/do not know how you would judge whether this worked/i);
  });

  it('accepts once success is settled', () => {
    const b = recordSuccessCriteria(participated(considered(newBrief(OBJECTIVE))), ['Completed conversions.']);
    expect(gate(b).outcome).toBe('ready_for_strategy');
  });

  it('is NOT a round count: one answered round is not enough on its own', () => {
    // The adjustment you asked for. Stopping depends on the material question
    // being resolved or explicitly handled, not on a number of exchanges.
    const oneRound = participated(considered(newBrief(OBJECTIVE)));
    expect(gate(oneRound).outcome).toBe('continue_discovery');
    const sameRoundPlusSuccess = recordSuccessCriteria(oneRound, ['Completed conversions.']);
    expect(gate(sameRoundPlusSuccess).outcome).toBe('ready_for_strategy');
  });

  it('forced progression still overrides', () => {
    expect(gate(participated(considered(newBrief(OBJECTIVE))), { forced: true }).outcome).toBe('ready_for_strategy');
  });

  it('the round limit still overrides', () => {
    const atLimit: WorkingBrief = { ...participated(considered(newBrief(OBJECTIVE))), rounds: 8 };
    expect(gate(atLimit).outcome).toBe('ready_for_strategy');
  });

  it('a refinement is still never re-gated', () => {
    expect(gate(newBrief(OBJECTIVE), { isRefinement: true }).outcome).toBe('ready_for_strategy');
  });

  it('asking questions and requesting evidence are unaffected', () => {
    expect(gate(newBrief(OBJECTIVE), { modelAction: 'ask', modelQuestions: ['Which audience?'] }).outcome).toBe('ask_questions');
    expect(
      gate(newBrief(OBJECTIVE), {
        modelAction: 'request_evidence',
        modelEvidence: [{ question: 'How many pending?', fields: ['count'], wouldInform: 'Sizing.' }],
      }).outcome,
    ).toBe('request_evidence');
  });
});

describe('the audience they asked for is not conflated with the audience we can build', () => {
  // THE DEFECT, traced in the recorded OS-to-EMI run. The user's intended
  // audience was "outstanding balance above ~₹25,000". No such attribute
  // exists, so the strategy entered on active accounts near their statement
  // due date — and the threshold appeared in exactly ONE place:
  // strategy.rejected, under "Considered and not used". Not in assumptions,
  // not in unknowns, not in the summary. A capability gap was recorded as a
  // design decision, and the summary presented the buildable audience as if
  // it were the one requested.
  it('tells the agent to state intended, actual and the cost of the difference', () => {
    const method = SYSTEM.slice(SYSTEM.indexOf('3. The business strategy'), SYSTEM.indexOf('4. The sequence'));
    expect(method).toMatch(/WHEN THE AUDIENCE YOU CAN BUILD IS NOT THE AUDIENCE THEY ASKED FOR/);
    expect(method).toMatch(/who they intended to reach, in their words, and that it is theirs/);
    expect(method).toMatch(/who the campaign will actually reach once mapped to what exists/);
    expect(method).toMatch(/what the difference costs, in reach or in relevance/);
  });

  it('requires a user-given figure to survive verbatim and attributed', () => {
    const method = SYSTEM.slice(SYSTEM.indexOf('3. The business strategy'), SYSTEM.indexOf('4. The sequence'));
    expect(method).toMatch(/keep any threshold or figure they gave you exactly as they said it, attributed to them/);
  });

  it('forbids the summary from passing off the buildable audience as the intended one', () => {
    const method = SYSTEM.slice(SYSTEM.indexOf('3. The business strategy'), SYSTEM.indexOf('4. The sequence'));
    expect(method).toMatch(/Never let the summary present the audience you CAN build as if it were the audience they asked for/);
    expect(method).toMatch(/quietly reaches a broader or narrower group than intended/);
  });

  it('stops a capability gap being filed as a rejected option', () => {
    // "Considered and not used" means a choice between workable options.
    // The placeholder now also demands that a rejection be a MATERIALLY
    // different approach, not a tactical variation — "we considered sending
    // one fewer email" is not an alternative strategy.
    expect(SYSTEM).toMatch(/"rejected":\[\{"option":"<a materially different approach you CHOSE not to take>"/);
    expect(SYSTEM).toMatch(/Something the platform CANNOT do is not a decision/);
    expect(SYSTEM).toMatch(/reads as "we chose against this" when the truth is "we could not express this"/);
    expect(SYSTEM).toMatch(/keep it as the user's standing intent in "assumptions" or "unknowns"/);
  });

  it('forbids closing the gap with a near-enough attribute', () => {
    // MEASURED REGRESSION. Requiring the intended audience to be stated made
    // the agent close the gap instead of disclosing it: the blueprint entered
    // on Transaction Amount > 25000 and the summary called it an "outstanding
    // transaction above ₹25,000". It even labelled it a proxy in unknowns —
    // which does not make the targeting right, because the campaign still
    // enters the wrong people.
    const method = SYSTEM.slice(SYSTEM.indexOf('3. The business strategy'), SYSTEM.indexOf('4. The sequence'));
    expect(method).toMatch(/DO NOT CLOSE THAT GAP WITH A NEAR-ENOUGH ATTRIBUTE/);
    expect(method).toMatch(/a single event's value is not a running total/);
    expect(method).toMatch(/Calling it a proxy in a footnote does not make the targeting right/);
    expect(method).toMatch(/Leave the intended criterion unbuilt, say so, and let them decide/);
    expect(method).toMatch(/never describe the attribute you used in the words of the attribute you wanted/);
  });

  it('leaves the no-substitution rule intact', () => {
    // The adjacent protection: an absent attribute must not be swapped for a
    // loosely related one, which is how Transaction Amount could stand in for
    // a balance.
    expect(SYSTEM).toMatch(/do not substitute a loosely related attribute/);
  });
});
