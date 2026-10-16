// The architecture audit decides whether a claimed comparison was real.
//
// The test that matters most is "relabelling does not buy differentiation":
// the brief for this work warned specifically that a model can give two
// equivalent interventions different names, and a check that accepted
// different names as proof of difference would be worse than no check — it
// would launder the exact failure it was built to catch.
import { describe, it, expect } from 'vitest';
import {
  compareArchitectures,
  checkFidelity,
  derive,
  JOURNEY_BEHAVIOURS,
  type Architecture,
} from '../../server/architectureAudit';
import type { CampaignBlueprint, BpStep } from '../../server/blueprint';

const arch = (over: Partial<Architecture> = {}): Architecture => ({
  name: 'A',
  entry: 'Audience · Account filtered on Status = Active',
  mechanism: 'Correct the belief that converting is expensive',
  timing: '3 days before the statement due date',
  tradeoff: 'Gives up eligibility precision',
  chosen: false,
  barrier: 'Customers overestimate what conversion costs',
  lever: 'State the actual total payable at the moment of decision',
  journey: 'linear',
  measurement: 'Conversion rate against a held-back control',
  ...over,
});

const send = (over: Partial<Extract<BpStep, { kind: 'send' }>> = {}): BpStep => ({
  kind: 'send', name: 'T1', objective: ['emi'], stage: 'first-touch', describe: 'd', ...over,
});

const bp = (steps: BpStep[]): CampaignBlueprint => ({
  campaignName: 'c', description: 'd', goal: null,
  entry: { kind: 'audience', entity: 'Account' }, steps,
});

describe('a comparison needs two candidates that declared what they do', () => {
  it('calls nothing a comparison', () => {
    expect(compareArchitectures([]).status).toBe('incomplete');
    expect(compareArchitectures(undefined).status).toBe('incomplete');
  });

  it('does not treat a single candidate as a comparison', () => {
    const r = compareArchitectures([arch({ chosen: true })]);
    expect(r.status).toBe('incomplete');
    expect(r.why).toContain('nothing was compared');
  });

  it('refuses to assess candidates that did not say what their intervention is', () => {
    const r = compareArchitectures([
      arch({ name: 'A', barrier: '' }),
      arch({ name: 'B', entry: 'Event · Transaction', lever: '   ', journey: 'experiment' }),
    ]);
    expect(r.status).toBe('incomplete');
    expect(r.why).toContain('A.barrier');
    expect(r.why).toContain('B.lever');
  });

  it('rejects a journey outside the closed vocabulary', () => {
    const r = compareArchitectures([
      arch({ name: 'A', journey: 'adaptive-multi-touch-orchestration' }),
      arch({ name: 'B', entry: 'Event · Transaction', journey: 'experiment' }),
    ]);
    expect(r.status).toBe('incomplete');
    expect(r.why).toContain('adaptive-multi-touch-orchestration');
    for (const b of JOURNEY_BEHAVIOURS) expect(r.why).toContain(b);
  });
});

describe('relabelling does not buy differentiation', () => {
  it('reports INSUFFICIENT when only the mechanism wording differs', () => {
    const r = compareArchitectures([
      arch({ name: 'Cost clarity', mechanism: 'Improve comprehension of the cost' }),
      arch({ name: 'Cost reassurance', mechanism: 'Reduce the perceived cost', chosen: true }),
    ]);
    expect(r.status).toBe('insufficient');
    expect(r.why).toContain('Cost clarity / Cost reassurance');
    expect(r.why).toContain('one campaign described twice');
  });

  it('is not fooled by different barrier and lever text either', () => {
    // Everything a customer experiences is identical; only the internal story
    // about WHY differs. That is one campaign.
    const r = compareArchitectures([
      arch({ name: 'A', barrier: 'They misread the cost', lever: 'Show the real number' }),
      arch({ name: 'B', barrier: 'They distrust the product', lever: 'Build confidence with proof', chosen: true }),
    ]);
    expect(r.status).toBe('insufficient');
  });

  it('ignores punctuation and casing when deciding two entries are the same', () => {
    const r = compareArchitectures([
      arch({ name: 'A', entry: 'Audience · Account filtered on Status = Active' }),
      arch({ name: 'B', entry: 'audience account filtered on status active!', chosen: true }),
    ]);
    expect(r.status).toBe('insufficient');
  });
});

describe('candidates that genuinely differ are allowed to be compared', () => {
  it('accepts a different entry', () => {
    const r = compareArchitectures([
      arch({ name: 'Due-date timing' }),
      arch({ name: 'Eligibility-precise', entry: 'Event · Transaction on EMI Eligible', chosen: true }),
    ]);
    expect(r.status).toBe('differentiated');
  });

  it('accepts a different journey behaviour at the same entry', () => {
    const r = compareArchitectures([
      arch({ name: 'Fixed cadence', journey: 'linear' }),
      arch({ name: 'Learn which barrier', journey: 'experiment', chosen: true }),
    ]);
    expect(r.status).toBe('differentiated');
  });

  it('says plainly that differentiation is not quality', () => {
    const r = compareArchitectures([
      arch({ name: 'A' }),
      arch({ name: 'B', timing: 'immediately after the qualifying purchase', chosen: true }),
    ]);
    expect(r.status).toBe('differentiated');
    expect(r.why).toMatch(/does NOT say either is a good idea/);
  });
});

describe('journey behaviour is read back off the built campaign', () => {
  it('derives linear from sends and waits', () => {
    expect([...derive(bp([send(), { kind: 'wait', durationHours: 48 }, send()]))]).toEqual(['linear']);
  });

  it('derives branch-on-response from a condition', () => {
    const d = derive(bp([send(), { kind: 'condition', label: 'c', outcomes: ['READ'], yes: [send()], no: [] }]));
    expect(d.has('branch-on-response')).toBe(true);
  });

  it('derives wait-for-event and experiment, including inside arms', () => {
    const d = derive(bp([
      { kind: 'experiment', label: 'x', arms: [
        { label: 'a', pct: 50, steps: [{ kind: 'waitForEvent', eventCategory: 'EMI Events', eventType: 'EMI Request', timeoutDays: 7 }] },
        { label: 'b', pct: 50, steps: [send()] },
      ] },
    ]));
    expect(d.has('experiment')).toBe(true);
    expect(d.has('wait-for-event')).toBe(true);
  });
});

describe('the winner must be the campaign that got built', () => {
  it('catches a declared branch that was never built', () => {
    const r = checkFidelity(
      [arch({ chosen: true, journey: 'branch-on-response' })],
      bp([send(), { kind: 'wait', durationHours: 48 }, send()]),
    )!;
    expect(r.ok).toBe(false);
    expect(r.why).toContain('The strategy and the campaign disagree');
  });

  it('catches a declared linear journey that quietly became an experiment', () => {
    const r = checkFidelity(
      [arch({ chosen: true, journey: 'linear' })],
      bp([{ kind: 'experiment', label: 'x', arms: [
        { label: 'a', pct: 50, steps: [send()] },
        { label: 'b', pct: 50, steps: [send()] },
      ] }]),
    )!;
    expect(r.ok).toBe(false);
    expect(r.why).toContain('experiment');
  });

  it('passes when the built journey contains what was chosen', () => {
    const r = checkFidelity(
      [arch({ chosen: true, journey: 'branch-on-response' })],
      bp([send(), { kind: 'condition', label: 'c', outcomes: ['READ'], yes: [send()], no: [] }]),
    )!;
    expect(r.ok).toBe(true);
  });

  it('passes a genuinely linear campaign declared linear', () => {
    expect(checkFidelity([arch({ chosen: true, journey: 'linear' })], bp([send()]))!.ok).toBe(true);
  });

  it('cannot check anything without a winner or a blueprint', () => {
    expect(checkFidelity([arch({ chosen: false })], bp([send()]))).toBeNull();
    expect(checkFidelity([arch({ chosen: true })], null)).toBeNull();
  });

  it('reports an unrecognised declared journey rather than guessing', () => {
    const r = checkFidelity([arch({ chosen: true, journey: 'vibes' })], bp([send()]))!;
    expect(r.ok).toBe(false);
    expect(r.why).toContain('cannot be checked');
  });
});
