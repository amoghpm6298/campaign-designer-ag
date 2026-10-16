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

  // Different groups must actually receive different treatment somewhere.
  segmentation: (bp) => {
    const branches = conditions(bp).length + experiments(bp).length;
    const narrowed = (bp.entry?.conditions ?? []).length > 0;
    return branches || narrowed
      ? null
      : 'the journey has one path for everyone and the entry narrows nobody, so no group is treated differently.';
  },
};

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
