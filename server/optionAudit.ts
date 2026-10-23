// Does the journey do what the strategy says it does?
//
// RULE 2.4. The agent grades its own strategic options, and the grades drifted
// from the design. Measured on a real OS-to-EMI run:
//
//   "Adaptive sequencing — used."   ...against a fixed 48h/72h ladder, with
//   the same sentence admitting "a qualitative adaptation, not a precise one".
//
// A reader scanning the options table saw a richer campaign than the blueprint
// contained. That is self-certification, and it is checkable: the journey is
// structured data, so a claim about its shape can be verified rather than
// believed.
//
// WHAT THIS DOES NOT DO. It never rewrites the journey and never invents a
// capability. It reads the proposed blueprint, decides whether a `used` claim
// is SUPPORTED by it, and downgrades the ones that are not — with the reason.
// Two options (measurement, cost and fatigue) are not structural properties of
// a journey and are left to the model, named here so the gap is explicit
// rather than silent.
import type { CampaignBlueprint, BpStep } from './blueprint';

export type OptionVerdict = 'used' | 'not-applicable' | 'cannot-evaluate';

export interface StrategyOption {
  option: string;
  verdict: OptionVerdict;
  why: string;
}

export interface OptionAudit {
  option: string;
  claimed: OptionVerdict;
  /** What the journey supports. Only ever equal to or weaker than `claimed`. */
  verified: OptionVerdict;
  /** Present when the claim was not supported. */
  gap?: string;
}

/** Flattens a journey, descending into experiment arms and condition branches. */
function walk(steps: BpStep[] | undefined, out: BpStep[] = []): BpStep[] {
  for (const s of steps ?? []) {
    out.push(s);
    if (s.kind === 'experiment') for (const a of s.arms ?? []) walk(a.steps, out);
    if (s.kind === 'condition') {
      walk(s.yes, out);
      walk(s.no, out);
    }
  }
  return out;
}

const all = (bp: CampaignBlueprint) => walk(bp.steps);
const conditions = (bp: CampaignBlueprint) => all(bp).filter((s) => s.kind === 'condition');
const experiments = (bp: CampaignBlueprint) => all(bp).filter((s) => s.kind === 'experiment');
const waitsForEvent = (bp: CampaignBlueprint) => all(bp).filter((s) => s.kind === 'waitForEvent');

/** The shape of a branch, for comparing one against another. */
/**
 * The same walk, blind to wording.
 *
 * MEASURED, and it corrected my own earlier diagnosis. `signature` below
 * includes each send's copy text, so two experiment arms that run the
 * identical journey with different words compare as DIFFERENT, and the
 * experimentation claim stands. That is why a live run's experiment —
 * "interest-cost savings framing vs affordability/simplicity framing", two
 * byte-identical journeys — passed this audit. I had put that down to the
 * prompt not insisting hard enough. It was this function.
 *
 * Both signatures are needed and neither replaces the other. Where copy IS
 * the variable under test, differing copy is the point. Where the question is
 * whether the JOURNEY does something different, copy is noise.
 */
function structuralSignature(steps: BpStep[] | undefined): string {
  return walk(steps)
    .map((s) =>
      s.kind === 'send'
        // Channel counts, copy does not. A customer notices being reached on
        // SMS instead of email; they do not notice two wordings of one message.
        ? `send:${s.stage}:${(s.channelPreference ?? []).join('|')}`
        : s.kind === 'wait'
          ? `wait:${s.durationHours}`
          : s.kind === 'waitForEvent'
            ? `waitForEvent:${s.eventType}:${s.timeoutDays}`
            : s.kind,
    )
    .join('>');
}

/**
 * Experiments whose arms differ only in what the messages say.
 *
 * A copy test is a legitimate experiment and this does not call it otherwise.
 * What it establishes is the LIMIT of what such a test can show: varying
 * wording can tell you which wording performs better, and cannot tell you
 * which underlying customer barrier was real. A strategy that claims the
 * second from an experiment built like this is claiming something its own
 * design cannot deliver.
 */
export function copyOnlyExperiments(
  bp: CampaignBlueprint | null | undefined,
): { label: string; arms: string[] }[] {
  const out: { label: string; arms: string[] }[] = [];
  const visit = (steps: BpStep[] | undefined) => {
    for (const s of steps ?? []) {
      if (s.kind === 'experiment') {
        const groups = new Map<string, string[]>();
        for (const a of s.arms ?? []) {
          const k = structuralSignature(a.steps);
          groups.set(k, [...(groups.get(k) ?? []), a.label]);
        }
        const same = [...groups.values()].filter((g) => g.length > 1).flat();
        if (same.length) out.push({ label: s.label, arms: same });
        for (const a of s.arms ?? []) visit(a.steps);
      }
      if (s.kind === 'condition') { visit(s.yes); visit(s.no); }
    }
  };
  visit(bp?.steps);
  return out;
}

function signature(steps: BpStep[] | undefined): string {
  return walk(steps)
    .map((s) =>
      s.kind === 'send'
        ? `send:${(s.channelPreference ?? []).join('|')}:${(s.copy ?? s.describe ?? '').trim().toLowerCase()}`
        : s.kind === 'wait'
          ? `wait:${s.durationHours}`
          : s.kind,
    )
    .join('>');
}

/** The channel a send prefers, for fallback comparison. */
const channelOf = (s: BpStep | undefined) =>
  s && s.kind === 'send' ? (s.channelPreference ?? []).join('|') : '';

/** First send inside a branch, at any depth. */
const firstSend = (steps: BpStep[] | undefined) => walk(steps).find((s) => s.kind === 'send');

/**
 * Every condition paired with the send immediately before it at the same
 * level — the send whose delivery the condition is testing.
 *
 * Fallback is about the channel that FAILED, not about the two branches
 * differing from each other. Walking the flat list cannot express that, which
 * is why this descends level by level.
 */
function conditionsWithPrecedingSend(
  steps: BpStep[] | undefined,
  out: { condition: Extract<BpStep, { kind: 'condition' }>; precededBy?: BpStep }[] = [],
) {
  let lastSend: BpStep | undefined;
  for (const s of steps ?? []) {
    if (s.kind === 'send') lastSend = s;
    if (s.kind === 'condition') {
      out.push({ condition: s, precededBy: lastSend });
      conditionsWithPrecedingSend(s.yes, out);
      conditionsWithPrecedingSend(s.no, out);
    }
    if (s.kind === 'experiment') for (const a of s.arms ?? []) conditionsWithPrecedingSend(a.steps, out);
  }
  return out;
}

/**
 * Checks keyed by the option name the prompt uses. A name with no checker is
 * left alone — the application does not pretend to verify what it cannot see.
 */
const CHECKS: Record<string, (bp: CampaignBlueprint) => string | null> = {
  // Timing or the next action must respond to something. A chain of
  // send/wait/exit is a ladder however its copy is worded.
  'adaptive sequencing': (bp) => {
    if (conditions(bp).length || waitsForEvent(bp).length) return null;
    const waits = all(bp).filter((s) => s.kind === 'wait');
    return waits.length
      ? 'the journey is a fixed sequence of sends and waits with no condition or wait-for-event, so nothing in it responds to a signal. Urgency in the wording is not adaptive timing.'
      : 'the journey contains no condition, wait-for-event or varying timing, so there is nothing for it to adapt to.';
  },

  // A fork whose arms do the same thing is a label, not a branch.
  'conditional branching': (bp) => {
    const cs = conditions(bp);
    if (!cs.length) return 'the journey contains no condition step.';
    const meaningful = cs.some((c) => c.kind === 'condition' && signature(c.yes) !== signature(c.no));
    return meaningful
      ? null
      : 'every condition leads to the same sequence of actions on both branches, so the fork changes nothing the customer experiences.';
  },

  // The failure path has to actually change how delivery is attempted.
  // FALSE POSITIVE FIXED. The first version compared the two branches against
  // each other, and reported a correct fallback as unimplemented: the agent
  // opened on EMAIL, and on non-delivery re-sent the OPENING on SMS while the
  // delivered path moved on to a reminder, also on SMS. Both branches began
  // with SMS, so branch-vs-branch saw no change — but the customer whose email
  // failed was reached on a different channel, which is exactly the mechanism.
  //
  // The comparison that matters is against the send that FAILED.
  'channel fallback': (bp) => {
    const pairs = conditionsWithPrecedingSend(bp.steps);
    if (!pairs.length) return 'the journey contains no condition step on a delivery outcome.';
    const changes = pairs.some(({ condition, precededBy }) => {
      const failure = channelOf(firstSend(condition.no));
      if (!failure) return false;
      // Against the send being tested where there is one; otherwise the only
      // comparison available is the other branch.
      const tested = channelOf(precededBy);
      return tested ? failure !== tested : failure !== channelOf(firstSend(condition.yes));
    });
    return changes
      ? null
      : 'no condition routes the failure path to a channel other than the one that failed, so delivery is attempted the same way either way.';
  },

  // Arms must differ, or it is one treatment counted twice.
  experimentation: (bp) => {
    const xs = experiments(bp).filter((s) => s.kind === 'experiment');
    const hasControl = typeof bp.controlPct === 'number' && bp.controlPct > 0;
    if (!xs.length) {
      return hasControl
        ? null // a holdout alone is a legitimate, weaker read, and is claimed as such
        : 'the journey contains no experiment step and no control group, so there is nothing to compare.';
    }
    const differ = xs.some((x) => {
      if (x.kind !== 'experiment') return false;
      const sigs = (x.arms ?? []).map((a) => signature(a.steps));
      return sigs.length > 1 && new Set(sigs).size > 1;
    });
    return differ
      ? null
      : 'the experiment arms contain identical steps and copy, so both arms are the same treatment.';
  },

  // Different groups must actually receive different treatment somewhere
  // INSIDE the journey.
  //
  // ENTRY CONDITIONS USED TO COUNT, and that was the defect. The check read
  // `branches || narrowed`, where `narrowed` was simply "the entry has at
  // least one condition" — so a campaign that filtered at the door and then
  // ran one path for the survivors verified Segmentation as `used`. It
  // rewarded the opposite of segmentation. Narrowing the entry does not treat
  // two groups differently; it removes one of them.
  //
  // An entry condition is ELIGIBILITY — not yet PIN-set, card issued inside
  // the window. Every eligible customer is supposed to be treated: a
  // dimension decides which PATH they take, never whether they are in the
  // campaign at all. So the only thing that verifies this claim now is a
  // split inside the journey, and it has to carry a path for the remainder:
  // a condition sending one group down an empty branch is the same filter
  // moved one step later.
  //
  // An experiment with differing arms counts, including one with a holdout.
  // A holdout is an arm — declared, measured and accounted for — not a group
  // quietly dropped.
  segmentation: (bp) => {
    const splits = conditions(bp).filter(
      (c): c is Extract<BpStep, { kind: 'condition' }> => c.kind === 'condition',
    );
    const differential = splits.filter((c) => signature(c.yes) !== signature(c.no));
    const keepsEveryone = differential.filter((c) => c.yes.length > 0 && c.no.length > 0);
    const armedExperiments = experiments(bp).filter(
      (x) => x.kind === 'experiment' && new Set((x.arms ?? []).map((a) => signature(a.steps))).size > 1,
    );
    if (keepsEveryone.length || armedExperiments.length) return null;
    if (differential.length) {
      return 'the only split sends one group down an empty branch, so it filters rather than segments — whoever is on that side gets no campaign at all.';
    }
    if (splits.length) {
      return 'every condition leads to the same actions on both sides, so no group is treated differently.';
    }
    return 'the journey has one path for everyone, so no group is treated differently. Entry conditions decide who is eligible, not who is treated differently, so they cannot carry this claim.';
  },
};

/**
 * Does the BUILT journey move on what the customer did?
 *
 * MEASURED, `eval/runs/ui-s-1792738033056` turn 4. The approved strategy said
 * branch-on-response and named SMS for when WhatsApp does not land. What was
 * built: one condition on Transaction Amount, an experiment whose two arms ran
 * the same cadence, and ten WhatsApp sends. The compiler stamped a Goal Check
 * after each one. The manager read "Built the journey… It is on the canvas
 * now." and looked at a vanilla drip.
 *
 * THREE THINGS THAT LOOK LIKE A REACTION AND ARE NOT:
 *
 *  - `condition.on` — a customer ATTRIBUTE read at a point in the journey.
 *    Ticket size, prior holding, limit band. That is segmentation: it decides
 *    which path a person takes on the way IN, and says nothing about what
 *    they did with the last message.
 *  - a Goal Check after every send, which the COMPILER inserts. It is the
 *    platform's own terminal, not a decision the agent designed, and it is
 *    not in the blueprint at all — which is why this reads the blueprint.
 *  - `fallbackChannel` on a Send. A field, not a fork: nobody takes a
 *    different route, the delivery attempt is simply retried.
 *
 * SEPARATE FROM `CHECKS['conditional branching']`, deliberately. That one
 * decides whether to downgrade a `used` claim in the options table, several
 * tests rest on any condition counting there, and a footnote and a hard build
 * consequence should not share a definition without being asked to.
 */
export function journeyReacts(bp: CampaignBlueprint | null | undefined): boolean {
  if (!bp) return false;
  // Holding until the customer does something is the purest form of it.
  if (waitsForEvent(bp).length) return true;

  // A fork on the PRECEDING SEND's delivery or read outcome, whose two sides
  // then do different things. Both halves are needed: a condition on
  // `outcomes` that runs the identical sequence either way is a label.
  const outcomeForks = conditions(bp).filter(
    (c): c is Extract<BpStep, { kind: 'condition' }> => c.kind === 'condition' && (c.outcomes ?? []).length > 0,
  );
  if (outcomeForks.some((c) => structuralSignature(c.yes) !== structuralSignature(c.no))) return true;

  // The channel-fallback shape, asked of the same conditions: the failure
  // path is attempted on a channel other than the one that just failed.
  //
  // REDUNDANT TODAY AND KEPT ON PURPOSE. `structuralSignature` includes each
  // send's channel, so a fallback to a different channel already differs
  // above. It is written out because it is the mechanism's own definition
  // rather than a consequence of how the signature happens to be built — if
  // the signature ever stops carrying the channel, this leg still holds.
  return conditionsWithPrecedingSend(bp.steps).some(({ condition, precededBy }) => {
    if (!(condition.outcomes ?? []).length) return false;
    const failure = channelOf(firstSend(condition.no));
    const tested = channelOf(precededBy);
    return Boolean(failure && tested) && failure !== tested;
  });
}

/**
 * Options whose truth is not a property of the journey's shape. Named rather
 * than silently skipped, so "unchecked" never reads as "verified".
 */
export const UNCHECKABLE_OPTIONS = ['measurement and learning', 'cost and fatigue'] as const;

const key = (option: string) => option.trim().toLowerCase();

/**
 * Verifies every `used` claim against the proposed journey.
 *
 * Only ever downgrades. A claim of 'not-applicable' or 'cannot-evaluate' is
 * the agent declining to use something, which needs no proof.
 */
export function auditOptions(
  options: StrategyOption[] | undefined,
  blueprint: CampaignBlueprint | null | undefined,
): OptionAudit[] {
  if (!options?.length || !blueprint) return [];
  return options.map((o) => {
    const check = CHECKS[key(o.option)];
    if (o.verdict !== 'used' || !check) return { option: o.option, claimed: o.verdict, verified: o.verdict };
    const gap = check(blueprint);
    return gap
      ? { option: o.option, claimed: 'used' as const, verified: 'cannot-evaluate' as const, gap }
      : { option: o.option, claimed: o.verdict, verified: o.verdict };
  });
}

/** The claims the journey did not support. */
export const unsupportedClaims = (audits: OptionAudit[]) => audits.filter((a) => a.gap);

/**
 * Applies the audit to the options themselves, so what the user reads and what
 * the record holds agree. The agent's own reason is kept and the correction
 * appended — never substituted, so its reasoning survives next to the fact
 * that the journey did not bear it out.
 */
export function applyAudit(options: StrategyOption[] | undefined, audits: OptionAudit[]): StrategyOption[] {
  if (!options?.length) return options ?? [];
  return options.map((o) => {
    const a = audits.find((x) => x.option === o.option);
    if (!a?.gap) return o;
    return {
      ...o,
      verdict: a.verified,
      why: `${o.why} [Not supported by the proposed journey: ${a.gap}]`,
    };
  });
}
