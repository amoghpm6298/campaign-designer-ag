// Fix 4: an experiment may not claim more than its design can settle.
//
// MEASURED, and the reason this is enforcement rather than another warning:
// across three proposals in ONE conversation the agent built experiment arms
// that were the identical journey, described them as testing which customer
// barrier was real, was told so underneath its own strategy, and answered by
// renaming the experiment and rebuilding the same thing. The feedback loop
// worked — it responded, twice, cosmetically. Being told was not enough.
import { describe, it, expect } from 'vitest';
import { checkExperimentClaims } from '../../server/architectureAudit';
import { EXPERIMENT_CLAIMS, isExperimentClaim, type CampaignBlueprint, type BpStep } from '../../server/blueprint';

const send = (over: Partial<Extract<BpStep, { kind: 'send' }>> = {}): BpStep => ({
  kind: 'send', name: 'n', objective: ['emi'], stage: 'first-touch', describe: 'd', channelPreference: ['EMAIL'], ...over,
});

const bp = (tests: string, a: BpStep[], b: BpStep[]): CampaignBlueprint => ({
  campaignName: 'c', description: 'd', goal: null,
  entry: { kind: 'audience', entity: 'Account' },
  steps: [{ kind: 'experiment', label: 'the test', tests, arms: [
    { label: 'A', pct: 50, steps: a }, { label: 'B', pct: 50, steps: b },
  ] } as unknown as BpStep],
});

// The exact shape the live run produced, three times running.
const COPY_ONLY_ARMS: [BpStep[], BpStep[]] = [
  [send({ copy: 'Converting is easy.' }), { kind: 'wait', durationHours: 48 }, send({ stage: 'reminder', channelPreference: ['SMS'] })],
  [send({ copy: 'Here is what it costs.' }), { kind: 'wait', durationHours: 48 }, send({ stage: 'reminder', channelPreference: ['SMS'] })],
];

describe('a claim is checked against what was built', () => {
  it('refuses an explanation claim backed by identical arms', () => {
    const v = checkExperimentClaims(bp('explanation', ...COPY_ONLY_ARMS));
    expect(v).toHaveLength(1);
    expect(v[0].identicalArms).toEqual(['A', 'B']);
    expect(v[0].why).toContain('same journey');
    expect(v[0].why).toContain('which barrier was real');
  });

  it('refuses a timing claim with identical timing', () => {
    expect(checkExperimentClaims(bp('timing', ...COPY_ONLY_ARMS))[0].why).toContain('when to make contact');
  });

  it('refuses when nothing was declared at all', () => {
    // Silence must not buy permission. That failure has happened once already,
    // in the first version of the fork guard.
    const v = checkExperimentClaims(bp('', ...COPY_ONLY_ARMS));
    expect(v).toHaveLength(1);
    expect(v[0].claim).toBe('(not declared)');
  });
});

describe('the escape hatch is real, so this cannot become a trap', () => {
  it('accepts identical arms when declared honestly as a wording test', () => {
    // A guard with no legal move is a trap. This one always has two, and this
    // is the one that is always available.
    expect(checkExperimentClaims(bp('wording', ...COPY_ONLY_ARMS))).toEqual([]);
  });

  it('accepts an explanation claim when the arms genuinely differ', () => {
    expect(checkExperimentClaims(bp('explanation',
      [send()],
      [{ kind: 'wait', durationHours: 240 }, send()],
    ))).toEqual([]);
  });

  it('counts a channel change as a real difference, but not copy', () => {
    expect(checkExperimentClaims(bp('explanation',
      [send({ channelPreference: ['EMAIL'] })],
      [send({ channelPreference: ['SMS'] })],
    ))).toEqual([]);
    expect(checkExperimentClaims(bp('explanation',
      [send({ copy: 'one wording' })],
      [send({ copy: 'a different wording' })],
    ))).toHaveLength(1);
  });
});

describe('the vocabulary', () => {
  it('is closed and recognisable', () => {
    expect(EXPERIMENT_CLAIMS).toContain('wording');
    expect(EXPERIMENT_CLAIMS).toContain('explanation');
    expect(isExperimentClaim('wording')).toBe(true);
    expect(isExperimentClaim('vibes')).toBe(false);
  });

  it('says nothing when there is no experiment', () => {
    expect(checkExperimentClaims({
      campaignName: 'c', description: 'd', goal: null,
      entry: { kind: 'audience', entity: 'Account' }, steps: [send()],
    })).toEqual([]);
  });

  it('finds an experiment nested inside a condition branch', () => {
    const inner = bp('explanation', ...COPY_ONLY_ARMS).steps[0];
    expect(checkExperimentClaims({
      campaignName: 'c', description: 'd', goal: null,
      entry: { kind: 'audience', entity: 'Account' },
      steps: [{ kind: 'condition', label: 'opened?', outcomes: ['READ'], yes: [inner], no: [] }],
    })).toHaveLength(1);
  });
});
