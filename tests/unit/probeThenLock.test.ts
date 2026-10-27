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
import { CLOSED_OTHER_AXES, noteClosedOtherAxes, isTimingDimension, newBrief, recordAnswer, recordBarriers, recordConverters, recordDimensions, recordQuestions, recordSuccessCriteria, seenAxes, type DiscoveryDimension } from '../../server/discovery';
import { receive, recordAsked } from '../../server/record';
import { asking } from './support/prompts.ts';
// PINS REMOVED, NOT LOST: 7 rule(s) this file asserted have no
// counterpart in any of the three manuals. Every one is listed in
// `server/promptHomeless.md` under this filename, with the tests that
// went with them. Do not re-add a pin here without putting the rule
// back in a manual first.

const SYSTEM = asking();

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

  it('does not classify frequency or recency as a clock', () => {
    // BOTH WERE IN THE LIST AND BOTH WERE WRONG. How often someone buys, and
    // how recently they last spent, are things ONE customer does more than
    // another — a who-axis, and probably the strongest pattern a manager has
    // actually noticed. Calling them timing would have discarded it.
    expect(isTimingDimension('purchase frequency')).toBe(false);
    expect(isTimingDimension('Recency of last spend')).toBe(false);
    // The genuine clocks are still clocks.
    expect(isTimingDimension('send cadence')).toBe(true);
    expect(isTimingDimension('time to act after authorisation')).toBe(true);
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

  it('counts a pattern they stated as user-belief, not only as user', () => {
    // MEASURED, `eval/runs/ui-s-1792842540156`. "10k+ txns convert more" came
    // back as `retained` / `user-belief`, so `seenAxes` was EMPTY, this block
    // never ran at all, and the axis they had given was invisible to every
    // rule that reads it. Both labels are defensible for one sentence; what
    // matters is theirs versus ours.
    const belief = withDims([
      { name: 'purchase ticket size', rationale: 'They said bigger ones convert.', status: 'retained', basis: 'user-belief', note: 'Theirs.' },
    ]);
    expect(seenAxes(belief).map((d) => d.name)).toEqual(['purchase ticket size']);
    expect(codes(belief)).toContain('unprobed-other-axes');
    // And an axis the AGENT retained on its own is still not one.
    const mine = withDims([
      { name: 'purchase ticket size', rationale: 'A hunch of mine.', status: 'retained', basis: 'assumption', note: 'Mine.' },
    ]);
    expect(seenAxes(mine)).toHaveLength(0);
  });

  it('clears on the probe they answered, whatever words it used', () => {
    // The question-text leg wanted "besides" or "anything else". The live
    // probe said "Beyond transaction size, have you noticed any difference by
    // purchase category…", they answered it, and the regex missed it. Adding
    // "beyond" buys one run; reading the record instead is structural — a
    // question that NAMES another axis on the brief, with `addressedInRound`
    // set by ingest.
    let b = withDims([
      { name: 'purchase ticket size', rationale: 'Bigger ones convert.', status: 'retained', basis: 'user', note: 'Theirs.' },
      { name: 'purchase category', rationale: 'Might split who acts.', status: 'deferred', basis: 'assumption', note: 'Asked.' },
    ]);
    b = recordAsked(b, [{ text: 'Beyond transaction size, have you noticed any difference by purchase category?', impact: 'shaping' }], 'agent');
    expect(otherAxesProbed(b)).toBe(false);
    const answered = receive(b, 'nothing as of now').brief;
    expect(otherAxesProbed(answered)).toBe(true);
    expect(codes(answered)).not.toContain('unprobed-other-axes');
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
    // THE PRODUCTION PATH, and the comment this replaces was false.
    //
    // It said `recordUncoveredQuestions(recordAnswer(b, ...), [])` was what
    // production does. It was not: live ingest called `recordAnswer` alone and
    // returned before any closer on the tool-only exit, so `addressedInRound`
    // was never written and the probe reprinted over an answered question for
    // three turns (`eval/runs/ui-s-1792839251135`). A fixture asserting a path
    // nothing walks is how that survived.
    //
    // `receive` is the one write the orchestrator now goes through: the answer
    // text and the attribution land together, and `notCovered` / `reopen` is
    // the bounded way to say one question went untouched.
    b = receive(b, 'no, nothing else we track').brief;
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

  it('is propose-time ADVICE, and still silent once they have approved', () => {
    // RETARGETED 2026-10-27. "Two evidenced patterns are a choice" is a
    // judgement about the plan, not about whether there is one — so it travels
    // as advice next to a live Confirm rather than summing into the same list
    // as "there is no journey". `stackedDimensionBlocks` itself is unchanged
    // and its own tests above still read it directly.
    const b = twoAxes();
    const proposed = { strategy: { touches: [...touches('Above 10000 ticket'), ...touches('Platinum card holders')] } };
    const atPropose = decide(b, { proposed });
    expect(atPropose.blocks.map((x) => x.code)).not.toContain('stacked-dimensions');
    expect(atPropose.advice.join(' '), 'its own sentence, not a sibling check').toMatch(
      /cuts the journey on .* AND .*splits everyone four ways/s,
    );
    expect(decide(b, { proposed, building: true }).advice.join(' ')).not.toMatch(/splits everyone four ways/);
  });

  it('leaves the existing trend rules alone', () => {
    // A cut on ONE evidenced axis is exactly what `trendBlocks` already
    // allows, and this slice must not change that — it only adds a check
    // beside it for the plan that cuts on two.
    const b = twoAxes();
    // IN THE STEPS, because that is where `trendBlocks` reads the cut now:
    // the touch-path names alone were what made a read-versus-unread fork look
    // like a who-split on `eval/runs/ui-s-1793016334376`.
    const oneAxis = {
      campaignName: 'EMI', description: 'Prompt conversion.', goal: null,
      entry: { kind: 'audience', entity: 'Card', conditions: [] },
      steps: [
        {
          kind: 'branch', entity: 'Transaction', attribute: 'Transaction Amount',
          paths: [
            { label: 'Above 10000 ticket', operator: 'Equals', value: '10000', steps: [{ kind: 'send', name: 'a', objective: ['emi'], stage: 'first-touch', describe: 'd', channelPreference: ['WHATSAPP'] }] },
            { label: 'Everyone else', operator: 'Not Equals', value: '10000', steps: [{ kind: 'send', name: 'b', objective: ['emi'], stage: 'first-touch', describe: 'd', channelPreference: ['WHATSAPP'] }] },
          ],
        },
      ],
    };
    expect(
      trendBlocks(b, {
        strategy: { touches: [...touches('Above 10000 ticket'), ...touches('Everyone else')] },
        blueprint: oneAxis,
      } as never),
    ).toEqual([]);
  });
});

describe('the prompt teaches the same three moves', () => {

  it('and that one question has to name its axes', () => {
    // The gate forces ONE extra question and cannot force it to be useful. A
    // blank "anything else?" is the failure this names: the manager has
    // nothing to react to, so "no" is the only cheap answer.
    // AND NOT A STANDING LIST. The examples live in the gate's clearing
    // instruction, which is shown when the block fires, rather than in a
    // prompt every objective reads — `entryAndTrends` pins that EMI's own
    // factors never appear in SYSTEM, because when they did every objective
    // got EMI's dimensions handed back to it.
    for (const banned of ['merchant category', 'ticket size', 'prior EMI', 'card type']) {
      expect(SYSTEM.toLowerCase(), banned).not.toContain(banned.toLowerCase());
    }
  });

  it('names those axes in the refusal instead, where the brief is known', () => {
    const block = blocksFor(liveShape()).find((x) => x.code === 'unprobed-other-axes');
    expect(block!.clears.how).toMatch(/NAME one or two axes in it/);
    expect(block!.clears.how).toMatch(/merchant category, first-time versus repeat, or card type/);
    expect(block!.clears.how).toMatch(/with no noun is not a question anyone can answer/);
  });

  it('time-to-act is not an axis', () => {
    expect(asking()).toMatch(/Time-to-act is timing, not an axis/);
  });


});

describe('their own sentence closes the probe', () => {
  // MEASURED, `eval/runs/ui-s-1792770967470` turns 4 to 7. The manager closed
  // the probe in turn 4. The agent even wrote their closure down — as a
  // dimension NOTE reading "Manager confirmed they do not track any other
  // pattern beyond ticket size" — and set `basis: 'none'` on those
  // dimensions, while `otherAxesProbed` reads `basis: 'user'`. So the hold
  // reprinted through three more turns over a question that had been answered
  // in the first of them, and `brief.answers` never grew past turn 4 either,
  // because every question was already addressed and nothing recorded the
  // reply.
  //
  // THE FIELD THE GATE READS HAS TO BE WHAT THEIR ENGLISH WRITES. That is the
  // whole fix: not a looser gate, a record that hears them.
  const rows = (b: WorkingBrief) =>
    recordDimensions(b, [
      { name: 'transaction ticket size', rationale: 'They said above ten thousand converts more.', status: 'retained', basis: 'user', note: 'Keep the ₹10,000 line.' },
      { name: 'merchant category', rationale: 'Might matter.', status: 'deferred', basis: 'none', note: 'Manager confirmed they do not track any other pattern beyond ticket size.' },
      { name: 'prior EMI usage', rationale: 'Might matter.', status: 'deferred', basis: 'none', note: 'Manager confirmed they do not track any other pattern beyond ticket size.' },
    ]);

  /**
   * AND THE PROBE IS ON THE SCREEN, since 2026-10-26.
   *
   * `noteClosedOtherAxes` now requires a question we actually asked and they
   * actually answered. MEASURED, `eval/runs/ui-s-1792984906680`: turn 2 went
   * out with `questions: []` — the model wrote "I have enough" — and the next
   * message ended "nothing else", which this wrote down as a closed probe
   * nobody had put. A second pattern closed by a coincidence of wording.
   *
   * So the fixture asks it, the way `recordAsked` does in production. The
   * reply then lands on an outstanding question, which is what `receive`
   * records.
   */
  const asked = (b: WorkingBrief) =>
    recordAsked(
      b,
      [{ text: 'Besides ticket size, is there anything else you have seen that splits who converts?', impact: 'shaping' }],
      'agent',
    );
  const liveTurnFour = () => rows(asked(settled()));

  /**
   * The production ORDER, in one helper: ingest first, then the closure.
   *
   * `receive` closes the question that was on screen and files the reply;
   * `noteClosedOtherAxes` then reads the same sentence. Calling the second
   * without the first is the state nothing produces — and the state the old
   * fixture used, which is why it never noticed the probe was imaginary.
   */
  const closedWith = (said: string) => noteClosedOtherAxes(receive(liveTurnFour(), said).brief, said);

  it('holds before they answer, on the live shape', () => {
    expect(otherAxesProbed(liveTurnFour())).toBe(false);
    expect(codes(liveTurnFour())).toContain('unprobed-other-axes');
  });

  it('clears on what they actually typed', () => {
    for (const said of [
      // THE SENTENCE THE PRODUCT TEACHES, first. SYSTEM says "We do not track
      // that" closes it, the hold's own text invites exactly that answer, and
      // the first-run fixtures type it — and it matched nothing, so the
      // manager said the taught words and the hold reprinted.
      'we do not track that',
      "i don't track that",
      'we dont track that',
      'we dont track anything else',
      'no other pattern, just ticket size',
      'nothing else that splits who converts',
      'we do not have any second split',
      'that is all we track',
    ]) {
      const after = closedWith(said);
      expect(otherAxesProbed(after), said).toBe(true);
      expect(codes(after), said).not.toContain('unprobed-other-axes');
    }
  });

  it('records it as THEIRS, with their words, and leaves the seen axis alone', () => {
    const after = closedWith('we dont track anything else');
    const by = Object.fromEntries((after.dimensions ?? []).map((d) => [d.name, d]));
    for (const name of ['merchant category', 'prior EMI usage']) {
      expect(by[name].basis, name).toBe('user');
      expect(by[name].status, name).toBe('unavailable');
      expect(by[name].note, name).toMatch(/we dont track anything else/);
    }
    // The axis they DID see is untouched, and no axis was invented.
    expect(by['transaction ticket size'].status).toBe('retained');
    expect(by['transaction ticket size'].basis).toBe('user');
    expect(after.dimensions).toHaveLength(liveTurnFour().dimensions!.length);
  });

  it('clears on a brief that has nothing but the seen axis', () => {
    // THE EARLY RETURN, as a test. `noteClosedOtherAxes` used to bail when
    // there was no leftover dimension to rewrite — so on a brief where the
    // agent had never parked a category or card-type row, even a perfect
    // "we don't track anything else" was a no-op and the hold reprinted.
    // The manager answered, and then clerked.
    // The probe is still on the screen — it is the only reason their "we do
    // not track that" is an answer to anything.
    const onlySeen = () =>
      asked(
        recordDimensions(settled(), [
          { name: 'transaction ticket size', rationale: 'They said above ten thousand converts more.', status: 'retained', basis: 'user', note: 'Keep the ₹10,000 line.' },
        ]),
      );
    expect(codes(onlySeen())).toContain('unprobed-other-axes');

    for (const said of ['we do not track that', 'we dont track anything else']) {
      const after = noteClosedOtherAxes(receive(onlySeen(), said).brief, said);
      expect(otherAxesProbed(after), said).toBe(true);
      expect(codes(after), said).not.toContain('unprobed-other-axes');

      // NO AXIS INVENTED. A fake "merchant category" row to satisfy the
      // two-user-dimensions rule would put a customer cut on the record that
      // nobody named, and the next turn could design on it.
      expect(after.dimensions).toHaveLength(1);
      expect(after.dimensions![0].name).toBe('transaction ticket size');
      expect(after.dimensions![0].status).toBe('retained');
      expect(after.dimensions![0].basis).toBe('user');
      // The row is untouched, note and all. A first version of this asserted
      // that no rupee figure appeared anywhere in the dimensions — which the
      // correct behaviour fails, because the manager's OWN "₹10,000 line" is
      // in that note and must survive. The invention worth forbidding is a
      // cutoff the application wrote, and the way to check that is that
      // nothing changed.
      expect(after.dimensions).toEqual(onlySeen().dimensions);
    }
  });

  it('records the close as a quoted FACT, which is what the gate reads', () => {
    // Not a new hold and not a new question: a confirmed fact in their own
    // words, the same instrument `noteOpeningFacts` uses for "no campaign
    // history". The three older legs read dimensions and question text, and
    // a conversation is neither.
    const after = closedWith('we do not track that');
    const fact = (after.facts ?? []).find((f) => f.statement.startsWith(CLOSED_OTHER_AXES));
    expect(fact).toBeTruthy();
    expect(fact!.statement).toMatch(/we do not track that/);
    expect(fact!.statement).toMatch(/transaction ticket size is the axis/i);
    expect(fact!.source).toBe('user-answer');
    expect(fact!.confidence).toBe('confirmed');

    // The fact alone is enough, with no dimension change at all.
    const factOnly = { ...settled(), facts: [...(settled().facts ?? []), fact!] };
    const withAxis = recordDimensions(factOnly, [
      { name: 'transaction ticket size', rationale: 'r', status: 'retained', basis: 'user', note: 'theirs' },
    ]);
    expect(otherAxesProbed(withAxis)).toBe(true);
  });

  it('does not fire on an answer about something else', () => {
    // A converters answer, a barrier answer, a success answer: none of these
    // says there is no second pattern, and none may silence the probe.
    for (const said of [
      'success is the number of transactions converting',
      'txns above 10k get converted more',
      'i think they dont know it is eligible for emi',
      'we do not have conversion data',
      // THE LEAK THIS MUST NOT HAVE. "track that" is anaphoric — it closes
      // the question just asked. A noun object is about the scoreboard, and
      // history already has its own limitation; letting it in here would
      // close a question nobody answered.
      'we do not track conversion rates',
      'we do not track our conversion rate',
      'we have no campaign history',
      'we do not have any data',
    ]) {
      expect(otherAxesProbed(noteClosedOtherAxes(liveTurnFour(), said)), said).toBe(false);
    }
  });

  it('does nothing when there is no single seen axis to lock', () => {
    // Two seen axes is the `stacked-dimensions` conversation, and none is the
    // who-converts one. Neither is this probe, so this must not touch them.
    const none = settled();
    expect(noteClosedOtherAxes(none, 'we dont track anything else')).toEqual(none);
  });
});
