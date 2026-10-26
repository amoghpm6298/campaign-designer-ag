// The discovery gate and the campaign state machine.
//
// ROOT CAUSE these lock down: the only thing deciding "ask more questions"
// vs "propose a strategy" was the model's own `action` field. A model that
// opened with action:"propose" skipped discovery entirely, so the prompt was
// the sole constraint. These tests use mocked model outcomes — no API calls —
// so the gate is proven deterministically.
import { describe, it, expect } from 'vitest';
import { discovered } from './support/findings';
import {
  evaluateDiscovery,
  newBrief,
  recordAnswer,
  recordQuestions,
  objectiveChangedMaterially,
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


import {
  canTransition,
  transition,
  mayGenerate,
  newSession,
  invalidateConfirmation,
  IllegalTransitionError,
  type CampaignState,
} from '../../server/campaignState';

const EMI = 'Customers authorised for an EMI-eligible purchase are not converting. Get more of them to convert before the request expires.';
const gate = (over: Partial<Parameters<typeof evaluateDiscovery>[0]>) =>
  evaluateDiscovery({
    brief: considered(newBrief(EMI)),
    modelAction: 'propose',
    modelQuestions: [],
    declaredUnknowns: [],
    forced: false,
    maxRounds: 8,
    ...over,
  });

describe('1. a brief with material uncertainty gets questions ALONGSIDE the strategy', () => {
  it('asks about a model proposal\'s own open items without discarding it', () => {
    // Phase 2 changed this deliberately. The old behaviour converted the turn
    // into questions and the orchestrator returned with strategy and
    // blueprint null, destroying a complete recommendation for being honest
    // about its limits. The questions still get asked; the strategy survives.
    const d = gate({
      modelAction: 'propose',
      declaredUnknowns: [
        'Whether a pending EMI request is identified by status or by absence of a conversion event',
        'What exactly counts as a successful conversion',
      ],
    });
    expect(d.outcome).toBe('strategy_with_questions');
    expect(d.outcome).not.toBe('ask_questions');
    expect(d.overrodeModel).toBe(false);
    expect(d.questions.length).toBeGreaterThan(0);
    expect(d.questions[0]).toMatch(/\?$/);
  });

  it("turns the agent's own unknowns into readable questions", () => {
    const d = gate({ modelAction: 'propose', declaredUnknowns: ['Whether the expiry window is 7 days'] });
    expect(d.questions[0]).toBe('Can you confirm whether the expiry window is 7 days?');
  });

  it('asks at most three, however many unknowns there are', () => {
    const d = gate({
      modelAction: 'propose',
      declaredUnknowns: ['one thing', 'two thing', 'three thing', 'four thing', 'five thing'],
    });
    expect(d.questions).toHaveLength(3);
  });
});

describe('2. ask_questions cannot reach graph construction', () => {
  it('discovering may never transition straight to generating', () => {
    expect(canTransition('DISCOVERING', 'GENERATING_CAMPAIGN')).toBe(false);
    expect(() => transition('DISCOVERING', 'GENERATING_CAMPAIGN')).toThrow(IllegalTransitionError);
  });

  it('awaiting an answer may never transition straight to generating', () => {
    expect(canTransition('AWAITING_USER_ANSWER', 'GENERATING_CAMPAIGN')).toBe(false);
  });

  it('only awaiting-confirmation opens the door to generation', () => {
    const states: CampaignState[] = [
      'UNDERSTANDING_GOAL', 'DISCOVERING', 'AWAITING_USER_ANSWER', 'STRATEGY_READY',
      'AWAITING_STRATEGY_CONFIRMATION', 'CAMPAIGN_REVIEW', 'CONFIGURATION_INCOMPLETE', 'EXPORT_ELIGIBLE',
    ];
    expect(states.filter((s) => canTransition(s, 'GENERATING_CAMPAIGN'))).toEqual([
      'AWAITING_STRATEGY_CONFIRMATION', 'CAMPAIGN_REVIEW', 'CONFIGURATION_INCOMPLETE', 'EXPORT_ELIGIBLE',
    ]);
  });

  it('generation is refused without a recorded confirmation', () => {
    const s = { ...newSession(), state: 'AWAITING_STRATEGY_CONFIRMATION' as CampaignState };
    const r = mayGenerate(s, newBrief(EMI).objectiveFingerprint);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/No strategy has been confirmed/);
  });
});

describe('3-5. answers are recorded, used, and not repeated', () => {
  it('records questions against the round they were asked in', () => {
    let b = newBrief(EMI);
    b = recordQuestions(b, ['How is a pending request identified?']);
    expect(b.rounds).toBe(1);
    expect(b.questions[0].askedInRound).toBe(1);
    expect(b.questions[0].answeredInRound).toBeUndefined();
  });

  it('records the answer and marks the question answered', () => {
    let b = newBrief(EMI);
    b = recordQuestions(b, ['How is a pending request identified?']);
    b = recordAnswer(b, 'By EMI request status staying Initiated for more than 24 hours.');
    expect(b.answers).toHaveLength(1);
    expect(b.answers[0].text).toMatch(/Initiated/);
    expect(b.questions[0].answeredInRound).toBeDefined();
  });

  it('does not re-ask something the user already answered', () => {
    let b = newBrief(EMI);
    b = recordQuestions(b, ['How is a pending EMI request identified?']);
    b = recordAnswer(b, 'A pending EMI request is identified by status Initiated.');
    const d = evaluateDiscovery({
      brief: considered(b), modelAction: 'propose', modelQuestions: [],
      declaredUnknowns: ['How a pending EMI request is identified'],
      forced: false, maxRounds: 8,
    });
    expect(d.outcome).toBe('ready_for_strategy');
    expect(d.reason).toMatch(/answers resolved/i);
  });

  it('asks a DIFFERENT question when a new uncertainty appears', () => {
    let b = newBrief(EMI);
    b = recordQuestions(b, ['How is a pending EMI request identified?']);
    b = recordAnswer(b, 'By status Initiated.');
    const d = evaluateDiscovery({
      brief: considered(b), modelAction: 'propose', modelQuestions: [],
      declaredUnknowns: ['What counts as a successful conversion outcome'],
      forced: false, maxRounds: 8,
    });
    expect(d.outcome).toBe('strategy_with_questions');
    expect(d.questions[0]).toMatch(/successful conversion/i);
    expect(d.questions[0]).not.toMatch(/pending EMI request is identified/);
  });
});

describe('6 & 9. discovery ends when there is enough information', () => {
  it('a model with no declared unknowns proceeds without interrogation', () => {
    const d = gate({ modelAction: 'propose', declaredUnknowns: [] });
    expect(d.outcome).toBe('ready_for_strategy');
    expect(d.questions).toEqual([]);
    expect(d.overrodeModel).toBe(false);
  });

  it('the user can force a proposal, carrying the unknowns forward', () => {
    const d = gate({ modelAction: 'propose', declaredUnknowns: ['anything at all'], forced: true });
    expect(d.outcome).toBe('ready_for_strategy');
    expect(d.reason).toMatch(/asked to proceed/i);
  });

  it('the round limit ends discovery rather than looping for ever', () => {
    const b: WorkingBrief = { ...newBrief(EMI), rounds: 8 };
    const d = evaluateDiscovery({
      brief: b, modelAction: 'ask', modelQuestions: ['one more?'],
      declaredUnknowns: [], forced: false, maxRounds: 8,
    });
    expect(d.outcome).toBe('ready_for_strategy');
    expect(d.overrodeModel).toBe(true);
  });

  it('never turns the model\'s "ask" into "ready" inside the budget', () => {
    const d = gate({ modelAction: 'ask', modelQuestions: ['Which programs?'] });
    expect(d.outcome).toBe('ask_questions');
    expect(d.questions).toEqual(['Which programs?']);
  });
});

describe('7. a strategy proposal does not generate a graph', () => {
  it('reaching STRATEGY_READY does not authorise generation', () => {
    let s = newSession();
    s = { ...s, state: transition(s.state, 'DISCOVERING') };
    s = { ...s, state: transition(s.state, 'STRATEGY_READY') };
    expect(canTransition(s.state, 'GENERATING_CAMPAIGN')).toBe(false);
    expect(mayGenerate(s, 'x').ok).toBe(false);
  });

  it('generation is permitted only once confirmation is recorded', () => {
    const b = newBrief(EMI);
    let s = { ...newSession(), state: 'AWAITING_STRATEGY_CONFIRMATION' as CampaignState, strategyVersion: 1 };
    expect(mayGenerate(s, b.objectiveFingerprint).ok).toBe(false);
    s = { ...s, confirmation: { objectiveFingerprint: b.objectiveFingerprint, strategyVersion: 1, confirmedAt: 'now' } };
    expect(mayGenerate(s, b.objectiveFingerprint).ok).toBe(true);
  });
});

describe('8. a materially changed brief invalidates an old confirmation', () => {
  it('detects a different objective, and tolerates rewording', () => {
    expect(objectiveChangedMaterially(EMI, 'Reactivate dormant cards with no transaction in 90 days.')).toBe(true);
    expect(objectiveChangedMaterially(EMI, 'Customers authorised for an EMI-eligible purchase are not converting before expiry.')).toBe(false);
  });

  it('a confirmation for the old objective authorises nothing', () => {
    const oldBrief = newBrief(EMI);
    const changed = newBrief('Reactivate dormant cards with no transaction in 90 days.');
    const s = {
      ...newSession(), state: 'AWAITING_STRATEGY_CONFIRMATION' as CampaignState, strategyVersion: 1,
      confirmation: { objectiveFingerprint: oldBrief.objectiveFingerprint, strategyVersion: 1, confirmedAt: 'then' },
    };
    const r = mayGenerate(s, changed.objectiveFingerprint);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/objective changed/i);
  });

  it('a new strategy version supersedes a confirmation of the previous one', () => {
    const b = newBrief(EMI);
    const s = {
      ...newSession(), state: 'AWAITING_STRATEGY_CONFIRMATION' as CampaignState, strategyVersion: 2,
      confirmation: { objectiveFingerprint: b.objectiveFingerprint, strategyVersion: 1, confirmedAt: 'then' },
    };
    const r = mayGenerate(s, b.objectiveFingerprint);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/strategy changed/i);
  });

  it('invalidateConfirmation clears it outright', () => {
    const s = invalidateConfirmation({
      ...newSession(),
      confirmation: { objectiveFingerprint: 'x', strategyVersion: 1, confirmedAt: 'then' },
    });
    expect(s.confirmation).toBeNull();
  });
});

describe('the orchestrator wires the gate in, not the model', () => {
  it("decides via evaluateDiscovery, never via the model's action alone", async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/const gate = evaluateDiscovery\(/);
    expect(src).toMatch(/if \(gate\.outcome === 'ask_questions'\)/);
    expect(src).not.toMatch(/parsed\.value\.action === 'ask' && !limitReached/);
    expect(src).toMatch(/mayGenerate\(session, brief\.objectiveFingerprint\)/);
  });

  it('treats a message as an ANSWER when a question is outstanding', async () => {
    // A live run wiped the brief: an answer shares almost no vocabulary with
    // the objective, so the changed-objective check fired on every answer.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/const awaitingAnswer = outstanding\(brief\)\.length > 0/);
    // THE ONE WRITE. `recordAnswer` set `answeredInRound` only, while
    // `outstanding` and `decide` read `addressedInRound` — two fields, two
    // write-paths, and `eval/runs/ui-s-1792839251135` held three turns of
    // settled discovery on `awaiting-reply`. `receive` records the answer and
    // closes what was on screen in the same write.
    expect(src).toMatch(/if \(awaitingAnswer\) \{[\s\S]{0,900}?brief = receive\(brief, latestUserText\)\.brief;/);
    expect(src).not.toMatch(/brief = recordAnswer\(brief, latestUserText\)/);
  });
});

describe('the confirm path cannot self-certify a stale confirmation', () => {
  it('stamps the confirmation only when it belongs to the current brief', async () => {
    // A live run exposed this: the confirm path WROTE a confirmation using
    // the current fingerprint and then checked it, so the staleness test
    // compared a value against itself and always passed. A confirmation
    // given for one objective then built a campaign for a different one.
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/briefMatchesStrategy/);
    // The confirmation is conditional, not unconditional.
    expect(src).toMatch(/confirmation: briefMatchesStrategy\s*\?/);
    // ...and the refusal names the cause.
    expect(src).toMatch(/objective changed after this strategy was proposed/i);
  });

  it('routes every state change through a legal transition', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8'),
    );
    // UNDERSTANDING_GOAL -> AWAITING_USER_ANSWER is illegal; the code must
    // hop through DISCOVERING. A live run threw IllegalTransitionError here.
    expect(src).toMatch(/session\.state === 'DISCOVERING' \? session\.state : transition\(session\.state, 'DISCOVERING'\)/);
    expect(src).toMatch(/transition\(toStrategyReady, 'AWAITING_STRATEGY_CONFIRMATION'\)/);
  });
});
