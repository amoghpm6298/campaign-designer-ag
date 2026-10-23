// One pattern is a candidate, not the architecture.
//
// THE LIVE EMI CHAT, `eval/runs/ui-s-1792738033056`. The manager gave three
// things in two turns: purchases above ₹10,000 convert more (a pattern they
// have SEEN), customers do not realise the purchase qualifies (the barrier),
// and it usually happens within thirty minutes (timing).
//
// The agent proposed immediately and split the entire journey on ticket size.
// It never asked whether anything else had been seen — not category, not
// first-time versus repeat, not card type.
//
// The record afterwards LOOKED like a considered search, which is the part
// worth stopping. Two dimensions retained, two deferred. But the second
// retained one was a clock (`basis: 'tool'`), and both deferred ones were the
// agent's own inventions marked `assumption`. Nobody had been asked anything.
//
// So the rule is ask once, then lock: one question, with "we do not track
// that" as a complete answer, and no second round of it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocksFor, decide, otherAxesProbed, stackedDimensionBlocks, trendBlocks } from '../../server/gate';
import { isTimingDimension, newBrief, recordAnswer, recordBarriers, recordConverters, recordDimensions, recordQuestions, recordSuccessCriteria, recordUncoveredQuestions, type DiscoveryDimension } from '../../server/discovery';

const SYSTEM = (() => {
  const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
  return /const SYSTEM = `([\s\S]*?)`;\n/.exec(src)![1];
})();

const EMI = 'Customers are not converting eligible purchases to EMI. Get more of them converting.';
const THEIRS = 'they do not realise the purchase qualifies';

/** The brief as the live run actually built it, minus the dimensions. */
const settled = () => {
  let b = recordAnswer(newBrief(EMI), `purchases above 10,000 convert more, ${THEIRS}, usually within 30 minutes`);
  b = recordBarriers(b, [
    { id: 'no-awareness-of-eligibility', statement: 'They do not realise the purchase qualifies.', basis: 'user-belief', lever: 'message', quote: THEIRS },
  ]);
  b = recordConverters(b, { shape: 'Purchases above ₹10,000 convert more often.', basis: 'user', knowledge: 'known' });
  return recordSuccessCriteria(b, ['More eligible purchases converted.']);
};

const withDims = (dims: DiscoveryDimension[]) => recordDimensions(settled(), dims);

/** The live record: one seen pattern, a clock, and two the agent invented. */
const liveShape = () =>
  withDims([
    { name: 'purchase ticket size', rationale: 'They said bigger ones convert more.', status: 'retained', basis: 'user', note: 'Manager confirmed purchases above ₹10,000.' },
    { name: 'time elapsed since the eligible purchase, within the request window', rationale: 'The window is short.', status: 'retained', basis: 'tool', note: 'Platform fact.' },
    { name: 'prior EMI usage / familiarity with the product', rationale: 'Might matter.', status: 'deferred', basis: 'assumption', note: 'Not raised or asked about directly.' },
    { name: 'merchant category', rationale: 'Might matter.', status: 'deferred', basis: 'assumption', note: 'Not asked.' },
  ]);

const codes = (b: ReturnType<typeof settled>) => blocksFor(b).map((x) => x.code);

describe('timing is not a second axis', () => {
  it('classifies the live names the way a person would', () => {
    expect(isTimingDimension('Time between purchase and EMI decision')).toBe(true);
    expect(isTimingDimension('time elapsed since the eligible purchase, within the request window')).toBe(true);
    expect(isTimingDimension('Statement date')).toBe(true);
    expect(isTimingDimension('Purchase ticket size or category')).toBe(false);
    expect(isTimingDimension('purchase ticket size')).toBe(false);
    expect(isTimingDimension('prior EMI usage / familiarity with the product')).toBe(false);
    expect(isTimingDimension('Card type')).toBe(false);
  });

  it('does not let a clock satisfy the probe', () => {
    // The live record read as two retained dimensions. One was a clock.
    expect(otherAxesProbed(liveShape())).toBe(false);
  });

  it('does not let a clock the MANAGER described satisfy it either', () => {
    // The live record happened to carry the timing finding as `basis: 'tool'`
    // — a platform fact about the window — so classifying it out changed
    // nothing there. But "most convert within thirty minutes" is something
    // the manager SAID, and recorded honestly that is basis `user`, retained.
    // Without `isTimingDimension` that reads as a second axis they have seen,
    // the probe looks satisfied, and the agent proposes on one pattern again.
    //
    // Everyone passes through the same clock. It paces the journey; it does
    // not divide the people.
    const clockFromThem = withDims([
      { name: 'purchase ticket size', rationale: 'Bigger ones convert.', status: 'retained', basis: 'user', note: 'Theirs.' },
      { name: 'Time between purchase and EMI decision', rationale: 'They said it is usually within half an hour.', status: 'retained', basis: 'user', note: 'Theirs.' },
    ]);
    expect(otherAxesProbed(clockFromThem)).toBe(false);
    expect(codes(clockFromThem)).toContain('unprobed-other-axes');
    // And it is not offered as the axis to cut on, either.
    expect(
      stackedDimensionBlocks(clockFromThem, {
        strategy: { touches: [{ day: 0, channel: 'SMS', path: 'Above 10000 ticket', purpose: 'p', ifStillUnconverted: 'x' },
                              { day: 1, channel: 'SMS', path: 'Within 30 minutes', purpose: 'p', ifStillUnconverted: 'x' }] },
      }),
    ).toEqual([]);
  });

  it('does not let a dimension the AGENT deferred satisfy it either', () => {
    // `basis: 'assumption'` is the agent talking to itself. Two of those sat
    // under a heading that read like a search.
    expect(otherAxesProbed(liveShape())).toBe(false);
    expect(codes(liveShape())).toContain('unprobed-other-axes');
  });
});

describe('one seen pattern holds the proposal until someone asks about a second', () => {
  it('fires on the live shape', () => {
    const blocks = blocksFor(liveShape());
    const block = blocks.find((x) => x.code === 'unprobed-other-axes');
    expect(block).toBeTruthy();
    expect(block!.reason).toMatch(/one pattern you have seen — purchase ticket size/);
    expect(block!.reason).toMatch(/If you do not track anything else, say so/);
    // Never a menu of groups.
    expect(block!.reason).not.toMatch(/which group|who to target/i);
  });

  it('clears when they say they do not track the others', () => {
    const probed = withDims([
      { name: 'purchase ticket size', rationale: 'Bigger ones convert.', status: 'retained', basis: 'user', note: 'Theirs.' },
      { name: 'merchant category and first-time versus repeat', rationale: 'Asked about together.', status: 'unavailable', basis: 'user', note: 'We do not track category or first-time.' },
    ]);
    expect(otherAxesProbed(probed)).toBe(true);
    expect(codes(probed)).not.toContain('unprobed-other-axes');
  });

  it('clears when a second pattern IS named', () => {
    const two = withDims([
      { name: 'purchase ticket size', rationale: 'Bigger ones convert.', status: 'retained', basis: 'user', note: 'Theirs.' },
      { name: 'card type', rationale: 'Platinum holders convert more.', status: 'retained', basis: 'user', note: 'Theirs.' },
    ]);
    expect(otherAxesProbed(two)).toBe(true);
    expect(codes(two)).not.toContain('unprobed-other-axes');
  });

  it('clears when the question itself was asked and answered', () => {
    let b = withDims([
      { name: 'purchase ticket size', rationale: 'Bigger ones convert.', status: 'retained', basis: 'user', note: 'Theirs.' },
    ]);
    b = recordQuestions(b, [{ text: 'Besides ticket size, is there anything else you have seen that splits who converts?', impact: 'shaping' }]);
    expect(codes(b)).toContain('unprobed-other-axes');
    // THE PRODUCTION PATH, not `recordAnswer` alone. `answeredInRound` means
    // a reply arrived this round; `addressedInRound` means this question was
    // dealt with, and `recordUncoveredQuestions` is what sets it — called
    // unconditionally on every turn, with an empty list meaning the model
    // claims nothing went uncovered. The probe keys on the second, so a model
    // that says the probe went untouched does not clear it by accident.
    b = recordUncoveredQuestions(recordAnswer(b, 'no, nothing else we track'), []);
    expect(otherAxesProbed(b)).toBe(true);
    expect(codes(b)).not.toContain('unprobed-other-axes');
  });

  it('stays silent while there is no seen pattern at all', () => {
    // The who-converts question still owns that conversation, and two blocks
    // asking adjacent things would read as the application talking over
    // itself.
    const none = withDims([
      { name: 'purchase ticket size', rationale: 'A guess of mine.', status: 'open', basis: 'assumption' },
    ]);
    expect(codes(none)).not.toContain('unprobed-other-axes');
  });

  it('is released by the round budget and by being told to proceed', () => {
    const b = liveShape();
    expect(decide(b).proceed).toBe(false);
    expect(decide(b, { proceedRequested: true }).proceed).toBe(true);
    expect(decide({ ...b, rounds: 99 }).proceed).toBe(true);
  });
});

describe('two evidenced patterns are a choice, not four paths', () => {
  const twoAxes = () =>
    withDims([
      { name: 'purchase ticket size', rationale: 'Bigger ones convert.', status: 'retained', basis: 'user', note: 'Theirs.' },
      { name: 'card type', rationale: 'Platinum holders convert more.', status: 'retained', basis: 'user', note: 'Theirs.' },
    ]);
  const touches = (path: string) => [
    { day: 0, channel: 'WHATSAPP', path, purpose: 'Say it qualifies.', ifStillUnconverted: 'Remind.' },
    { day: 2, channel: 'SMS', path, purpose: 'Last chance.', ifStillUnconverted: 'Stop.' },
  ];

  it('refuses a plan that cuts on both', () => {
    const blocks = stackedDimensionBlocks(twoAxes(), {
      strategy: { touches: [...touches('Above 10000 ticket'), ...touches('Platinum card holders')] },
    });
    expect(blocks.map((b) => b.code)).toEqual(['stacked-dimensions']);
    expect(blocks[0].reason).toMatch(/purchase ticket size AND card type/);
    expect(blocks[0].reason).toMatch(/Pick the one that changes what we DO/);
    // Still never a menu.
    expect(blocks[0].reason).not.toMatch(/which group should/i);
  });

  it('allows a plan that cuts on one of them', () => {
    expect(
      stackedDimensionBlocks(twoAxes(), { strategy: { touches: [...touches('Above 10000 ticket'), ...touches('Everyone else')] } }),
    ).toEqual([]);
  });

  it('says nothing when only one axis is evidenced', () => {
    expect(
      stackedDimensionBlocks(liveShape(), { strategy: { touches: [...touches('Above 10000 ticket'), ...touches('Platinum card holders')] } }),
    ).toEqual([]);
  });

  it('is a propose-time check, skipped once they have approved', () => {
    const b = twoAxes();
    const proposed = { strategy: { touches: [...touches('Above 10000 ticket'), ...touches('Platinum card holders')] } };
    expect(decide(b, { proposed }).blocks.map((x) => x.code)).toContain('stacked-dimensions');
    expect(decide(b, { proposed, building: true }).blocks.map((x) => x.code)).not.toContain('stacked-dimensions');
  });

  it('leaves the existing trend rules alone', () => {
    // A cut on ONE evidenced axis is exactly what `trendBlocks` already
    // allows, and this slice must not change that — it only adds a check
    // beside it for the plan that cuts on two.
    const b = twoAxes();
    expect(
      trendBlocks(b, { strategy: { touches: [...touches('Above 10000 ticket'), ...touches('Everyone else')] } }),
    ).toEqual([]);
  });
});

describe('the prompt teaches the same three moves', () => {
  it('ask once, then lock', () => {
    expect(SYSTEM).toMatch(/ONE PATTERN IS NOT THE END: ask ONCE if anything else they SAW splits who acts, then lock/);
  });

  it('time-to-act is not an axis', () => {
    expect(SYSTEM).toMatch(/TIME-TO-ACT IS TIMING, NOT AN AXIS/);
  });

  it('choose, do not stack', () => {
    expect(SYSTEM).toMatch(/TWO SEEN AXES MEAN A CHOICE: cut on the one that moves their barrier/);
  });

  it('still never asks which group to target', () => {
    expect(SYSTEM).toMatch(/ASK WHAT THEY HAVE SEEN, NOT WHICH GROUP TO GO AFTER/);
  });
});
