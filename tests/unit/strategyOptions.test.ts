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

// SYSTEM is module-private; read it from source, same as promptMethod.test.ts.
const SYSTEM = (() => {
  const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
  return /const SYSTEM = `([\s\S]*?)`;\n/.exec(src)![1];
})();

const method = SYSTEM.slice(SYSTEM.indexOf('HOW TO DESIGN A CAMPAIGN'), SYSTEM.indexOf('QUESTIONS AND OPEN ITEMS'));
const optionsStep = SYSTEM.slice(
  SYSTEM.indexOf('6. The strategic options'),
  SYSTEM.indexOf('8. The messages.'),
);

describe('the prompt asks for a decision between approaches, not one approach', () => {
  it('requires a materially different alternative to be weighed', () => {
// Replaced by the architecture rule. "Weigh a materially different
    // approach" was satisfied twice by "send one message instead of three",
    // so the requirement now names what must differ.
    expect(optionsStep).toMatch(/BUILD TWO CANDIDATE ARCHITECTURES, THEN CHOOSE/);
    expect(optionsStep).toMatch(/the entry and audience \(who is reached\), the mechanism[\s\S]*?and the triggering and timing logic/);
    expect(optionsStep).toMatch(/FEWER MESSAGES IS NOT A DIFFERENT APPROACH/);
    expect(optionsStep).toMatch(/reach DIFFERENT PEOPLE, at a DIFFERENT MOMENT, or by a DIFFERENT MEANS/);
    expect(optionsStep).toMatch(/mark the winner with why it won — citing what you were told/);
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
      expect(method).toMatch(/THE AUDIENCE IS EVERYONE ELIGIBLE WHO HAS NOT DONE THE BEHAVIOUR YET/);
      expect(method).toMatch(/Narrowing it to the group most likely to respond is not strategy/);
    });

    it('says a dimension splits the treatment and not the entry', () => {
      expect(optionsStep).toMatch(/EVERY ELIGIBLE CUSTOMER IS STILL TREATED/);
      expect(optionsStep).toMatch(/never shrinks the entry to the best-looking bucket/);
      expect(optionsStep).toMatch(/The high-limit customers still enter; they may simply get fewer touches/);
    });

    it('requires a path for the remainder', () => {
      expect(optionsStep).toMatch(/If you split, give the remainder a path, so whoever is left still gets a campaign/);
      expect(method).toMatch(/A SPLIT BELONGS INSIDE THE JOURNEY, NOT AT THE DOOR/);
      expect(method).toMatch(/Entry conditions decide who is ELIGIBLE; they are not segmentation/);
    });

    it('asks for a split point, never for which group to target', () => {
      // The run asked "Where should the line sit between a low and high
      // assigned credit limit" — which is the right question — but the gate
      // had already asked which of two guess-groups to back, which is not.
      expect(optionsStep).toMatch(/do not ask which group to target — ask only where the split sits/);
      expect(optionsStep).toMatch(/default to the cohort's own median or tertiles rather than inventing a rupee cutoff/);
    });

    it('does not let the agent invent more buckets than the dimension needs', () => {
      expect(optionsStep).toMatch(/use only as many buckets as their dimension actually needs/);
    });

    it('keeps an unbuildable axis in the plan with everyone still messaged', () => {
      // The standing principle in this file: platform capability decides what
      // gets BUILT, never what gets CONSIDERED. The failure mode it has to
      // rule out is quietly cutting to one bucket instead.
      expect(optionsStep).toMatch(/keep the buckets in the plan, say they cannot be built yet, and still message everyone on one path/);
    });
  });

  it('names every option the agent must return a verdict on', () => {
    for (const option of [
      'Segmentation',
      'Experimentation',
      'Conditional branching',
      'Channel fallback',
      'Adaptive sequencing',
      'Cost and fatigue',
      'Measurement and learning',
    ]) {
      expect(optionsStep, option).toContain(option);
    }
  });

  it('makes each option answerable three ways, so silence is not a verdict', () => {
    for (const verdict of ['"used"', '"not-applicable"', '"cannot-evaluate"']) {
      expect(optionsStep, verdict).toContain(verdict);
    }
    expect(optionsStep).toMatch(/Record all seven in "strategyOptions"/);
    expect(optionsStep).toMatch(/both read as silence, so say which it was/);
  });

  it('corrects the inverted argument that no history means no experiment', () => {
    // The exact reasoning aud4 used to decline an A/B test.
    expect(optionsStep).toMatch(/Having no performance history is a reason TO test, not a reason to skip it/);
    expect(optionsStep).toMatch(/it stops you sizing an effect in advance, it does not stop you running the comparison/);
  });

  it('asks what would differ between segments, not merely whether they exist', () => {
    expect(optionsStep).toMatch(/deserve a DIFFERENT treatment, rather than one treatment for everyone/);
    expect(optionsStep).toMatch(/Name the groups and what would differ between them/);
  });

  it('ties branching to customer behaviour, including non-engagement', () => {
    expect(optionsStep).toMatch(/converted, engaged but did not convert, or never engaged at all/);
  });

  it('requires the cost of a message to be weighed against its incremental value', () => {
    expect(optionsStep).toMatch(/incremental chance of converting against its cost and the irritation it adds/);
    // A general instruction to "consider fatigue" is unfalsifiable; naming the
    // weakest message forces an actual judgement.
    expect(optionsStep).toMatch(/Name the weakest message and say why you kept or cut it/);
  });

  it('forbids claiming causation without a design that can evidence it', () => {
    expect(optionsStep).toMatch(/you can report what happened, never what the campaign CAUSED/);
    expect(optionsStep).toMatch(/Say which you have/);
  });
});

describe('platform capability does not decide what is considered', () => {
  it('states the converse of the anti-complexity rule', () => {
    // The existing rule — don't add a branch because the builder supports one
    // — is preserved verbatim elsewhere (promptMethod.test.ts). This is the
    // other direction, which did not exist: don't DROP a strategic option
    // because the builder cannot express it.
    expect(optionsStep).toMatch(/Judge each on the business case, never on what the builder supports/);
    expect(optionsStep).toMatch(/Platform capability decides what gets BUILT, never what gets CONSIDERED/);
    expect(optionsStep).toMatch(/unbuildable today is still recommended, kept in the strategy in full/);
    expect(optionsStep).toMatch(/Never quietly downgrade it to a weaker thing the builder allows/);
  });

  it('leaves the audience-intent and no-proxy rules untouched', () => {
    // These were verified live (`aud4`) and are not in scope to change. A
    // strategy step that re-opened the door to a near-enough attribute would
    // undo that, so they are asserted here too rather than only in their own
    // file.
    expect(method).toMatch(/DO NOT CLOSE THAT GAP WITH A NEAR-ENOUGH ATTRIBUTE/);
    expect(method).toMatch(/a single event's value is not a running total/);
    expect(method).toMatch(/Never let the summary present the audience you CAN build as if it were the audience they asked for/);
  });

  it('keeps the options step before the journey, not after it', () => {
    // Order is the point: options weighed first, journey built from the
    // winner. Reversed, the "evaluation" is a post-hoc justification of a
    // sequence already written.
    expect(SYSTEM.indexOf('6. The strategic options')).toBeLessThan(SYSTEM.indexOf('7. The journey.'));
    expect(SYSTEM.indexOf('7. The journey.')).toBeLessThan(SYSTEM.indexOf('8. The messages.'));
    expect(SYSTEM).toMatch(/every option you marked "used" should be visible in it/);
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
