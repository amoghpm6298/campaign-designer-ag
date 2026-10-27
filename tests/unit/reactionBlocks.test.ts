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
import { decide, reactionBlocks, alignJourneyClaim } from '../../server/gate';
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

describe('a clock may win, and the claim is what is checked', () => {
  // REVERSED 2026-10-24, and the group this replaces was my own
  // over-correction. The measured failure was a plan that CLAIMED a reaction
  // and shipped a timed drip; I generalised it into "a clock is never a
  // plan", which is the application designing the campaign. A ticket-size
  // split with a sensible cadence is something a manager can run on Monday.
  // Unread-versus-read is intelligence worth having on top of it, not a pass
  // mark.
  //
  // What survives is the shape this codebase trusts: compare the CLAIM
  // against the CHOICE. Two things can be wrong — claiming the upgrade
  // without building it, and writing the upgrade and then picking the weaker
  // candidate.
  const clockWinner = (over: Record<string, unknown> = {}) =>
    plan({ architectures: [{ name: 'Statement-date drip', journey: 'linear', chosen: true }], ...over });

  it('lets a linear winner through when no reactive rival was written', () => {
    expect(reactionBlocks(proposal(clockWinner()) as never)).toEqual([]);
  });

  it('lets the whole turn proceed on a clock', () => {
    // The end of the story: a who-split and a clock reach Confirm.
    const d = decide(settled(), { proposed: proposal(clockWinner()) as never });
    expect(d.blocks.map((b) => b.code), d.blocks.map((b) => b.reason).join(' | ')).toEqual([]);
    expect(d.proceed).toBe(true);
  });

  it('ADVISES, and does not hold, when they wrote the upgrade and chose the calendar', () => {
    // DEMOTED 2026-10-26. `chose-clock-over-reaction` was a Block, and a
    // Block refuses a build. Describing a reactive rival and then picking the
    // cadence is a judgement a campaign manager is allowed to make — the
    // application saying "no, take the other one" is the application choosing
    // the campaign. The sentence still goes out, once, as advice.
    const clockOverReaction = plan({
      architectures: [
        { name: 'Statement-date drip', journey: 'linear', chosen: true },
        { name: 'Catch the moment', journey: 'branch-on-response' },
      ],
    });
    expect(reactionBlocks(proposal(clockOverReaction) as never)).toEqual([]);

    const d = decide(settled(), { proposed: proposal(clockOverReaction) as never });
    expect(d.blocks.map((b) => b.code)).toEqual([]);
    expect(d.proceed).toBe(true);
    expect(d.advice.join(' ')).toMatch(/treats someone who opened the message and someone who never did as two different people/);
    expect(d.advice.join(' ')).toMatch(/chose the one that goes by the calendar/);
  });

  it('advises the same way when nobody was marked the winner', () => {
    // "They wrote the upgrade and picked nothing" lands in the same place.
    const d = decide(settled(), {
      proposed: proposal(
        plan({
          architectures: [
            { name: 'Statement-date drip', journey: 'linear' },
            { name: 'Catch the moment', journey: 'branch-on-response' },
          ],
        }),
      ) as never,
    });
    expect(d.blocks.map((b) => b.code)).toEqual([]);
    expect(d.advice.join(' ')).toMatch(/The reacting one is usually the better campaign/);
  });

  it('says nothing when every candidate is a clock', () => {
    expect(
      reactionBlocks(
        proposal(
          plan({
            architectures: [
              { name: 'Statement-date drip', journey: 'linear', chosen: true },
              { name: 'Fixed cadence', journey: 'experiment' },
            ],
          }),
        ) as never,
      ),
    ).toEqual([]);
  });

  it('still holds a reactive winner whose steps are a ticket-size diamond', () => {
    // The upgrade was claimed, so the steps have to do it. A who-split alone
    // is not the fork — that is the live turn-4-to-5 argument in one case.
    const ticketOnly = {
      campaignName: 'A', description: 'd', goal: null,
      entry: { kind: 'audience', entity: 'Card', conditions: [] },
      steps: [
        {
          kind: 'branch', label: 'Ticket band', entity: 'Transaction', attribute: 'Transaction Amount',
          paths: [
            { label: 'Above 10000', operator: 'Greater than', value: '10000', steps: [{ kind: 'send', name: 'Opening', objective: ['emi'], stage: 'first-touch', describe: 'd', channelPreference: ['WHATSAPP'], barrier: 'no-awareness' }] },
            { label: 'Everyone else', operator: 'Less than', value: '10000', steps: [{ kind: 'send', name: 'Other', objective: ['emi'], stage: 'first-touch', describe: 'd', channelPreference: ['WHATSAPP'], barrier: 'no-awareness' }] },
          ],
        },
      ],
    };
    // STRIPPED, NOT HELD, since 2026-10-26. The claim was wrong and the path
    // is a perfectly runnable who-split clock, so the application repairs the
    // LABEL — which is the only half it can repair — and the manager gets the
    // plan plus one sentence about what a read-fork would add. A who-split is
    // still not the fork: `journeyReacts` is false here.
    const proposed = { strategy: plan(), blueprint: ticketOnly };
    expect(reactionBlocks(proposed as never)).toEqual([]);

    const aligned = alignJourneyClaim(proposed as never);
    expect(aligned.stripped).toBe(true);
    expect(aligned.proposed!.strategy!.architectures!.find((a: { chosen?: boolean }) => a.chosen)!.journey).toBe('linear');
    // The who-split survives untouched, and no fork was invented.
    expect(JSON.stringify(aligned.proposed!.blueprint)).toBe(JSON.stringify(ticketOnly));

    const d = decide(settled(), { proposed: proposed as never });
    expect(d.blocks.map((b) => b.code)).toEqual([]);
    expect(d.proceed).toBe(true);
    expect(d.advice.join(' ')).toMatch(/read-fork on the first WhatsApp/);
  });
});

// THE STEPS ARE THE READER. THE TOUCH PROSE IS NOT.
//
// REWRITTEN 2026-10-26, and this group used to be the opposite rule: every
// case below asserted that `namedOutcomes` over `ifStillUnconverted` HELD the
// turn when it named fewer than two landed cases. It ran before the blueprint
// was consulted at all.
//
// MEASURED, `eval/runs/ui-s-1792843757296` turn 3. Discovery was finished,
// `decide(brief)` was empty, `propose_strategy` had accepted a path whose
// steps fork on READ against DELIVERED/DELETED — `journeyReacts` TRUE — and
// Confirm never appeared, because the touch sentences named one landed case.
// The manager read an essay plus a hold telling them their reacting journey
// does not react.
//
// `namedOutcomes` is still exported and `channelJobBlocks` still uses it to
// tell two exclusive arms from two sends to one person. It is not the Confirm
// gate.
describe('the touch prose is not the Confirm gate', () => {
  const thinProse = (over: Record<string, unknown> = {}) =>
    plan({
      touches: [
        { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Opening.', ifStillUnconverted: 'Remind on day 2.' },
        { day: 2, channel: 'SMS', path: 'all', purpose: 'Reminder.', ifStillUnconverted: 'Remind on day 4.' },
      ],
      ...over,
    });

  it('a reacting path proceeds however thin the sentences are', () => {
    expect(reactionBlocks(proposal(thinProse()) as never)).toEqual([]);
    const d = decide(settled(), { proposed: proposal(thinProse()) as never });
    expect(d.blocks.map((b) => b.code)).toEqual([]);
    expect(d.proceed).toBe(true);
  });

  it('and a blank fallback is not a hold either, once a path exists', () => {
    const blank = plan({
      touches: [
        { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Opening.', ifStillUnconverted: '' },
        { day: 2, channel: 'SMS', path: 'all', purpose: 'Reminder.', ifStillUnconverted: '' },
      ],
    });
    expect(reactionBlocks(proposal(blank) as never)).toEqual([]);
  });

  it('nor does naming only the undelivered case, which the steps settle', () => {
    // Undelivered is `fallbackChannel` on the send and says nothing about
    // anyone who received the message. That reasoning is unchanged; what
    // changed is that a SENTENCE about it can no longer hold a path.
    const undeliveredOnly = plan({
      touches: [
        { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Opening.', ifStillUnconverted: 'If it is not delivered, SMS the same day.' },
        { day: 2, channel: 'SMS', path: 'all', purpose: 'Reminder.', ifStillUnconverted: 'If it does not deliver either, stop.' },
      ],
    });
    expect(reactionBlocks(proposal(undeliveredOnly) as never)).toEqual([]);
  });

  it('THE ONE HOLD LEFT: a reaction claimed with no journey attached', () => {
    // Nothing to approve but a paragraph. The exit exists — the tool carries
    // `blueprint` on a ready turn — so the hold is fair.
    const blocks = reactionBlocks({ strategy: plan(), blueprint: null } as never);
    expect(blocks.map((b) => b.code)).toEqual(['no-reaction']);
    expect(blocks[0].reason).toMatch(/there is no journey attached to it/);
    expect(blocks[0].clears.field).toBe('touches');
    expect(blocks[0].clears.how).toMatch(/Send the same plan again with "blueprint" filled in/);
  });

  it('and captions are not a journey, so they hold too', () => {
    const captions = { campaignName: 'A', description: 'd', goal: null, entry: { kind: 'audience', entity: 'Card', conditions: [] }, steps: ['Day 0 WhatsApp'] };
    expect(reactionBlocks({ strategy: plan(), blueprint: captions } as never).map((b) => b.code)).toEqual(['no-reaction']);
  });

  it('a clock that never claimed a reaction is not this block\'s business', () => {
    // Even with no path at all: the hold is for a BROKEN PROMISE, and a plan
    // that promised a cadence has not broken one.
    const linearOnly = plan({ architectures: [{ name: 'Statement-date drip', journey: 'linear', chosen: true }] });
    expect(reactionBlocks({ strategy: linearOnly, blueprint: null } as never)).toEqual([]);
  });
});

describe('before Confirm, never after', () => {
  it('is raised at propose time', () => {
    // The one case left: a reactive claim with no path to approve.
    const d = decide(settled(), { proposed: { strategy: plan(), blueprint: null } as never });
    expect(d.blocks.map((b) => b.code)).toContain('no-reaction');
  });

  it('is not raised on the turn that builds the approved plan', () => {
    // Same rule as the cadence and trend blocks. Once they have approved,
    // refusing leaves them with an approval that did nothing.
    const d = decide(settled(), {
      proposed: proposal(
        plan({
          touches: [
            { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Opening.', ifStillUnconverted: 'Remind on day 2.' },
            { day: 2, channel: 'SMS', path: 'all', purpose: 'Reminder.', ifStillUnconverted: 'Remind on day 4.' },
          ],
        }),
      ) as never,
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
    // THE READER MOVED, 2026-10-26, and the rule did not. `reactionBlocks`
    // now asks only whether a path EXISTS to approve; whether that path
    // reacts is `alignJourneyClaim`'s question, because the answer repairs
    // the claim instead of refusing the plan. Both read the blueprint, and
    // neither reads the touch prose.
    expect(fn).toMatch(/shapedBlueprint\(p\?\.blueprint\)/);
    // Asserted on the CODE rather than the comments: the function explains
    // what it stopped doing, and the explanation mentions the name.
    const code = fn
      .split('\n')
      .filter((l) => !l.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/namedOutcomes/);
    const align = src.slice(src.indexOf('export function alignJourneyClaim'), src.indexOf('export function reactionBlocks'));
    expect(align).toMatch(/journeyReacts\(path as CampaignBlueprint\)/);
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
      // A WHO-SPLIT AND A SENSIBLE CLOCK, which is the shape 2026-10-24 decided
      // may win. `trendBlocks` reads the steps for the cut now, and this
      // brief's retained ticket-size trend is what licenses it — without the
      // split in the path there is no cut to license and a plain clock
      // compares nothing, which is a different rule and a different test.
      steps: [
        {
          kind: 'branch', entity: 'Transaction', attribute: 'Transaction Amount',
          paths: [
            { label: 'Above 10000', operator: 'Equals', value: '10000', steps: [
              { kind: 'send', name: 'Opening', objective: ['emi'], stage: 'first-touch', describe: 'd', channelPreference: ['WHATSAPP'], barrier: 'no-awareness' },
              { kind: 'wait', durationHours: 48 },
              { kind: 'send', name: 'Reminder', objective: ['emi'], stage: 'reminder', describe: 'd', channelPreference: ['WHATSAPP'], barrier: 'no-awareness' },
            ] },
            { label: 'Everyone else', operator: 'Not Equals', value: '10000', steps: [
              { kind: 'send', name: 'Opening — everyone else', objective: ['emi'], stage: 'first-touch', describe: 'd', channelPreference: ['WHATSAPP'], barrier: 'no-awareness' },
            ] },
          ],
        },
      ],
    };
    // REPAIRS THE CLAIM AND PROCEEDS, since 2026-10-26. The steps are a
    // runnable plan; only the label was wrong, and the label is the half the
    // application can fix. The manager gets the path, the button, and one
    // sentence about what a read-fork would add.
    const proposed = { strategy: plan(), blueprint: clock };
    expect(reactionBlocks(proposed as never)).toEqual([]);
    const aligned = alignJourneyClaim(proposed as never);
    expect(aligned.stripped).toBe(true);
    expect(aligned.advice.join(' ')).toMatch(/read-fork on the first WhatsApp/);
    expect(decide(settled(), { proposed: proposed as never }).proceed).toBe(true);
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
