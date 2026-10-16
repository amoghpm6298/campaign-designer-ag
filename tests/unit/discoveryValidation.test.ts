// Regressions for failures found by running real conversations end to end.
//
// Each test below reproduces something a live model run actually did wrong.
// None of these was caught by the existing suite, which is why running the
// product mattered more than the tests passing.
import { describe, it, expect } from 'vitest';
import { discovered } from './support/findings';
import { canTransition, transition, type CampaignState } from '../../server/campaignState';
import { readFileSync } from 'node:fs';
import {
  noteVolunteeredLimitation,
  newBrief,
  evaluateDiscovery,
  recordQuestions,
  recordAnswer,
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



describe('F1 — an open item\'s importance comes from the model, not from its wording', () => {
  // Scenario A, round 2. The agent asked, as a BLOCKING clarification:
  // "Can you confirm whether any response-rate data by channel exists?" That
  // is an evidence gap. isEvidenceGap was taught to recognise that phrasing
  // and a dozen others, and still got real strings backwards in BOTH
  // directions. Phase 2 stopped guessing: the model declares the kind.
  const gate = (openItems: Parameters<typeof evaluateDiscovery>[0]['openItems']) =>
    evaluateDiscovery({
      brief: considered(newBrief('Increase EMI conversions')),
      modelAction: 'propose',
      modelQuestions: [],
      modelEvidence: [],
      openItems,
      forced: false,
      maxRounds: 8,
    });

  it('an evidence gap never blocks, whatever words it uses', () => {
    for (const q of [
      'any response-rate data by channel or time-since-transaction exists',
      'counts of authorised requests',
      'What counts as successful conversion',
    ]) {
      expect(gate([{ kind: 'evidence-gap', question: q }]).outcome, q).toBe('ready_for_strategy');
    }
  });

  it('a strategic ambiguity is always asked, whatever words it uses', () => {
    for (const q of [
      'Which status value marks a converted request',
      'Whether the expiry window is 7 days',
      'how many distinct journeys count as one conversion',
    ]) {
      expect(gate([{ kind: 'strategic-ambiguity', question: q }]).outcome, q).toBe('strategy_with_questions');
    }
  });
});

describe('F2 — retrieved context no longer retires a question', () => {
  // The inverse of what this block used to assert, and the reason it changed.
  //
  // isAnsweredByContext suppressed an open item when enough of its words
  // appeared in the retrieved context. Because the vocabulary enumerates every
  // event category and entity, "should the entry be a Transaction event or an
  // EMI Request event?" matched 4 of 4 words and was silently dropped — the
  // one question that would have prevented the EMI failure. A term appearing
  // in a capability listing is not a value.
  const ask = (question: string) =>
    evaluateDiscovery({
      brief: considered(newBrief('Increase EMI conversions')),
      modelAction: 'propose',
      modelQuestions: [],
      modelEvidence: [],
      openItems: [{ kind: 'strategic-ambiguity', question }],
      forced: false,
      maxRounds: 8,
    });

  it('still asks a question whose every word appears in the retrieved context', () => {
    const d = ask('Whether entry should be a Transaction event or an EMI Request event');
    expect(d.outcome).toBe('strategy_with_questions');
    expect(d.questions).toHaveLength(1);
  });

  it('the gate takes no retrieved context at all any more', () => {
    // Structural: there is no parameter to pass it through, so a word-overlap
    // suppressor cannot be reintroduced by accident.
    const src = readFileSync(new URL('../../server/discovery.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/retrievedContext/);
    expect(src).not.toMatch(/export function isAnsweredByContext/);
    expect(src).not.toMatch(/export function isEvidenceGap/);
  });

  it('a question the USER answered is still retired', () => {
    // The legitimate half of the old behaviour, kept: what the user said
    // settles things, and is now the only thing that does.
    let b = newBrief('Increase EMI conversions');
    b = recordQuestions(b, ['Which status value means the request converted?']);
    b = recordAnswer(b, 'Converted means New Status = Successful.');
    const d = evaluateDiscovery({
      brief: considered(b), modelAction: 'propose', modelQuestions: [], modelEvidence: [],
      openItems: [{ kind: 'strategic-ambiguity', question: 'which status value means the request converted' }],
      forced: false, maxRounds: 8,
    });
    expect(d.outcome).toBe('ready_for_strategy');
    expect(d.questions).toEqual([]);
  });
});

describe('F3 — a limitation stated in the opening brief', () => {
  // Scenarios D and E. The user said "we have no historical conversion data
  // of any kind" in their FIRST message. Capture only ran on follow-up
  // turns, so the brief recorded no limitation at all and the constraint
  // survived only in the model's prose.
  it('captures "no data" volunteered in the first message', () => {
    const objective =
      'Nudge EMI conversion before expiry. We have no historical conversion data of any kind — none by amount, channel or timing.';
    const b = noteVolunteeredLimitation(newBrief(objective), objective);
    expect(b.limitations).toHaveLength(1);
    expect(b.limitations[0]).toMatch(/Stated as unavailable by the user/);
  });

  it('leaves an ordinary objective untouched', () => {
    const objective = 'Nudge customers to convert an EMI-eligible purchase before it expires.';
    expect(noteVolunteeredLimitation(newBrief(objective), objective).limitations).toHaveLength(0);
  });

  it('the orchestrator applies it when the brief is first created', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8'),
    );
    expect(src).toMatch(/req\.brief \?\? noteVolunteeredLimitation\(newBrief\(firstUserText\), firstUserText\)/);
    // ...and the gate is given the model's own classification of what is open,
    // not the retrieved context it used to score questions against.
    expect(src).toMatch(/openItems: proposed\?\.openItems/);
    expect(src).not.toMatch(/retrievedContext:/);
  });
});

describe('F4 — the fully-configured happy path', () => {
  // Supplying real account and template IDs made the campaign exportable on
  // first generation. GENERATING_CAMPAIGN -> EXPORT_ELIGIBLE was missing
  // from the transition table, so the run died with
  // "Illegal state transition GENERATING_CAMPAIGN -> EXPORT_ELIGIBLE".
  // Every earlier live run had unresolved Sends, so only the
  // CONFIGURATION_INCOMPLETE branch had ever been taken.
  it('a generated campaign may become exportable directly', () => {
    expect(canTransition('GENERATING_CAMPAIGN', 'EXPORT_ELIGIBLE')).toBe(true);
    expect(() => transition('GENERATING_CAMPAIGN', 'EXPORT_ELIGIBLE')).not.toThrow();
  });

  it('both outcomes of generation are reachable', () => {
    for (const to of ['CONFIGURATION_INCOMPLETE', 'EXPORT_ELIGIBLE'] as CampaignState[]) {
      expect(canTransition('GENERATING_CAMPAIGN', to), to).toBe(true);
    }
  });

  it('generation still cannot skip back into discovery states', () => {
    expect(canTransition('GENERATING_CAMPAIGN', 'DISCOVERING')).toBe(false);
    expect(canTransition('GENERATING_CAMPAIGN', 'AWAITING_USER_ANSWER')).toBe(false);
  });
});
