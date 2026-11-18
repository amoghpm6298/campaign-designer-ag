// The designer's reasoning on each step: shown on the canvas, passed to callers.
import { describe, it, expect } from 'vitest';
import { campaignBrief } from '../../server/mcp/brief';
import { campaignDetails } from '../../server/mcp/details';
import { stepRationale } from '../../src/designer/v2/canvasModel';
import type { CampaignObject } from '../../server/agent/types';

const journey = [
  {
    kind: 'experiment',
    name: 'Framing test',
    tests: 'wording',
    hypothesis: 'Rewards beat benefits for lapsed spenders',
    successMetric: 'Share of each arm that transacts within 7 days',
    arms: [
      { label: 'Rewards', pct: 50, steps: [{ kind: 'send', name: 'Rewards reminder', rationale: 'They earned points already', channelPreference: ['WHATSAPP'] }] },
      { label: 'Benefits', pct: 50, steps: [{ kind: 'send', name: 'Benefits reminder', channelPreference: ['WHATSAPP'] }] },
    ],
  },
];
const c = { goal: null, entry: null, membership: { type: 'locked' }, buckets: [{ id: 'lapsed', name: 'Lapsed', priority: 1, rule: [], journey }], everyoneElse: null } as unknown as CampaignObject;

describe('step rationale', () => {
  it('the brief lists each test with its arms, hypothesis and success measure', () => {
    expect(campaignBrief(c, null).buckets[0].tests).toEqual([
      { name: 'Framing test', arms: ['Rewards 50%', 'Benefits 50%'], hypothesis: 'Rewards beat benefits for lapsed spenders', successMetric: 'Share of each arm that transacts within 7 days' },
    ]);
  });
  it('details keep every step\'s rationale', () => {
    const steps = campaignDetails('cv-none', c, null).buckets[0].journey as unknown as { hypothesis?: string; arms: { steps: { rationale?: string }[] }[] }[];
    expect(steps[0].hypothesis).toMatch(/Rewards beat/);
    expect(steps[0].arms[0].steps[0].rationale).toBe('They earned points already');
  });
  it('older sends and waits fall back to their describe; other steps do not', () => {
    expect(stepRationale({ kind: 'send', rationale: 'new', describe: 'old' })).toBe('new');
    expect(stepRationale({ kind: 'wait', describe: '3 days, a familiar habit' })).toBe('3 days, a familiar habit');
    expect(stepRationale({ kind: 'branch', describe: 'x' })).toBeUndefined();
  });
});
