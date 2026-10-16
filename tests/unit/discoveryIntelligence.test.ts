// Discovery behaviour: clarification vs evidence request vs recommendation.
//
// The problem these lock down: discovery behaved like a questionnaire — it
// could only ask questions or propose, so it had no way to request evidence,
// and no way to distinguish "I need a business definition" (blocking) from
// "data would help" (not blocking). Mocked model outcomes only; no API calls.
import { describe, it, expect } from 'vitest';
import { discovered } from './support/findings';
import {
  evaluateDiscovery,
  noteVolunteeredLimitation,
  newBrief,
  recordAnswer,
  recordQuestions,
  recordEvidenceRequests,
  resolveEvidence,
  recordFacts,
  briefForPrompt,
  readsAsDecline,
  recordDimensions,
  recordSuccessCriteria,
  type WorkingBrief,
} from '../../server/discovery';
/**
 * A brief whose dimensions were all considered.
 *
 * Discovery-first means the application refuses a strategy until something has
 * been considered and nothing is left 'open'. These suites were written to
 * probe OPEN-ITEM handling — which uncertainties block a strategy and which
 * are stated alongside it — so each fixture now carries a completed record,
 * which is also what a real propose turn carries. It also carries one answered
 * round and a settled success measure, because the gate now requires both
 * before a strategy is accepted — the agent cannot self-certify completeness on turn 1.
 * Enforcement itself is tested in discoveryEnforcement.test.ts.
 */
const considered = (b: WorkingBrief): WorkingBrief =>
  recordSuccessCriteria(
    recordAnswer(
      recordDimensions(discovered(b), [
        { name: 'Audience and eligibility', rationale: 'Who should enter the journey.', status: 'retained', basis: 'user' },
      ]),
      'Target customers with an open request.',
    ),
    ['Completed conversions among customers who entered.'],
  );



const EMI = 'Customers authorised for an EMI-eligible purchase are not converting. Get more of them to convert before the request expires.';
const gate = (over: Partial<Parameters<typeof evaluateDiscovery>[0]>) =>
  evaluateDiscovery({
    brief: considered(newBrief(EMI)),
    modelAction: 'propose',
    modelQuestions: [],
    modelEvidence: [],
    openItems: [],
    declaredUnknowns: [],
    forced: false,
    maxRounds: 8,
    ...over,
  });

const AMOUNT_EVIDENCE = {
  question: 'Does EMI conversion differ by outstanding transaction amount?',
  fields: ['amount bucket', 'authorised requests', 'converted requests'],
  grouping: 'amount bucket',
  period: 'last 90 days',
  wouldInform: 'Whether the campaign needs segmentation by transaction value.',
};

describe('1 & 6. material ambiguity produces a clarification, next to the strategy', () => {
  it('asks when a business definition is unresolved', () => {
    const d = gate({
      modelAction: 'propose',
      openItems: [
        { kind: 'strategic-ambiguity', question: 'Which New Status value marks a successfully converted EMI request' },
      ],
    });
    expect(d.outcome).toBe('strategy_with_questions');
    expect(d.questions[0]).toMatch(/status/i);
  });

  it('honours the kind the model declared, rather than re-reading its wording', () => {
    // The same sentence, classified two ways by the model, must behave two
    // ways. isEvidenceGap used to decide this from phrasing and got it
    // backwards on real strings in both directions.
    const sentence = 'Which status means the request expired';
    expect(gate({ openItems: [{ kind: 'strategic-ambiguity', question: sentence }] }).outcome).toBe(
      'strategy_with_questions',
    );
    expect(gate({ openItems: [{ kind: 'evidence-gap', question: sentence }] }).outcome).toBe('ready_for_strategy');
  });

  it('never turns message copy or CTA wording into a blocking question', () => {
    // The reported failure, exactly: the one open item put to the user was
    // "Can you confirm the exact message copy and CTA wording?", because the
    // old classifier read it as a material definition gap.
    const d = gate({
      modelAction: 'propose',
      openItems: [{ kind: 'optional-preference', question: 'The exact message copy and CTA wording', ifUnanswered: 'Draft copy per step.' }],
    });
    expect(d.outcome).toBe('ready_for_strategy');
    expect(d.questions).toEqual([]);
  });
});

describe('2. the agent can request specific aggregated data', () => {
  it('passes a well-formed evidence request through', () => {
    const d = gate({ modelAction: 'request_evidence', modelEvidence: [AMOUNT_EVIDENCE] });
    expect(d.outcome).toBe('request_evidence');
    expect(d.evidence).toHaveLength(1);
    expect(d.evidence[0].fields).toContain('authorised requests');
    expect(d.evidence[0].wouldInform).toMatch(/segmentation/i);
    expect(d.questions).toEqual([]);
  });

  it('caps a round at three requests', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ ...AMOUNT_EVIDENCE, question: `Question ${i} about rates` }));
    expect(gate({ modelAction: 'request_evidence', modelEvidence: many }).evidence).toHaveLength(3);
  });

  it('records the request so it is not repeated', () => {
    let b = newBrief(EMI);
    b = recordEvidenceRequests(b, [AMOUNT_EVIDENCE]);
    expect(b.evidenceRequests).toHaveLength(1);
    expect(b.evidenceRequests[0].status).toBe('pending');
    expect(b.rounds).toBe(1);
  });
});

describe('3 & 9. nothing already known or asked is asked again', () => {
  it('does not re-request data it already asked for', () => {
    let b = newBrief(EMI);
    b = recordEvidenceRequests(b, [AMOUNT_EVIDENCE]);
    const d = evaluateDiscovery({
      brief: b, modelAction: 'request_evidence', modelEvidence: [AMOUNT_EVIDENCE],
      modelQuestions: [], declaredUnknowns: [], forced: false, maxRounds: 8,
    });
    expect(d.outcome).toBe('ready_for_strategy');
    expect(d.overrodeModel).toBe(true);
    expect(d.reason).toMatch(/already been requested/i);
  });

  it('does not re-ask a question the user already answered', () => {
    let b = newBrief(EMI);
    b = recordQuestions(b, ['Which status marks a converted request?']);
    b = recordAnswer(b, 'Converted means New Status = Booked.');
    const d = evaluateDiscovery({
      brief: considered(b), modelAction: 'propose', modelQuestions: [], modelEvidence: [],
      declaredUnknowns: ['Which status marks a converted request'], forced: false, maxRounds: 8,
    });
    expect(d.outcome).toBe('ready_for_strategy');
  });

  it('the prompt carries everything settled, so the model cannot re-ask', () => {
    let b = newBrief(EMI);
    b = recordQuestions(b, ['Which status marks conversion?']);
    b = recordAnswer(b, 'New Status = Booked.');
    b = recordFacts(b, [{ statement: 'Entry status is Initiated', source: 'user-answer', round: 1 }]);
    b = recordEvidenceRequests(b, [AMOUNT_EVIDENCE]);
    b = resolveEvidence(b, 'We do not have that data.');

    const text = briefForPrompt(b);
    expect(text).toMatch(/do NOT ask about these again/);
    expect(text).toContain('Entry status is Initiated');
    expect(text).toContain('New Status = Booked.');
    expect(text).toMatch(/do NOT ask for this again/);
    expect(text).toMatch(/Limitations to carry into the strategy/);
  });
});

describe('4 & 5. an evidence gap never blocks a recommendation', () => {
  it('proposes despite unresolved evidence gaps, and says so', () => {
    const d = gate({
      modelAction: 'propose',
      openItems: [
        { kind: 'evidence-gap', question: 'Historical conversion rates by amount bucket', whyItMatters: 'It would settle segmentation.' },
        { kind: 'evidence-gap', question: 'Baseline performance of comparable campaigns' },
      ],
    });
    expect(d.outcome).toBe('ready_for_strategy');
    expect(d.reason).toMatch(/does not need|limitation|would like/i);
    // Carried, not discarded — the reply shows them beneath the strategy.
    expect(d.openItems).toHaveLength(2);
  });

  it('an optional preference is answered with a default rather than a question', () => {
    const d = gate({
      modelAction: 'propose',
      openItems: [{ kind: 'optional-preference', question: 'Preferred send hour', ifUnanswered: 'Mid-morning, outside quiet hours.' }],
    });
    expect(d.outcome).toBe('ready_for_strategy');
    expect(d.questions).toEqual([]);
    expect(d.openItems[0].ifUnanswered).toMatch(/quiet hours/i);
  });

  it('a material gap is asked even when evidence gaps are present, and both survive', () => {
    const d = gate({
      modelAction: 'propose',
      openItems: [
        { kind: 'evidence-gap', question: 'Historical conversion rates by amount' },
        { kind: 'strategic-ambiguity', question: 'Which status value marks an expired request' },
      ],
    });
    expect(d.outcome).toBe('strategy_with_questions');
    // Only the material one is put to the user...
    expect(d.questions).toHaveLength(1);
    expect(d.questions[0]).toMatch(/expired/i);
    // ...and the evidence gap is still carried for the reply.
    expect(d.openItems.map((i) => i.kind)).toContain('evidence-gap');
  });
});

describe('7. the user can decline, and the agent adapts', () => {
  it('recognises the many ways of saying "we do not have that"', () => {
    for (const t of [
      'We do not have that data.', "We don't track that.", 'Not available I am afraid.',
      'No historical data exists.', 'Please proceed without it.', 'We cannot provide that.',
    ]) {
      expect(readsAsDecline(t), t).toBe(true);
    }
    expect(readsAsDecline('Conversion was 12% in the 0-5000 bucket.')).toBe(false);
  });

  it('records a decline as a limitation and stops asking', () => {
    let b = newBrief(EMI);
    b = recordEvidenceRequests(b, [AMOUNT_EVIDENCE]);
    b = resolveEvidence(b, 'We do not have that data.');

    expect(b.evidenceRequests[0].status).toBe('unavailable');
    expect(b.limitations).toHaveLength(1);
    expect(b.limitations[0]).toMatch(/not available/i);
    // ...and the strategy is no longer blocked by it.
    const d = evaluateDiscovery({
      brief: considered(b), modelAction: 'propose', modelQuestions: [], modelEvidence: [],
      declaredUnknowns: ['Historical conversion rates by amount bucket'], forced: false, maxRounds: 8,
    });
    expect(d.outcome).toBe('ready_for_strategy');
  });

  it('records supplied data as a fact rather than a limitation', () => {
    let b = newBrief(EMI);
    b = recordEvidenceRequests(b, [AMOUNT_EVIDENCE]);
    b = resolveEvidence(b, 'Under 5k: 18% converted. Over 25k: 4% converted.');

    expect(b.evidenceRequests[0].status).toBe('supplied');
    expect(b.evidenceRequests[0].suppliedSummary).toMatch(/18%/);
    expect(b.limitations).toHaveLength(0);
    expect(b.facts.some((f) => f.source === 'user-answer' && /18%/.test(f.statement))).toBe(true);
  });
});

describe('volunteered limitations are captured too', () => {
  it('records "we have no data" even when nothing was formally requested', () => {
    // A live run surfaced this: the user volunteered that no historical data
    // exists in a normal answer. The agent correctly stopped relying on it,
    // but the constraint was not written to the brief, so it survived only
    // in prose.
    const b = noteVolunteeredLimitation(
      newBrief(EMI),
      'We have no historical conversion data at all — none by amount, channel or time.',
    );
    expect(b.limitations).toHaveLength(1);
    expect(b.limitations[0]).toMatch(/Stated as unavailable by the user/);
  });

  it('ignores an ordinary answer that is not about missing data', () => {
    const b = noteVolunteeredLimitation(newBrief(EMI), 'Conversion means New Status = Booked.');
    expect(b.limitations).toHaveLength(0);
  });

  it('does not duplicate the same limitation', () => {
    let b = newBrief(EMI);
    const text = 'We do not have any historical data for that.';
    b = noteVolunteeredLimitation(b, text);
    b = noteVolunteeredLimitation(b, text);
    expect(b.limitations).toHaveLength(1);
  });
});

describe('8. the brief accumulates and nothing is discarded', () => {
  it('keeps earlier answers, facts and limitations across rounds', () => {
    let b = newBrief(EMI);
    b = recordQuestions(b, ['Which status starts the journey?']);
    b = recordAnswer(b, 'Initiated.');
    b = recordFacts(b, [{ statement: 'Goal is New Status = Booked', source: 'user-answer', round: 1 }]);
    b = recordEvidenceRequests(b, [AMOUNT_EVIDENCE]);
    b = resolveEvidence(b, 'We have no such data.');
    b = recordQuestions(b, ['Should dormant cards be excluded?']);
    b = recordAnswer(b, 'Yes, exclude them.');

    expect(b.answers).toHaveLength(2);
    expect(b.answers[0].text).toBe('Initiated.');
    expect(b.facts.some((f) => /Booked/.test(f.statement))).toBe(true);
    expect(b.limitations).toHaveLength(1);
    expect(b.questions).toHaveLength(2);
    expect(b.objective).toBe(EMI);
  });

  it('does not duplicate a fact already recorded', () => {
    let b = newBrief(EMI);
    const fact = { statement: 'Entry status is Initiated', source: 'user-answer' as const, round: 1 };
    b = recordFacts(b, [fact]);
    b = recordFacts(b, [{ ...fact, round: 2 }]);
    expect(b.facts).toHaveLength(1);
  });
});

describe('10 & 11. an evidence request is not a confirmation', () => {
  it('request_evidence is a discovery outcome, never a build signal', () => {
    const d = gate({ modelAction: 'request_evidence', modelEvidence: [AMOUNT_EVIDENCE] });
    expect(d.outcome).toBe('request_evidence');
    expect(['ask_questions', 'request_evidence']).toContain(d.outcome);
    expect(d.outcome).not.toBe('ready_for_strategy');
  });

  it('the orchestrator returns discovery phase for an evidence request', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8'),
    );
    const block = src.slice(
      src.indexOf("if (gate.outcome === 'request_evidence')"),
      src.indexOf("if (gate.outcome === 'ask_questions')"),
    );
    expect(block).toMatch(/phase: 'discovery'/);
    // Nothing is built on this path.
    expect(block).not.toMatch(/buildAndValidate\(/);
    // ...and the user is told it is optional.
    expect(block).toMatch(/not a prerequisite/i);
  });
});

describe('a round is one coherent move, not a questionnaire', () => {
  it('never mixes questions and data requests in the same round', () => {
    const d = gate({
      modelAction: 'request_evidence',
      modelQuestions: ['Something else entirely?'],
      modelEvidence: [AMOUNT_EVIDENCE],
    });
    expect(d.outcome).toBe('request_evidence');
    expect(d.questions).toEqual([]);
  });

  it('asks nothing when the brief is already sufficient', () => {
    const d = gate({ modelAction: 'propose', declaredUnknowns: [] });
    expect(d.outcome).toBe('ready_for_strategy');
    expect(d.questions).toEqual([]);
    expect(d.evidence).toEqual([]);
    expect(d.overrodeModel).toBe(false);
  });

  it('a forced proposal skips both questions and data requests', () => {
    const d = gate({
      modelAction: 'request_evidence', modelEvidence: [AMOUNT_EVIDENCE], forced: true,
    });
    expect(d.outcome).toBe('ready_for_strategy');
    expect(d.reason).toMatch(/asked to proceed/i);
  });

  it('the round limit ends discovery even mid-request', () => {
    const b: WorkingBrief = { ...newBrief(EMI), rounds: 8 };
    const d = evaluateDiscovery({
      brief: b, modelAction: 'request_evidence', modelEvidence: [AMOUNT_EVIDENCE],
      modelQuestions: [], declaredUnknowns: [], forced: false, maxRounds: 8,
    });
    expect(d.outcome).toBe('ready_for_strategy');
  });
});
