// Two checks against the BUILT journey, not against the summary.
//
// Both exist because a prompt instruction to "address what you learned" reads
// as satisfied by a paragraph of prose while the steps do nothing. These read
// the steps.
import { describe, it, expect } from 'vitest';
import { checkBarrierCoverage, checkAudienceLearning } from '../../server/architectureAudit';
import type { CampaignBlueprint, BpStep } from '../../server/blueprint';

const send = (name: string, barrier?: string): BpStep =>
  ({ kind: 'send', name, objective: ['convert'], stage: 'first-touch', describe: 'd', barrier }) as BpStep;

const bp = (steps: BpStep[]): CampaignBlueprint =>
  ({ name: 'C', entry: { kind: 'audience', entity: 'Customer', conditions: [] }, steps }) as unknown as CampaignBlueprint;

const COST = { id: 'cost-perception', statement: 'They think EMI is expensive.' };
const UNAWARE = { id: 'unaware', statement: 'They do not know the option exists.' };

describe('every message attacks a stated reason', () => {
  it('passes when each send cites one', () => {
    const r = checkBarrierCoverage(bp([send('Reframe cost', 'cost-perception')]), [COST]);
    expect(r.uncitedSends).toEqual([]);
    expect(r.unaddressed).toEqual([]);
  });

  it('names a send that cites nothing', () => {
    // "One more reminder" is the usual form of this.
    const r = checkBarrierCoverage(bp([send('Reframe cost', 'cost-perception'), send('Reminder')]), [COST]);
    expect(r.uncitedSends).toEqual(['Reminder']);
  });

  it('matches the citation case-insensitively, because a model writes it', () => {
    const r = checkBarrierCoverage(bp([send('x', 'Cost-Perception')]), [COST]);
    expect(r.unaddressed).toEqual([]);
  });

  it('finds sends nested inside a branch', () => {
    const steps: BpStep[] = [
      {
        kind: 'branch',
        label: 'By spend',
        entity: 'Transaction',
        attribute: 'Transaction Amount',
        paths: [
          { label: 'Large', operator: 'Greater than', value: '25000', steps: [send('Big', 'cost-perception')] },
          { label: 'Small', operator: 'Less than', value: '25000', steps: [send('Small')] },
        ],
      } as unknown as BpStep,
    ];
    const r = checkBarrierCoverage(bp(steps), [COST]);
    expect(r.uncitedSends).toEqual(['Small']);
  });

  it('finds sends nested inside an experiment arm', () => {
    const steps: BpStep[] = [
      {
        kind: 'experiment',
        label: 'Why',
        tests: 'explanation',
        arms: [
          { label: 'A', pct: 50, steps: [send('Cost framing', 'cost-perception')] },
          { label: 'B', pct: 50, steps: [send('Awareness framing')] },
        ],
      } as unknown as BpStep,
    ];
    expect(checkBarrierCoverage(bp(steps), [COST]).uncitedSends).toEqual(['Awareness framing']);
  });
});

describe('every stated reason is attacked', () => {
  it('reports a reason the campaign quietly ignored', () => {
    // The worse half of the check: the manager RAISED this, and the campaign
    // did nothing about it while looking busy.
    const r = checkBarrierCoverage(bp([send('Reframe cost', 'cost-perception')]), [COST, UNAWARE]);
    expect(r.unaddressed.map((b) => b.id)).toEqual(['unaware']);
  });

  it('is satisfied when both reasons are attacked', () => {
    const r = checkBarrierCoverage(
      bp([send('Reframe cost', 'cost-perception'), send('Tell them it exists', 'unaware')]),
      [COST, UNAWARE],
    );
    expect(r.unaddressed).toEqual([]);
  });

  it('owes nothing when the caller passes no barriers', () => {
    // mustBeAddressed already filters out invented and unaddressable ones, so
    // an empty list here is the legitimate "nothing is owed" case.
    expect(checkBarrierCoverage(bp([send('x', 'y')]), []).unaddressed).toEqual([]);
  });
});

describe('a campaign for customers nobody can characterise must separate them', () => {
  const flat = bp([send('Opening', 'cost-perception')]);

  it('does not apply when the manager described who converts', () => {
    expect(checkAudienceLearning(flat, false)).toBeNull();
  });

  it('refuses a flat journey when nobody could say who converts', () => {
    const msg = checkAudienceLearning(flat, true);
    expect(msg).toContain('has to find out');
  });

  it('accepts an experiment that tests audience', () => {
    const steps: BpStep[] = [
      {
        kind: 'experiment',
        label: 'Who',
        tests: 'audience',
        arms: [
          { label: 'Big-ticket', pct: 50, steps: [send('a', 'cost-perception')] },
          { label: 'Revolvers', pct: 50, steps: [send('b', 'cost-perception')] },
        ],
      } as unknown as BpStep,
    ];
    expect(checkAudienceLearning(bp(steps), true)).toBeNull();
  });

  it('does NOT accept an experiment that only tests wording', () => {
    // Which words worked says nothing about which customers converted.
    const steps: BpStep[] = [
      {
        kind: 'experiment',
        label: 'Wording',
        tests: 'wording',
        arms: [
          { label: 'A', pct: 50, steps: [send('a', 'cost-perception')] },
          { label: 'B', pct: 50, steps: [send('b', 'cost-perception')] },
        ],
      } as unknown as BpStep,
    ];
    expect(checkAudienceLearning(bp(steps), true)).toContain('has to find out');
  });

  it('accepts a branch, which separates groups just as an audience test does', () => {
    const steps: BpStep[] = [
      {
        kind: 'branch',
        label: 'By spend',
        entity: 'Transaction',
        attribute: 'Transaction Amount',
        paths: [
          { label: 'Large', operator: 'Greater than', value: '25000', steps: [send('a', 'cost-perception')] },
          { label: 'Small', operator: 'Less than', value: '25000', steps: [send('b', 'cost-perception')] },
        ],
      } as unknown as BpStep,
    ];
    expect(checkAudienceLearning(bp(steps), true)).toBeNull();
  });

  it('accepts a condition on a customer attribute', () => {
    const steps: BpStep[] = [
      {
        kind: 'condition',
        label: 'Active?',
        on: { entity: 'Account', attribute: 'Status', operator: 'Equals', value: 'Active' },
        yes: [send('a', 'cost-perception')],
        no: [send('b', 'cost-perception')],
      } as unknown as BpStep,
    ];
    expect(checkAudienceLearning(bp(steps), true)).toBeNull();
  });

  it('does NOT accept a condition on the last message\'s delivery outcome', () => {
    // That splits on what the SYSTEM did, not on who the customer is, so it
    // cannot tell you which segment converts.
    const steps: BpStep[] = [
      {
        kind: 'condition',
        label: 'Delivered?',
        outcomes: ['DELIVERED'],
        yes: [send('a', 'cost-perception')],
        no: [send('b', 'cost-perception')],
      } as unknown as BpStep,
    ];
    expect(checkAudienceLearning(bp(steps), true)).toContain('has to find out');
  });
});
