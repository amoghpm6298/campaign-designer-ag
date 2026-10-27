// The strategic-options step: does the agent CHOOSE a design, or elaborate the
// first one that occurred to it?
//
// The defect this locks down, measured on a real OS-to-EMI run (`aud4`): the
// journey step was a flat menu of things to "consider only where they earn
// their place", with a one-directional rule against adding anything. Nothing
// required a verdict on any of them. So the run never mentioned segmentation
// at all — despite discovery having found a genuine segmentation axis, the
// funnel stage of the target customer — and dismissed an A/B test with the
// reasoning that "no prior performance data exists to size or motivate a
// specific variable test yet", which has the argument backwards: no history is
// the reason to run a comparison, not a reason to skip one.
//
// Nothing in the output distinguished "weighed and set aside" from "never
// thought about", which is how a journey ends up a linear chain of sends by
// default rather than by decision.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderStrategy, type Strategy } from '../../server/orchestrator';
import { copyOnlyExperiments } from '../../server/optionAudit';
import type { CampaignBlueprint, BpStep } from '../../server/blueprint';
import { ready } from './support/prompts.ts';

// SYSTEM is module-private; read it from source, same as promptMethod.test.ts.
const SYSTEM = ready();

// NO MORE CHAPTER SLICING. `method` and `optionsStep` used to cut this
// prompt between "HOW TO DESIGN A CAMPAIGN" and "QUESTIONS AND OPEN ITEMS",
// and between "6. The strategic options" and "8. The messages." — titles that
// existed only in the one big SYSTEM. The Plan manual is already only Plan, so
// the whole string is the right scope and a slice keyed on a title that has
// gone silently becomes "the rest of the file".
const method = SYSTEM;
const optionsStep = SYSTEM;

// RULES THAT DID NOT SURVIVE INTO THE MANUALS, flagged here and in
// `server/CLAUDE.md` rather than deleted quietly. Each had a pin in this file:
//
//  - THE SEVEN STRATEGIC OPTIONS. "Record all seven in strategyOptions" and
//    the option/verdict vocabulary are in no manual. `strategyOptions` is not
//    in `propose_strategy`'s schema either, so the prompt was the ONLY thing
//    asking for the field — and `gate.ts`'s segmentation-claim read,
//    `auditOptions`, `applyAudit` and `renderStrategy`'s "Options weighed"
//    all still consume it. They will now always see an empty list.
//  - "every option you marked 'used' should be visible in it" — the rule that
//    an options table must match the journey. It survived one earlier trim of
//    SYSTEM precisely because this pin caught it.
//  - The holdout reasoning: "converted, engaged but did not convert", "the
//    incremental chance of converting again", "you can report what happened,
//    never what would have happened". The Plan manual keeps the conclusion
//    ("the canvas already has a holdout… do not add another") and not the
//    argument for why a holdout is the only honest comparison.
//  - "a single event's value is not a running total", and the warning against
//    a summary presenting the audience as the finding.
//
// The checks in this file that read the AUDIT rather than the prompt are
// untouched: those are structural and are what actually moved behaviour.

describe('the prompt asks for a decision between approaches, not one approach', () => {
  it('requires a materially different alternative to be weighed', () => {
// Replaced by the architecture rule. "Weigh a materially different
    // approach" was satisfied twice by "send one message instead of three",
    // so the requirement now names what must differ.
    expect(ready()).toMatch(/Think of two approaches that are actually different/);
    expect(ready()).toMatch(/different people, a different moment, or a different means/);
    expect(ready()).toMatch(/Fewer messages, a different tone, or a different channel order is the same campaign varied/);
    expect(ready()).toMatch(/Look for the second before you conclude there isn’t one/);
    expect(ready()).toMatch(/Name the rival in the strategy as an alternative you did not take, and why/);
  });

  // EVERYONE ELIGIBLE IS TREATED, 2026-10-21.
  //
  // Measured on the PIN-activation run. The manager named assigned credit
  // limit as a dimension, and the design turned it into three tiers with the
  // lower tier getting an extra touch — which is the right shape. What the
  // prompt never said, and what the audit was actively rewarding, is that a
  // dimension changes the PATH and never the guest list. The segmentation
  // audit counted any entry condition as segmentation, so "filter to the
  // best-looking bucket, then run one path" verified as `used`.
  //
  // These sentences are the counterweight. They are prompt wording, which on
  // its own this project has repeatedly found does not move behaviour — the
  // change that gives them teeth is in `optionAudit.ts`, where an entry
  // condition no longer verifies the claim.
  describe('a dimension changes the path, not who is in the campaign', () => {
    it('defines the audience as everyone eligible who has not done the behaviour', () => {
      expect(ready()).toMatch(/Everyone eligible who has not done the behaviour yet still enters/);
      expect(ready()).toMatch(/Do not ask which group to target/);
    });

    it('says a dimension splits the treatment and not the entry', () => {
      expect(ready()).toMatch(/A pattern about who is likelier changes the treatment, never the door/);
      expect(ready()).toMatch(/each group gets a different treatment inside that door/);
      expect(ready()).toMatch(/A group that mostly acts on its own gets fewer sends as its own path, not as everyone’s default/);
    });

    it('requires a path for the remainder', () => {
      expect(ready()).toMatch(/The rest keep a path/);
      expect(ready()).toMatch(/The split belongs inside the journey, not in the entry rule/);
      expect(ready()).toMatch(/Entry decides who is eligible/);
    });

    it('asks for a split point, never for which group to target', () => {
      // The run asked "Where should the line sit between a low and high
      // assigned credit limit" — which is the right question — but the gate
      // had already asked which of two guess-groups to back, which is not.
      expect(ready()).toMatch(/Do not ask which group to target/);
      // THE CUTOFF RULE SURVIVES, the default does not. The manual says "Do
      // not invent a cutoff"; it does not name median or tertiles as the
      // fallback. Flagged as homeless below.
      expect(optionsStep).toMatch(/Do not invent a cutoff/);
    });

    it('does not let the agent invent more buckets than the dimension needs', () => {
      // HOMELESS: "use only as many buckets as their dimension actually
      // needs" has no counterpart. The nearest surviving rule is that a
      // pattern they have SEEN is what licenses a split at all.
      expect(ready()).toMatch(/If a customer difference they have seen splits people/);
    });

    it('keeps an unbuildable axis in the plan with everyone still messaged', () => {
      // The standing principle in this file: platform capability decides what
      // gets BUILT, never what gets CONSIDERED. The failure mode it has to
      // rule out is quietly cutting to one bucket instead.
      expect(ready()).toMatch(/Leave the intended rule unbuilt/);
      expect(ready()).toMatch(/who they intended, who the campaign will actually reach, and what that costs/);
    });
  });

  // REMOVED, AND FLAGGED: the seven strategic options.
  //
  // "Record all seven in \"strategyOptions\"", the seven option names and the
  // three verdicts are in no manual. `strategyOptions` is not in
  // `propose_strategy`'s schema either, so this prompt chapter was the ONLY
  // thing asking for the field — while `gate.ts`'s segmentation-claim read,
  // `auditOptions`, `applyAudit` and `renderStrategy`'s "Options weighed"
  // section all still consume it. They now always see an empty list.
  //
  // Three tests went with it, each named here so the loss is findable:
  // "names every option the agent must return a verdict on", "makes each
  // option answerable three ways, so silence is not a verdict", and the
  // "every option you marked used should be visible in it" pin at the bottom
  // of this file — which is the one that already survived a trim of SYSTEM
  // once, and is the reason that trim was reverted.
  //
  // The audit tests below are untouched: `auditOptions` still downgrades a
  // claim the journey does not support, which is the half that moved
  // behaviour. What is gone is the agent being asked to make the claim.

  it('corrects the inverted argument that no history means no experiment', () => {
    // The exact reasoning aud4 used to decline an A/B test. The conclusion
    // survives; "it stops you sizing an effect in advance, it does not stop
    // you running the comparison" is homeless and flagged.
    expect(ready()).toMatch(/No history is a reason to test, not a reason to skip/);
  });

  it('asks what would differ between segments, not merely whether they exist', () => {
    expect(ready()).toMatch(/each group gets a different treatment inside that door/);
  });

  it('ties branching to what the customer did with the last message', () => {
    // WAS "converted, engaged but did not convert, or never engaged at all",
    // which is homeless. The manual's version is sharper and is the rule the
    // compiler enforces: fork on what the channel reported, and only where
    // the next job differs.
    expect(ready()).toMatch(/Prefer a reaction where unread and read would actually need a different next job/);
    expect(ready()).toMatch(/If both people would get the same reminder, do not split/);
  });

  it('requires the cost of a message to be weighed against its incremental value', () => {
    expect(ready()).toMatch(/Extra messages have to earn their irritation and cost/);
    // A general instruction to "consider fatigue" is unfalsifiable; naming the
    // weakest message forces an actual judgement.
    expect(ready()).toMatch(/Name the weakest one and say why you kept or cut it/);
  });

  it('forbids claiming causation without a design that can evidence it', () => {
    // The holdout ARGUMENT is homeless — "you can report what happened, never
    // what would have happened" is in no manual. What survives is the
    // conclusion, which is the actionable half.
    expect(optionsStep).toMatch(/A drop-off does not prove its cause/);
    expect(ready()).toMatch(/The canvas already has a holdout. That is the comparison against sending nothing/);
  });
});

describe('platform capability does not decide what is considered', () => {
  it('states the converse of the anti-complexity rule', () => {
    // The existing rule — don't add a branch because the builder supports one
    // — is preserved verbatim elsewhere (promptMethod.test.ts). This is the
    // other direction, which did not exist: don't DROP a strategic option
    // because the builder cannot express it.
    expect(ready()).toMatch(/Recommend the approach that is right for the business even if it cannot be built today/);
    expect(ready()).toMatch(/Do not quietly pick whatever the builder allows/);
    expect(optionsStep).toMatch(/and name the gap/);
  });

  it('leaves the audience-intent and no-proxy rules untouched', () => {
    // These were verified live (`aud4`) and are not in scope to change. A
    // strategy step that re-opened the door to a near-enough attribute would
    // undo that, so they are asserted here too rather than only in their own
    // file.
    expect(ready()).toMatch(/Do not describe a nearby field as if it were theirs/);
    // HOMELESS, both of them: "a single event's value is not a running
    // total" (the running-total trap on a measure) and the warning against a
    // summary presenting the buildable audience as the asked-for one. The
    // nearest survivor is the rule that the gap goes ON the path they are
    // asked to approve, which is the actionable half.
    expect(ready()).toMatch(/put that on the path you send: who they intended, who the campaign will actually reach, and what that costs/);
  });

  it('weighs the approaches BEFORE it writes the path, and the messages last', () => {
    // Order is the point: approaches weighed first, journey built from the
    // winner. Reversed, the "evaluation" is a post-hoc justification of a
    // sequence already written. The old pin read chapter numbers — "6. The
    // strategic options" before "7. The journey." — and the manual's headings
    // carry the same order under their own names.
    expect(SYSTEM.indexOf('Two real approaches, then one journey')).toBeLessThan(SYSTEM.indexOf('The path'));
    expect(SYSTEM.indexOf('The path')).toBeLessThan(SYSTEM.indexOf('The messages'));
    // HOMELESS: 'every option you marked "used" should be visible in it' —
    // the rule that the options table must match the journey that was sent.
    // It has no counterpart, and it is the pin that caught an earlier trim of
    // SYSTEM and got that trim reverted. What survives is the same idea
    // applied to the approach rather than the table.
    expect(ready()).toMatch(/The path must show the approach you picked. If it does not show it, you did not use it/);
  });
});

describe('renderStrategy shows the verdicts', () => {
  const base: Strategy = { summary: 'S.', approach: ['A'], assumptions: [], unknowns: [] };

  it('renders each option with a readable verdict', () => {
    const out = renderStrategy({
      ...base,
      strategyOptions: [
        { option: 'Segmentation', verdict: 'used', why: 'Two funnel stages need different openings.' },
        { option: 'Experimentation', verdict: 'not-applicable', why: 'One hypothesis, nothing to compare against yet.' },
        { option: 'Channel fallback', verdict: 'cannot-evaluate', why: 'Delivery-failure rates per channel are unknown.' },
      ],
    });
    expect(out).toContain('**Options weighed**');
    expect(out).toContain('- Segmentation — used. Two funnel stages need different openings.');
    // The raw enum values are machine vocabulary and must not reach the user.
    expect(out).toContain('- Experimentation — not applicable here.');
    expect(out).toContain('- Channel fallback — cannot evaluate yet.');
    expect(out).not.toContain('not-applicable');
    expect(out).not.toContain('cannot-evaluate');
  });

  it('shows the options between the approach and the rejected alternatives', () => {
    // The reading order is: what we are doing, what we weighed, what we turned
    // down. Options landing after the rejections would read as an afterthought.
    const out = renderStrategy({
      ...base,
      strategyOptions: [{ option: 'Segmentation', verdict: 'used', why: 'w' }],
      rejected: [{ option: 'A different approach', why: 'w' }],
    });
    expect(out.indexOf('**Approach**')).toBeLessThan(out.indexOf('**Options weighed**'));
    expect(out.indexOf('**Options weighed**')).toBeLessThan(out.indexOf('**Considered and not used**'));
  });

  it('omits the section entirely when nothing was recorded', () => {
    // An empty heading would imply the evaluation happened and found nothing.
    expect(renderStrategy(base)).not.toContain('Options weighed');
    expect(renderStrategy({ ...base, strategyOptions: [] })).not.toContain('Options weighed');
  });

  it('still renders an older strategy that predates the field', () => {
    // Strategies are round-tripped by the client across turns, so a response
    // recorded before this change must not break the renderer.
    const legacy = JSON.parse('{"summary":"S.","approach":["A"],"assumptions":[],"unknowns":[],"successCriteria":["C"]}') as Strategy;
    const out = renderStrategy(legacy);
    expect(out).toContain('**Success criteria**');
    expect(out).not.toContain('Options weighed');
  });

  it('does not crash when rejected is a sentence instead of a list', () => {
    // Live EMI turn, 2026-10-23: the model sent rejected as one string.
    // `s.rejected.map is not a function` — Confirm never appeared.
    const out = renderStrategy({
      ...base,
      rejected: 'A daily digest would miss the 30-minute window.' as never,
    });
    expect(out).toContain('**Considered and not used**');
    expect(out).toContain('A daily digest would miss the 30-minute window.');
  });
});

// ---------------------------------------------------------------------------
// Copy is not structure.
//
// FOUND IN A LIVE RUN. `optionAudit`'s own `signature` includes each send's
// copy text, so an experiment whose two arms ran byte-identical journeys with
// different wording compared as DIFFERENT and its claim stood. The run was
// the goal counterfactual's count arm: "interest-cost savings framing vs
// affordability/simplicity framing", one journey, two scripts. I had
// attributed that failure to the prompt. It was this function.
describe('an experiment that only varies wording is reported as such', () => {
  const send = (copy: string): BpStep => ({
    kind: 'send', name: 'n', objective: ['emi'], stage: 'first-touch', describe: 'd', copy,
  });
  const withArms = (a: BpStep[], b: BpStep[]): CampaignBlueprint => ({
    campaignName: 'c', description: 'd', goal: null,
    entry: { kind: 'audience', entity: 'Account' },
    steps: [{ kind: 'experiment', label: 'framing test', arms: [
      { label: 'cost framing', pct: 50, steps: a },
      { label: 'simplicity framing', pct: 50, steps: b },
    ] }],
  });

  it('flags arms that differ only in copy', () => {
    const r = copyOnlyExperiments(withArms(
      [send('Here is what EMI costs you.'), { kind: 'wait', durationHours: 48 }],
      [send('Converting takes two taps.'), { kind: 'wait', durationHours: 48 }],
    ));
    expect(r).toHaveLength(1);
    expect(r[0].label).toBe('framing test');
    expect(r[0].arms).toEqual(['cost framing', 'simplicity framing']);
  });

  it('does not flag arms that vary something a customer experiences', () => {
    expect(copyOnlyExperiments(withArms(
      [send('x')],
      [{ kind: 'wait', durationHours: 240 }, send('x')],
    ))).toEqual([]);
  });

  it('does not flag arms that switch channel, which a customer notices', () => {
    // The line between copy and channel. Verified against a real run's raw
    // blueprint: its arms used EMAIL then SMS then WHATSAPP identically in
    // both, so the flag was correct there. This pins the other side of it.
    const email: BpStep = { kind: 'send', name: 'n', objective: ['x'], stage: 'first-touch', describe: 'd', channelPreference: ['EMAIL'] };
    const sms: BpStep = { ...email, channelPreference: ['SMS'] } as BpStep;
    expect(copyOnlyExperiments(withArms([email], [sms]))).toEqual([]);
  });

  it('does not flag a campaign with no experiment', () => {
    expect(copyOnlyExperiments({
      campaignName: 'c', description: 'd', goal: null,
      entry: { kind: 'audience', entity: 'Account' }, steps: [send('x')],
    })).toEqual([]);
  });
});

// A verdict must not contradict itself.
//
// THE DEFECT, visible in a live proposal: candidates that genuinely differed
// were announced as "These were not materially different approaches" in the
// same breath as "2 candidates differ in who they reach, when, or what the
// journey does." Two true findings about two different questions had been
// collapsed into one status field.
describe('comparison verdict and design warnings stay separate', () => {
  const base: Strategy = {
    summary: 'S',
    architectures: [
      { name: 'A', entry: 'Audience Account', mechanism: 'm', timing: 't', tradeoff: 'x', chosen: true },
      { name: 'B', entry: 'Event Transaction', mechanism: 'm2', timing: 't2', tradeoff: 'y', chosen: false },
    ],
  } as Strategy;

  it('does not deny differentiation when the candidates did differ', () => {
    const out = renderStrategy(
      { ...base,
        architectureComparison: { status: 'differentiated', why: 'They differ in who they reach.' },
        designWarnings: ['The experiment runs the same journey in every arm.'] } as Strategy,
      [], null, [], [], [],
    );
    expect(out).not.toContain('These were not materially different approaches');
    expect(out).toContain('**What this design cannot do**');
    expect(out).toContain('same journey in every arm');
  });

  it('still reports a genuinely insufficient comparison', () => {
    const out = renderStrategy(
      { ...base, architectureComparison: { status: 'insufficient', why: 'One campaign described twice.' } } as Strategy,
      [], null, [], [], [],
    );
    expect(out).toContain('These were not materially different approaches');
    expect(out).not.toContain('**What this design cannot do**');
  });

  it('says nothing extra when the design is clean', () => {
    const out = renderStrategy(
      { ...base, architectureComparison: { status: 'differentiated', why: 'ok' }, designWarnings: [] } as Strategy,
      [], null, [], [], [],
    );
    expect(out).not.toContain('**On those alternatives**');
    expect(out).not.toContain('**What this design cannot do**');
  });
});
