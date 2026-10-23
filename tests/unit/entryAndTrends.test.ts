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

const SYSTEM = (() => {
  const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
  return /const SYSTEM = `([\s\S]*?)`;\n/.exec(src)![1];
})();

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
  it('invites what they have SEEN, and takes "we do not track it" as an answer', () => {
    // The question survives. What goes is the menu: asking whether they have
    // noticed a pattern is discovery; asking which group to go after is
    // handing them a targeting decision the entry already settles.
    expect(SYSTEM).toMatch(/ASK WHAT THEY HAVE SEEN, NOT WHICH GROUP TO GO AFTER/);
    expect(SYSTEM).toMatch(/noticed a pattern in who does this already, or do not track it — both are answers/);
    expect(SYSTEM).toMatch(/NEVER put up a menu of groups and ask which to target/);
    // And the agent still proposes factors itself; a user who could name every
    // one of them would not need the agent.
    expect(SYSTEM).toMatch(/BUT DO NOT ONLY RECORD WHAT THEY RAISED/);
  });

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
    expect(SYSTEM).toMatch(/you DERIVE it from the objective in front of you/);
    expect(SYSTEM).toMatch(/never from a standard list of generic marketing dimensions/);
  });

  it('keeps the entry whole when a trend turns up', () => {
    expect(SYSTEM).toMatch(/A TREND ABOUT WHO IS LIKELIER CHANGES THE TREATMENT, NEVER THE DOOR/);
    // Trimmed 2026-10-23 to pay for the trends rewrite in §1: §6 already
    // carries the cadence/channel/copy list, so §3 keeps only its own half.
    expect(SYSTEM).toMatch(/and "I am not sure" does not shrink the entry either/);
    // The structural half, which predates this slice and is what actually
    // enforces it: an entry condition is not segmentation.
    expect(SYSTEM).toMatch(/A SPLIT BELONGS INSIDE THE JOURNEY, NOT AT THE DOOR/);
  });
});

describe('no history is a reason to test, not a reason to ship a flat sequence', () => {
  it('says one track AND says the campaign must produce the trend', () => {
    expect(SYSTEM).toMatch(/IF THEY HAVE SEEN NO PATTERN, OR DO NOT TRACK IT: one track for everyone eligible/);
    // The consequence ("or the next run starts as blind") is the gate's own
    // refusal text now, so the prompt keeps the instruction and drops the
    // sermon.
    expect(SYSTEM).toMatch(/THIS run has to produce the trend/);
  });

  it('derives the comparison rather than defaulting to a copy test or more sends', () => {
    expect(SYSTEM).toMatch(/DERIVE THE COMPARISON FROM THIS OBJECTIVE/);
    expect(SYSTEM).toMatch(/Two message variants is one option, not the default, and adding sends tests nothing/);
  });

  it('never tells the agent to skip a test to protect a baseline', () => {
    // The failure mode this guards: "we have no history, so do not split the
    // audience or the baseline is unreadable." It is backwards — with no
    // history the comparison is the only way to get one.
    expect(SYSTEM).toMatch(/Having no performance history is a reason TO test, not a reason to skip it/);
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
          touches: [
            { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Opening.', ifStillUnconverted: 'If it is still sitting unread, send the same fact again sooner; if it is not delivered at all, SMS the same day.' },
            { day: 3, channel: 'SMS', path: 'all', purpose: 'Reminder.', ifStillUnconverted: 'If it was read and nothing happened, stop.' },
          ],
          assumptions: [],
          unknowns: [],
        },
        openItems: [],
      },
    } as never);
    expect(d.proceed, d.blocks.map((x) => x.code).join(', ')).toBe(true);
  });
});
