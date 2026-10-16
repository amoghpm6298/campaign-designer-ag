// The comparator judges every counterfactual result, so it is tested first.
//
// The failure mode being guarded against has already happened once in this
// codebase: the option auditor reported a defect that was not there, because
// it compared the wrong two things. A comparator that reports "these campaigns
// differ" whenever the wording differs would make every counterfactual pass
// and the whole harness worthless. Test 1 is that case.
import { describe, it, expect } from 'vitest';
import { signature, compare, experimentArms } from '../../eval/divergence';
import type { CampaignBlueprint, BpStep } from '../../server/blueprint';

const send = (over: Partial<Extract<BpStep, { kind: 'send' }>> = {}): BpStep => ({
  kind: 'send',
  name: 'Touch 1',
  objective: ['emi', 'awareness'],
  stage: 'first-touch',
  describe: 'Tell the customer their balance qualifies',
  copy: 'Hi there, your balance qualifies for EMI.',
  ...over,
});

const base = (over: Partial<CampaignBlueprint> = {}): CampaignBlueprint => ({
  campaignName: 'OS to EMI',
  description: 'Convert eligible balances',
  goal: { eventCategory: 'EMI Events', eventType: 'EMI Request' },
  entry: { kind: 'audience', entity: 'Account', conditions: [{ attribute: 'Status', operator: 'Equals', value: 'Active' }] },
  steps: [send(), { kind: 'wait', durationHours: 48 }, send({ name: 'Touch 2', stage: 'reminder' })],
  ...over,
});

describe('signature excludes everything cosmetic', () => {
  it('reads two campaigns that differ only in wording as identical', () => {
    const a = base();
    const b = base({
      campaignName: 'EMI Conversion Drive',
      description: 'A completely differently worded description',
      steps: [
        send({ name: 'Opening nudge', describe: 'Different words entirely', copy: 'Totally different copy here.', cta: 'Convert now' }),
        { kind: 'wait', durationHours: 48, why: 'a reason the other one did not give' },
        send({ name: 'Second nudge', stage: 'reminder', describe: 'Also reworded', copy: 'More different copy.' }),
      ],
    });
    const r = compare(a, b, ['audience', 'timing', 'shape', 'entry']);
    expect(r.identical).toBe(true);
    expect(r.verdict).toBe('identical');
    expect(r.met).toEqual([]);
  });

  it('treats reordered entry conditions as the same audience', () => {
    const cs = [
      { attribute: 'Status', operator: 'Equals', value: 'Active' },
      { attribute: 'EMI Eligible', operator: 'Equals', value: 'Yes' },
    ];
    const a = base({ entry: { kind: 'audience', entity: 'Account', conditions: cs } });
    const b = base({ entry: { kind: 'audience', entity: 'Account', conditions: [...cs].reverse() } });
    expect(signature(a).audience).toBe(signature(b).audience);
  });

  it('treats reordered experiment arms as the same cadence', () => {
    const arms = [
      { label: 'A', pct: 50, steps: [send()] },
      { label: 'B', pct: 50, steps: [send({ stage: 'reminder' })] },
    ];
    const a = base({ steps: [{ kind: 'experiment', label: 'test', arms }] });
    const b = base({ steps: [{ kind: 'experiment', label: 'test', arms: [...arms].reverse() }] });
    expect(signature(a).timing).toBe(signature(b).timing);
  });
});

describe('signature catches what a customer would actually experience', () => {
  it('sees a different entry entity', () => {
    const a = base();
    const b = base({ entry: { kind: 'audience', entity: 'Customer', conditions: [{ attribute: 'Status', operator: 'Equals', value: 'Active' }] } });
    const r = compare(a, b, ['entry']);
    expect(r.aspects.find((x) => x.aspect === 'entry')!.differs).toBe(true);
    expect(r.verdict).toBe('diverged');
  });

  it('sees an event entry against an audience pull', () => {
    const a = base();
    const b = base({ entry: { kind: 'event', eventCategory: 'Transaction Events', eventType: 'Transaction' } });
    expect(signature(a).entry).not.toBe(signature(b).entry);
  });

  it('sees a narrowed audience', () => {
    const a = base();
    const b = base({
      entry: {
        kind: 'audience',
        entity: 'Account',
        conditions: [
          { attribute: 'Status', operator: 'Equals', value: 'Active' },
          { attribute: 'Transaction Amount', operator: 'Greater than', value: '25000' },
        ],
      },
    });
    expect(signature(a).audience).not.toBe(signature(b).audience);
  });

  it('sees a different cadence', () => {
    const a = base();
    const b = base({ steps: [send(), { kind: 'wait', durationHours: 168 }, send({ stage: 'reminder' })] });
    const r = compare(a, b, ['timing']);
    expect(r.met).toEqual(['timing']);
    expect(r.aspects.find((x) => x.aspect === 'shape')!.differs).toBe(false);
  });

  it('sees a different journey shape', () => {
    const a = base();
    const b = base({
      steps: [
        send(),
        { kind: 'condition', label: 'opened?', outcomes: ['READ'], yes: [send({ stage: 'outcome' })], no: [{ kind: 'exit', reason: 'no engagement' }] },
      ],
    });
    expect(signature(a).shape).not.toBe(signature(b).shape);
  });
});

describe('compare reports partial divergence honestly', () => {
  it('marks a pair partial when only some declared aspects differ', () => {
    const a = base();
    const b = base({ steps: [send(), { kind: 'wait', durationHours: 96 }, send({ stage: 'reminder' })] });
    const r = compare(a, b, ['timing', 'audience']);
    expect(r.verdict).toBe('partial');
    expect(r.met).toEqual(['timing']);
    expect(r.unmet).toEqual(['audience']);
  });
});

describe('experiment arms that cannot discriminate', () => {
  it('flags two arms that differ only in message copy', () => {
    const bp = base({
      steps: [
        {
          kind: 'experiment',
          label: 'cost framing vs friction framing',
          arms: [
            { label: 'cost hesitation', pct: 50, steps: [send({ copy: 'Here is what EMI costs you.' }), { kind: 'wait', durationHours: 48 }] },
            { label: 'friction hesitation', pct: 50, steps: [send({ copy: 'Converting takes two taps.' }), { kind: 'wait', durationHours: 48 }] },
          ],
        },
      ],
    });
    const [arm] = experimentArms(bp);
    expect(arm.cannotDiscriminate).toBe(true);
    expect(arm.collidingArms).toEqual(['cost hesitation', 'friction hesitation']);
  });

  it('accepts arms that vary something a customer experiences', () => {
    const bp = base({
      steps: [
        {
          kind: 'experiment',
          label: 'immediate vs near due date',
          arms: [
            { label: 'immediate', pct: 50, steps: [send()] },
            { label: 'near due date', pct: 50, steps: [{ kind: 'wait', durationHours: 240 }, send()] },
          ],
        },
      ],
    });
    const [arm] = experimentArms(bp);
    expect(arm.cannotDiscriminate).toBe(false);
    expect(arm.collidingArms).toEqual([]);
  });

  it('finds experiments nested inside a condition branch', () => {
    const bp = base({
      steps: [
        {
          kind: 'condition',
          label: 'opened?',
          outcomes: ['READ'],
          yes: [
            {
              kind: 'experiment',
              label: 'nested',
              arms: [
                { label: 'x', pct: 50, steps: [send()] },
                { label: 'y', pct: 50, steps: [send()] },
              ],
            },
          ],
          no: [{ kind: 'exit', reason: 'done' }],
        },
      ],
    });
    expect(experimentArms(bp)).toHaveLength(1);
    expect(experimentArms(bp)[0].cannotDiscriminate).toBe(true);
  });

  it('returns nothing when there is no experiment', () => {
    expect(experimentArms(base())).toEqual([]);
  });
});
