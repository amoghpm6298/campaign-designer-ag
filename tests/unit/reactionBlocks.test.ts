// The journey has to move on what the customer did.
//
// THE LIVE EMI CONFIRM, `eval/runs/ui-s-1792738033056`. One evidenced
// who-axis (purchases above ₹10,000), a clock (most convert within half an
// hour), and the plan that came out of it: a WhatsApp drip on a fixed
// schedule with a copy experiment on top. §7 has said EVEN SPACING WITH NO
// REACTION IS NOT A PLAN for a day, in words, and that is what shipped —
// which is this repo's standing lesson about prompt rules.
//
// `optionAudit` already refuses the CLAIM after the fact: it downgrades
// "conditional branching — used" when the built blueprint contains no
// meaningful fork. That is not enough, for the reason every other
// propose-time rule exists: the moment to say so is before the manager
// approves, not on the turn their approval is spent.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { decide, reactionBlocks } from '../../server/gate';
import { newBrief, recordAnswer, recordBarriers, recordConverters, recordDimensions, recordSuccessCriteria } from '../../server/discovery';
import { reactingPath } from './support/journeys';

const EMI = 'Customers are not converting eligible purchases to EMI. Get more of them converting.';
const THEIRS = 'they do not realise the purchase qualifies';

/** A brief that has finished discovery, so only the proposal is on trial. */
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

/** Two touches that tell not-delivered from read-and-ignored. */
const reactingTouches = [
  { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Say the purchase can be split.', ifStillUnconverted: 'If it is still sitting unread, send the same fact again sooner; if it is not delivered at all, SMS the same day.' },
  { day: 2, channel: 'SMS', path: 'all', purpose: 'Last chance before it lapses.', ifStillUnconverted: 'If it was read and nothing happened, stop.' },
];

/**
 * The proposal as `decide` sees it: the essay AND the path.
 *
 * Since 2026-10-23 a reactive winner with no journey attached is a hold, so a
 * fixture about the PROSE has to carry a reacting path or it is held for the
 * other reason and proves nothing.
 */
const proposal = (strategy: unknown, blueprint: unknown = reactingPath({}, 'no-awareness')) => ({ strategy, blueprint });

const plan = (over: Record<string, unknown> = {}) => ({
  summary: 'Catch them while the purchase is fresh.',
  approach: ['Everyone eligible enters.'],
  strategyOptions: [{ option: 'Experimentation', verdict: 'used', why: 'Cost framing versus deadline framing.' }],
  architectures: [
    { name: 'Catch the moment', journey: 'branch-on-response', chosen: true },
    { name: 'Work the statement date', journey: 'linear' },
  ],
  touches: reactingTouches,
  assumptions: [],
  unknowns: [],
  ...over,
});

describe('a clock cannot be the chosen architecture', () => {
  it('refuses a winner whose journey is linear', () => {
    const blocks = reactionBlocks(proposal(plan({
        architectures: [
          { name: 'Timed drip', journey: 'linear', chosen: true },
          { name: 'Catch the moment', journey: 'branch-on-response' },
        ],
      })) as never);
    expect(blocks.map((b) => b.code)).toEqual(['no-reaction']);
    expect(blocks[0].reason).toMatch(/treats unread, unreached and ignored as the same person/);
    // The two things the live plan DID do, named as not being this.
    expect(blocks[0].reason).toMatch(/ticket-size split and a wording test are not that/);
  });

  it('refuses a plan with no chosen candidate at all', () => {
    // A proposal in which nobody won has not made the decision this check is
    // about, and reading "undefined" as linear would be a guess.
    const blocks = reactionBlocks(proposal(plan({ architectures: [{ name: 'A', journey: 'branch-on-response' }, { name: 'B', journey: 'linear' }] })) as never);
    expect(blocks.map((b) => b.code)).toEqual(['no-reaction']);
  });

  it('refuses an experiment as the whole answer', () => {
    // `experiment` is a legitimate journey behaviour and it is not a REACTION:
    // randomised arms learn something, they do not respond to what this
    // customer did. A wording test over the same four sends is one treatment.
    const blocks = reactionBlocks(proposal(plan({ architectures: [{ name: 'Two openings', journey: 'experiment', chosen: true }, { name: 'Clock', journey: 'linear' }] })) as never);
    expect(blocks.map((b) => b.code)).toEqual(['no-reaction']);
  });

  it('accepts branch-on-response and wait-for-event', () => {
    for (const journey of ['branch-on-response', 'wait-for-event']) {
      expect(
        reactionBlocks(proposal(plan({ architectures: [{ name: 'W', journey, chosen: true }, { name: 'L', journey: 'linear' }] })) as never),
        journey,
      ).toEqual([]);
    }
  });

  it('offers the clock as the rival, and never a second invented barrier', () => {
    const [block] = reactionBlocks(proposal(plan({ architectures: [{ name: 'Clock', journey: 'linear', chosen: true }] })) as never);
    expect(block.clears.field).toBe('architecture');
    expect(block.clears.how).toMatch(/branch-on-response or wait-for-event/);
    expect(block.clears.how).toMatch(/rival it beats may be the clock/);
    expect(block.clears.how).toMatch(/Do not invent a second customer problem/);
  });
});

describe('claiming a reaction is not having one', () => {
  it('refuses when every touch falls back to the same reminder', () => {
    const blocks = reactionBlocks(proposal(plan({
        touches: [
          { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Opening.', ifStillUnconverted: 'Remind on day 2.' },
          { day: 2, channel: 'SMS', path: 'all', purpose: 'Reminder.', ifStillUnconverted: 'Remind on day 4.' },
        ],
      })) as never);
    expect(blocks.map((b) => b.code)).toEqual(['no-reaction']);
    expect(blocks[0].reason).toMatch(/Those are three different people/);
    expect(blocks[0].clears.field).toBe('touches');
  });

  it('refuses when the fallback is blank', () => {
    const blocks = reactionBlocks(proposal(plan({
        touches: [
          { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Opening.', ifStillUnconverted: '' },
          { day: 2, channel: 'SMS', path: 'all', purpose: 'Reminder.', ifStillUnconverted: '' },
        ],
      })) as never);
    expect(blocks.map((b) => b.code)).toEqual(['no-reaction']);
  });

  it('accepts SMS-on-failure against wait-if-unread, which are two different people', () => {
    expect(reactionBlocks(proposal(plan()) as never)).toEqual([]);
  });

  it('does NOT count converting as one of the two landed cases', () => {
    // FLIPPED 2026-10-23, and it was a hole in the same lock: "still unread"
    // plus "if they converted, we stop" cleared the gate while the plan said
    // nothing about the person who read the message and did not act. Whoever
    // books is taken off the path by the Goal Check the compiler inserts —
    // the platform's own terminal, not a person who needs a next job.
    const blocks = reactionBlocks(proposal(plan({
        touches: [
          { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Opening.', ifStillUnconverted: 'If it is still sitting unread, repeat the same fact sooner.' },
          { day: 2, channel: 'SMS', path: 'all', purpose: 'Last chance.', ifStillUnconverted: 'If they have converted, the campaign stops for them.' },
        ],
      })) as never);
    expect(blocks.map((b) => b.code)).toEqual(['no-reaction']);
    expect(blocks[0].clears.how).toMatch(/Nor is converting: the goal check already takes anyone who booked off the path/);
  });

  it('clears on unread against read-and-no-action, which are two real people', () => {
    expect(
      reactionBlocks(proposal(plan({
          touches: [
            { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Opening.', ifStillUnconverted: 'If it is still sitting unread, repeat the same fact sooner.' },
            { day: 2, channel: 'SMS', path: 'all', purpose: 'Last chance.', ifStillUnconverted: 'If they read it and did nothing, argue the instalment instead.' },
          ],
        })) as never),
    ).toEqual([]);
  });

  it('no longer counts "not delivered, try SMS" as one of the two', () => {
    // MEASURED, and it is why this changed. Undelivered was the easiest of
    // the cases to write, so "if it is not delivered, SMS the same day"
    // satisfied half the requirement while saying nothing about anybody who
    // actually received the message. It is a real decision and it belongs in
    // the plan — as `fallbackChannel` on that send, not as a person who did
    // something.
    const blocks = reactionBlocks(proposal(plan({
        touches: [
          { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Opening.', ifStillUnconverted: 'If it is not delivered, SMS the same day.' },
          { day: 2, channel: 'SMS', path: 'all', purpose: 'Reminder.', ifStillUnconverted: 'If it does not deliver either, stop.' },
        ],
      })) as never);
    expect(blocks.map((b) => b.code)).toEqual(['no-reaction']);
    expect(blocks[0].clears.how).toMatch(/name at least two cases where the message LANDED/);
    expect(blocks[0].clears.how).toMatch(/Undelivered is worth mentioning as the fallback channel/);
  });
});

describe('before Confirm, never after', () => {
  it('is raised at propose time', () => {
    const d = decide(settled(), {
      proposed: proposal(plan({ architectures: [{ name: 'Clock', journey: 'linear', chosen: true }] })) as never,
    });
    expect(d.blocks.map((b) => b.code)).toContain('no-reaction');
  });

  it('is not raised on the turn that builds the approved plan', () => {
    // Same rule as the cadence and trend blocks. Once they have approved,
    // refusing leaves them with an approval that did nothing.
    const d = decide(settled(), {
      proposed: proposal(plan({ architectures: [{ name: 'Clock', journey: 'linear', chosen: true }] })) as never,
      building: true,
    });
    expect(d.blocks.map((b) => b.code)).not.toContain('no-reaction');
  });

  it('says nothing when there is no proposal, so discovery is untouched', () => {
    expect(reactionBlocks(null)).toEqual([]);
    expect(reactionBlocks({} as never)).toEqual([]);
  });
});

describe('the steps are checked too, not just the essay', () => {
  it('reads the blueprint when the turn carries one', () => {
    // REVERSED, 2026-10-23, and the old assertion is worth recording: this
    // used to pin that `reactionBlocks` never reads a blueprint "because at
    // propose time there is not one". That was true of the tool path and
    // false of the JSON one — `{ action: 'propose', strategy, blueprint }`
    // has always carried steps — and the live failure is precisely a plan
    // whose essay claimed a reaction while its steps were a clock. One
    // definition, read on both turns.
    const src = readFileSync(new URL('../../server/gate.ts', import.meta.url), 'utf8');
    const start = src.indexOf('export function reactionBlocks');
    // END MARKER CHECKED, not assumed. A slice whose end marker has stopped
    // existing silently becomes "the rest of the file", which is how two
    // assertions in `emptyRoundRecovery` came to be about everything to EOF.
    const end = src.indexOf('/** Channel words a plan may name', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const fn = src.slice(start, end);
    expect(fn).toMatch(/journeyReacts\(p\.blueprint\)/);
    // The SAME function the build turn uses, imported rather than restated.
    expect(src).toMatch(/import \{ journeyReacts \} from '\.\/optionAudit'/);
    // And still never the compiled graph: a Goal Check the compiler inserts
    // after every send is not a fork anybody designed, and it is not in the
    // blueprint at all.
    for (const forbidden of ['GOAL_EXIT', 'GOAL_CHECK', 'graph']) expect(fn, forbidden).not.toContain(forbidden);
  });

  it('holds a plan whose winner reacts and whose steps do not', () => {
    const clock = {
      campaignName: 'A', description: 'd', goal: null,
      entry: { kind: 'audience', entity: 'Card', conditions: [] },
      steps: [
        { kind: 'send', name: 'Opening', objective: ['emi'], stage: 'first-touch', describe: 'd', channelPreference: ['WHATSAPP'], barrier: 'no-awareness' },
        { kind: 'wait', durationHours: 48 },
        { kind: 'send', name: 'Reminder', objective: ['emi'], stage: 'reminder', describe: 'd', channelPreference: ['WHATSAPP'], barrier: 'no-awareness' },
      ],
    };
    const blocks = reactionBlocks({ strategy: plan(), blueprint: clock } as never);
    expect(blocks.map((b) => b.code)).toEqual(['no-reaction']);
    expect(blocks[0].reason).toMatch(/the steps are a timed sequence/);
    expect(blocks[0].clears.how).toMatch(/Put ONE outcome fork/);
    expect(blocks[0].clears.how).toMatch(/Do not split after every send/);
    expect(blocks[0].clears.how).toMatch(/Keep the who-split you have/);
  });

  it('lets through a plan whose steps carry one engagement fork', () => {
    const reacting = {
      campaignName: 'A', description: 'd', goal: null,
      entry: { kind: 'audience', entity: 'Card', conditions: [] },
      steps: [
        { kind: 'send', name: 'Opening', objective: ['emi'], stage: 'first-touch', describe: 'd', channelPreference: ['WHATSAPP'], barrier: 'no-awareness', fallbackChannel: 'SMS' },
        {
          kind: 'branch', label: 'What happened to it',
          paths: [
            { label: 'Unread', statuses: ['DELIVERED'], steps: [{ kind: 'wait', durationHours: 24 }, { kind: 'send', name: 'Sooner', objective: ['emi'], stage: 'reminder', describe: 'd', channelPreference: ['WHATSAPP'], barrier: 'no-awareness' }] },
            { label: 'Read', statuses: ['READ'], steps: [{ kind: 'send', name: 'What it costs', objective: ['emi'], stage: 'outcome', describe: 'd', channelPreference: ['WHATSAPP'], barrier: 'no-awareness' }] },
          ],
        },
      ],
    };
    expect(reactionBlocks({ strategy: plan(), blueprint: reacting } as never)).toEqual([]);
  });

  it('holds a reactive plan that carries no steps at all', () => {
    // FLIPPED 2026-10-23, and the old assertion was right when written:
    // `propose_strategy` had no blueprint in its schema and `systemForPhase`
    // told the model the grammar was omitted, so a block demanding steps had
    // no legal exit — the unclearable refusal this file exists to prevent.
    // The tool carries the path now and the grammar travels on a
    // ready-to-propose turn, so the exit is to send it.
    for (const proposed of [{ strategy: plan() }, { strategy: plan(), blueprint: null }]) {
      const blocks = reactionBlocks(proposed as never);
      expect(blocks.map((b) => b.code)).toEqual(['no-reaction']);
      expect(blocks[0].reason).toMatch(/there is no journey attached to it/);
      expect(blocks[0].clears.how).toMatch(/Send the same plan again with "blueprint" filled in/);
      expect(blocks[0].clears.how).toMatch(/Confirm compiles exactly that path/);
    }
  });
});
