// Channels are jobs, not a default.
//
// THE LIVE EMI CONFIRM, `eval/runs/ui-s-1792738033056`: four WhatsApp sends,
// with SMS, email and RCS all available on the tenant and none of them given
// anything to do. WhatsApp for the catch while the purchase is still fresh is
// a job; SMS for when WhatsApp does not land is a job; email for a message
// that has to be read later is a job. One channel for all of it is habit.
//
// The opposite mistake is refused by the same function, because it is the one
// a rule against single-channel plans invites: firing everything at the same
// person on the same day is fatigue dressed as coverage.
import { describe, it, expect } from 'vitest';
import { channelJobBlocks, decide } from '../../server/gate';
import { newBrief, recordAnswer, recordBarriers, recordConverters, recordDimensions, recordSuccessCriteria } from '../../server/discovery';

const EMI = 'Customers are not converting eligible purchases to EMI. Get more of them converting.';
const THEIRS = 'they do not realise the purchase qualifies';

const settled = () => {
  let b = recordAnswer(newBrief(EMI), `purchases above 10,000 convert more, ${THEIRS}, and we do not track category or card type`);
  b = recordBarriers(b, [
    { id: 'no-awareness', statement: 'They do not realise the purchase qualifies.', basis: 'user-belief', lever: 'message', quote: THEIRS },
  ]);
  b = recordConverters(b, { shape: 'Purchases above ₹10,000 convert more often.', basis: 'user', knowledge: 'known' });
  b = recordDimensions(b, [
    { name: 'purchase ticket size', rationale: 'They said bigger ones convert.', status: 'retained', basis: 'user', note: 'Theirs.' },
    { name: 'merchant category and card type', rationale: 'Asked about together.', status: 'unavailable', basis: 'user', note: 'They do not track either.' },
    { name: 'Channel preference', rationale: 'Where to reach them.', status: 'unavailable', basis: 'none', note: 'No per-customer history.' },
  ]);
  return recordSuccessCriteria(b, ['More eligible purchases converted before they lapse.']);
};

const touch = (over: Record<string, unknown>) => ({
  day: 0,
  channel: 'WHATSAPP',
  path: 'all',
  purpose: 'Say the purchase can be split.',
  ifStillUnconverted: 'Remind them on day 2.',
  ...over,
});

const plan = (touches: unknown[]) => ({
  summary: 'Catch them while the purchase is fresh.',
  approach: ['Everyone eligible enters.'],
  architectures: [
    { name: 'Catch the moment', journey: 'branch-on-response', chosen: true },
    { name: 'Work the statement date', journey: 'linear' },
  ],
  touches,
  assumptions: [],
  unknowns: [],
});

describe('one channel for everything is habit', () => {
  it('refuses the live shape: every send on WhatsApp, reminders on WhatsApp', () => {
    const blocks = channelJobBlocks({
      strategy: plan([
        touch({ day: 0, ifStillUnconverted: 'Remind them on WhatsApp on day 2.' }),
        touch({ day: 2, ifStillUnconverted: 'Remind them on WhatsApp on day 4.' }),
      ]),
    } as never);
    expect(blocks.map((b) => b.code)).toEqual(['single-channel-habit']);
    expect(blocks[0].reason).toMatch(/habit rather than a decision/);
    expect(blocks[0].clears.field).toBe('touches');
    expect(blocks[0].clears.how).toMatch(/Do not fire every channel at everyone/);
  });

  it('folds case and spacing, so WHATSAPP and "WhatsApp" are one channel', () => {
    const blocks = channelJobBlocks({
      strategy: plan([touch({ channel: 'WHATSAPP' }), touch({ day: 2, channel: 'WhatsApp ' })]),
    } as never);
    expect(blocks.map((b) => b.code)).toEqual(['single-channel-habit']);
  });

  it('accepts a second channel named only as the fallback', () => {
    // THE ONLY RELEASE HERE, and it reads the sentence the model already
    // writes. A fallback does not need a scheduled row of its own to be a
    // decision: "if it is not delivered, SMS the same day" gives SMS a job.
    expect(
      channelJobBlocks({
        strategy: plan([
          touch({ day: 0, ifStillUnconverted: 'If it is not delivered, SMS the same day.' }),
          touch({ day: 2, ifStillUnconverted: 'If it was read and nothing happened, stop.' }),
        ]),
      } as never),
    ).toEqual([]);
  });

  it('accepts two channels across two days', () => {
    expect(
      channelJobBlocks({ strategy: plan([touch({ day: 0, channel: 'WhatsApp' }), touch({ day: 2, channel: 'Email' })]) } as never),
    ).toEqual([]);
  });

  it('says nothing about a single touch, which cadenceBlocks already owns', () => {
    expect(channelJobBlocks({ strategy: plan([touch({})]) } as never)).toEqual([]);
  });
});

describe('every channel at once is fatigue, not coverage', () => {
  it('refuses two channels to the same path on the same day', () => {
    const blocks = channelJobBlocks({
      strategy: plan([touch({ day: 0, channel: 'WhatsApp' }), touch({ day: 0, channel: 'Email' }), touch({ day: 2, channel: 'SMS' })]),
    } as never);
    expect(blocks.map((b) => b.code)).toEqual(['channel-spray']);
    expect(blocks[0].reason).toMatch(/day 0: whatsapp and email/);
    expect(blocks[0].clears.how).toMatch(/on the failure fork only/);
  });

  it('allows the same day on two DIFFERENT paths', () => {
    // Two groups each getting their own opening is not spray: no one person
    // receives both.
    expect(
      channelJobBlocks({
        strategy: plan([
          touch({ day: 0, channel: 'WhatsApp', path: 'Above their own median' }),
          touch({ day: 0, channel: 'Email', path: 'Everyone else' }),
          touch({ day: 2, channel: 'SMS', path: 'Above their own median' }),
          touch({ day: 2, channel: 'SMS', path: 'Everyone else' }),
        ]),
      } as never),
    ).toEqual([]);
  });
});

describe('before Confirm, never after', () => {
  it('is raised at propose time and skipped on the build turn', () => {
    const proposed = {
      strategy: plan([
        touch({ day: 0, ifStillUnconverted: 'Remind on WhatsApp.' }),
        touch({ day: 2, ifStillUnconverted: 'Remind on WhatsApp again.' }),
      ]),
    } as never;
    expect(decide(settled(), { proposed }).blocks.map((b) => b.code)).toContain('single-channel-habit');
    expect(decide(settled(), { proposed, building: true }).blocks.map((b) => b.code)).not.toContain('single-channel-habit');
  });

  it('says nothing when there is no proposal, so discovery is untouched', () => {
    expect(channelJobBlocks(null)).toEqual([]);
    expect(channelJobBlocks({} as never)).toEqual([]);
  });
});
