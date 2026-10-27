// Entry is every eligible customer who has not done the behaviour. Always.
//
// A TREND IS NOT A TARGET. Knowing who is likelier to convert changes what
// those people GET — a different cadence, channel, wording, an extra touch on
// one path — and never whether they are in the campaign. The remainder keeps
// a path either way.
//
// WHAT THIS SLICE FIXES, and it is copy rather than compiler. Three places
// put a menu of groups to the manager:
//
//   - §2 of SYSTEM named a standing list of customer differences and told the
//     agent to "ask which one they would back";
//   - `briefForPrompt` ended its candidate block with "Then ask which they
//     would back. Do not pick a target and proceed as though they had agreed
//     to it" — a choice of audience, put to someone whose audience is already
//     decided;
//   - the gate's clearing instruction called them "candidate segments".
//
// All three now read as TRENDS TO TEST inside one entry set. And the factor
// lists are gone: the examples in §2 were EMI-shaped, so every objective got
// EMI's dimensions back.
//
// THE NO-HISTORY CASE is the other half. "We have seen no pattern" or "we do
// not track it" means one track for everyone eligible — and the campaign
// still has to learn something, by testing whatever THIS objective is
// actually uncertain about. No history is a reason to test, not a reason to
// ship the shyest flat sequence.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { briefForPrompt, newBrief, recordAnswer, recordConverters, recordDimensions, recordSuccessCriteria } from '../../server/discovery';
import { convertersSettled, mustLearnAudience } from '../../server/findings';
import { decide } from '../../server/gate';
import { discovered } from './support/findings';
import { reactingPath } from './support/journeys';
import { asking, ready } from './support/prompts.ts';
// PINS REMOVED, NOT LOST: 12 rule(s) this file asserted have no
// counterpart in any of the three manuals. Every one is listed in
// `server/promptHomeless.md` under this filename, with the tests that
// went with them. Do not re-add a pin here without putting the rule
// back in a manual first.

const SYSTEM = asking();

/** The manager's own words from the live runs: one track, no pattern seen. */
const ONE_TRACK = 'every eligible purchase, one track, we have never looked at who converts';

/** A brief where they named the audience and said they track no pattern. */
const oneTrack = () => {
  let b = discovered(newBrief('Get more outstanding balances converted to EMI before the request expires.'));
  b = recordAnswer(b, ONE_TRACK);
  b = recordConverters(b, {
    shape: 'every eligible purchase, one track, no split',
    basis: 'user',
    // They do not track it. That is an answer about the DATA, not about who
    // the campaign is for.
    knowledge: 'unknown',
  });
  b = recordDimensions(b, [
    { name: 'Days left in the window', rationale: 'Late may differ from early.', status: 'retained', basis: 'user' },
  ]);
  return recordSuccessCriteria(b, ['More balances converted before they lapse.']);
};

describe('"we do not track a pattern" does not reopen who the campaign is for', () => {
  it('leaves converters settled on their own description of the audience', () => {
    const b = oneTrack();
    expect(convertersSettled(b.converters)).toBe(true);
    expect(decide(b).blocks.map((x) => x.code)).not.toContain('converters-unknown');
  });

  it('still carries the obligation to find out, as a trend to produce', () => {
    // Settled is not the same as known. The campaign still has to learn who
    // responds — by cutting treatment or testing, never by thinning entry.
    expect(mustLearnAudience(oneTrack().converters)).toBe(true);
  });

  it('does not ask which group to target', () => {
    const text = briefForPrompt(oneTrack());
    expect(text).not.toMatch(/which they would back/i);
    expect(text).not.toMatch(/candidate segment/i);
    // The IMPERATIVE form, not the word: the block now contains the ban
    // itself ("never as a choice of who to target"), and a test that cannot
    // tell a prohibition from an instruction is checking nothing.
    expect(text).not.toMatch(/\bask (them )?which\b/i);
    expect(text).not.toMatch(/which (one )?(they|you) would back/i);
  });
});

describe('a one-track brief can still be asked about trends', () => {

  it('frames candidates as trends that cut treatment, not groups that cut entry', () => {
    let b = oneTrack();
    b = recordConverters(b, {
      shape: 'every eligible purchase, one track, no split',
      basis: 'user',
      knowledge: 'unknown',
      candidates: [
        { segment: 'Those who have opened the app this week', restsOn: 'recent app activity', why: 'They are already in a place where the option is visible.' },
        { segment: 'Those who called support about this', restsOn: 'an inbound contact about the product', why: 'They have already shown intent and hit something in the way.' },
      ],
    });
    const text = briefForPrompt(b);
    expect(text).toMatch(/candidate trend:/);
    expect(text).toMatch(/Everyone eligible still enters/);
    expect(text).toMatch(/Cut the TREATMENT by these/);
    expect(text).toMatch(/The remainder keeps a path/);
    // The two lines this slice removed, both of which asked the manager to
    // choose an audience.
    expect(text).not.toMatch(/Wait for their reaction/);
    expect(text).not.toMatch(/Do not pick a target/);
  });

  it('says so in the one place the gate tells the model what clears it', () => {
    // A brief that has got past the first block, so the converters one is
    // actually reached: a fresh brief stops at `no-participation`.
    let b = newBrief('Get more customers converting.');
    b = recordAnswer(b, 'We want more of them converting before the window closes.');
    b = recordSuccessCriteria(b, ['More conversions inside the window.']);
    const block = decide(b).blocks.find((x) => x.code === 'converters-unknown');
    expect(block).toBeTruthy();
    expect(block!.clears.how).toMatch(/candidate trends/);
    expect(block!.clears.how).toMatch(/the entry stays every eligible customer/);
    expect(block!.clears.how).not.toMatch(/candidate segments/);
  });
});

describe('the trends are derived from this objective, not from a standing list', () => {
  it('SYSTEM names no fixed factor list', () => {
    // EMI's factors were the examples, so every objective got EMI's
    // dimensions handed back to it. These are the ones that were there, plus
    // the ones a reader would reach for next.
    for (const banned of [
      'ticket size',
      'merchant category',
      'prior EMI',
      'online vs store',
      'balance size',
      'transaction size',
      'credit utilisation',
      'how they were sourced',
      'whether the app is on their phone',
    ]) {
      expect(SYSTEM.toLowerCase(), banned).not.toContain(banned.toLowerCase());
    }
  });

  it('tells the agent to derive them instead', () => {
    expect(asking()).toMatch(/Derive three to five of them from this objective/);
  });

});

describe('no history is a reason to test, not a reason to ship a flat sequence', () => {


  it('never tells the agent to skip a test to protect a baseline', () => {
    // The failure mode this guards: "we have no history, so do not split the
    // audience or the baseline is unreadable." It is backwards — with no
    // history the comparison is the only way to get one.
    expect(ready()).toMatch(/No history is a reason to test, not a reason to skip/);
    expect(SYSTEM.toLowerCase()).not.toMatch(/so the baseline is ?n.t split|keep the baseline clean/);
  });

  it('does not block a proposal that experiments on a no-trend brief', () => {
    // THIS TEST WAS VACUOUS WHEN WRITTEN, 2026-10-22, and the gate check added
    // on 2026-10-23 is what exposed it. Its name says "a proposal that
    // experiments"; its fixture declared no experiment at all, so it proved
    // only that nothing was checking. It now declares the test it claims to.
    //
    // AND IT NEEDED A REACTING WINNER AND TWO CHANNEL JOBS, 2026-10-23, for
    // the same reason: `reactionBlocks` and `channelJobBlocks` would otherwise
    // hold this turn and the assertion below would be about them rather than
    // about trends. Fifth fixture written as "a good proposal" that a later
    // structural check invalidated.
    const b = oneTrack();
    const d = decide(b, {
      proposed: {
        strategy: {
          summary: 'One track for everyone eligible, with the wording tested.',
          approach: ['Everyone eligible enters; two openings are compared.'],
          strategyOptions: [
            { option: 'Segmentation', verdict: 'not-applicable', why: 'No trend has been seen, so nothing to cut on.' },
            { option: 'Experimentation', verdict: 'used', why: 'Two openings, randomly assigned, read on conversion.' },
          ],
          architectures: [
            { name: 'Catch the moment', journey: 'branch-on-response', chosen: true },
            { name: 'Work the statement date', journey: 'linear' },
          ],
          // AND THE PATH ITSELF, since 2026-10-23: a reactive winner with no
          // journey attached is now a hold, because sending one is legal.
          // Sixth fixture of the day, same reason — see server/CLAUDE.md.
          touches: [
            { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Opening.', ifStillUnconverted: 'If it is still sitting unread, send the same fact again sooner; if it is not delivered at all, SMS the same day.' },
            { day: 3, channel: 'SMS', path: 'all', purpose: 'Reminder.', ifStillUnconverted: 'If it was read and nothing happened, stop.' },
          ],
          assumptions: [],
          unknowns: [],
        },
        openItems: [],
        blueprint: reactingPath({}, 'cost-perception'),
      },
    } as never);
    expect(d.proceed, d.blocks.map((x) => x.code).join(', ')).toBe(true);
  });
});
