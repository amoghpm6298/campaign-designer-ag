// Are the candidate architectures actually different, and is the winner the
// one that got built?
//
// Two checks, with very different strengths, kept apart deliberately:
//
//   1. COMPARISON — are the candidates distinguishable? This can only ever
//      DOWNGRADE a claim. It catches candidates that are structurally the
//      same campaign. It cannot catch two differently-worded descriptions of
//      one intervention, and it cannot tell whether either is any good.
//
//   2. FIDELITY — does the journey behaviour the winner DECLARED actually
//      appear in the blueprint that was built? This one is hard. The declared
//      value comes from a closed vocabulary, every member of which is
//      derivable from the real blueprint step kinds, so a mismatch is a fact
//      rather than an opinion.
//
// The division of labour is the point. `mechanism` stays prose, because no
// string comparison can establish that "reduce perceived cost" and "improve
// cost comprehension" are the same intervention or different ones — asking
// code to judge that would be theatre. What code can check is consequences.
import type { CampaignBlueprint, BpStep } from './blueprint';
import { reactsToDelivery } from './optionAudit';

/**
 * What a journey DOES, in terms the platform can actually express.
 *
 * Every value here is derivable from a built blueprint (see `derive`), which
 * is what makes the fidelity check real. Values that sound meaningful but
 * cannot be read back off a blueprint are deliberately absent: declaring
 * something unverifiable would just move the problem.
 */
export const JOURNEY_BEHAVIOURS = [
  /** Sends and waits on a fixed cadence. Nothing reacts to the customer. */
  'linear',
  /** Forks on how the customer responded to an earlier send. */
  'branch-on-response',
  /** Holds until the customer does something, with a timeout. */
  'wait-for-event',
  /** Randomised arms, to learn something the bank does not know. */
  'experiment',
] as const;

export type JourneyBehaviour = (typeof JOURNEY_BEHAVIOURS)[number];

export const isJourneyBehaviour = (v: unknown): v is JourneyBehaviour =>
  typeof v === 'string' && (JOURNEY_BEHAVIOURS as readonly string[]).includes(v);

/**
 * Every journey behaviour actually present in a built blueprint.
 *
 * `branch-on-response` IS NOT "CONTAINS A CONDITION", corrected 2026-10-23.
 * It was, and that is the same false positive `journeyReacts` was written to
 * kill one slice earlier: a condition on Transaction Amount is a who-split,
 * and counting it here meant `checkFidelity` would confirm a declared
 * branch-on-response journey against a campaign that branches on the
 * CUSTOMER rather than on anything they did. The audit would have blessed the
 * exact build the reaction retry refuses.
 *
 * `reactsToDelivery` is the shared definition, imported rather than restated:
 * a fork on the preceding send's delivery or read outcome whose sides differ,
 * or the channel-fallback pair. Two copies of this rule would drift, and the
 * drift would be invisible — both halves would still pass their own tests.
 *
 * The wait is tagged separately and deliberately NOT folded in here.
 * `journeyReacts` is `reactsToDelivery` OR a wait-for-event, which is the
 * right question for "does this journey move at all"; for a per-behaviour
 * inventory, calling a wait-for-event journey `branch-on-response` as well
 * would be a second claim the agent never made.
 */
export function derive(bp: CampaignBlueprint | null | undefined): Set<JourneyBehaviour> {
  const found = new Set<JourneyBehaviour>();
  const walk = (steps: BpStep[] | undefined) => {
    for (const s of steps ?? []) {
      if (s.kind === 'send' || s.kind === 'wait') found.add('linear');
      if (s.kind === 'waitForEvent') found.add('wait-for-event');
      // Descended into, never tagged. A condition is the step that CARRIES a
      // reaction; whether it is one is `reactsToDelivery`'s to say, below.
      if (s.kind === 'condition') { walk(s.yes); walk(s.no); }
      if (s.kind === 'experiment') {
        found.add('experiment');
        for (const a of s.arms ?? []) walk(a.steps);
      }
    }
  };
  walk(bp?.steps);
  if (reactsToDelivery(bp)) found.add('branch-on-response');
  return found;
}

// ------------------------------------------- can the experiment settle that?

export interface ClaimViolation {
  label: string;
  claim: string;
  /** Arms that are the same journey as each other. */
  identicalArms: string[];
  why: string;
}

/** Structure a customer would notice. Copy is excluded; channel is not. */
function armShape(steps: BpStep[] | undefined): string {
  const out: string[] = [];
  const walk = (ss: BpStep[] | undefined) => {
    for (const s of ss ?? []) {
      if (s.kind === 'send') out.push(`send:${s.stage}:${(s.channelPreference ?? []).join('|')}`);
      else if (s.kind === 'wait') out.push(`wait:${s.durationHours}`);
      else if (s.kind === 'waitForEvent') out.push(`event:${s.eventType}:${s.timeoutDays}`);
      else if (s.kind === 'exit') out.push('exit');
      else if (s.kind === 'condition') { out.push('cond['); walk(s.yes); out.push('|'); walk(s.no); out.push(']'); }
      else if (s.kind === 'experiment') { out.push('exp['); for (const a of s.arms ?? []) walk(a.steps); out.push(']'); }
    }
  };
  walk(steps);
  return out.join('>');
}

/**
 * Experiments that claim more than their design can deliver.
 *
 * A 'wording' experiment is never in violation — varying copy is exactly what
 * it says it does. Everything else must differ in something a customer would
 * experience, because an arm that behaves identically cannot tell you why a
 * customer behaved differently.
 *
 * Only ever reports. The application refuses the proposal elsewhere; this
 * function makes no decision about what to do with the finding.
 */
/**
 * Does every message attack a stated reason, and is every stated reason attacked?
 *
 * Two failures, one check, because they are the same mistake from opposite
 * ends:
 *
 *  - A SEND CITING NOTHING is decoration. It adds a contact, a cost and some
 *    fatigue, and afterwards nobody can say what it was for. "One more
 *    reminder" is the usual form.
 *  - A BARRIER ADDRESSED BY NOTHING is worse, because the manager raised it.
 *    It was the reason they gave for customers not converting, and the
 *    campaign quietly did nothing about it — which is how a campaign ends up
 *    looking busy while leaving the actual problem untouched.
 *
 * Only barriers that may be designed against count on the second half: an
 * agent-invented one was never the manager's to ignore, and one marked
 * `not-addressable` has been answered — with "a drip campaign cannot fix
 * this", which is a legitimate answer. Both are filtered by `mustBeAddressed`.
 *
 * Reports only. The application decides what to do with the finding.
 */
export function checkBarrierCoverage(
  bp: CampaignBlueprint | null | undefined,
  /** Barriers the design is obliged to address — `mustBeAddressed(brief.barriers)`. */
  owed: { id: string; statement: string }[],
): { uncitedSends: string[]; unaddressed: { id: string; statement: string; basis?: string }[] } {
  // `basis` travels so the refusal can say "You told me" only where they did.
  // `mustBeAddressed` already excludes assumptions, so this is belt and
  // braces — and the caller should not have to look the barrier up again to
  // find out whose idea it was.
  const uncitedSends: string[] = [];
  const cited = new Set<string>();

  const visit = (steps: BpStep[] | undefined) => {
    for (const s of steps ?? []) {
      if (s.kind === 'send') {
        const b = (s as { barrier?: string }).barrier?.trim();
        if (b) cited.add(b.toLowerCase());
        else uncitedSends.push(s.name);
      }
      if (s.kind === 'condition') { visit(s.yes); visit(s.no); }
      if (s.kind === 'branch') for (const p of s.paths ?? []) visit(p.steps);
      if (s.kind === 'experiment') for (const a of s.arms ?? []) visit(a.steps);
    }
  };
  visit(bp?.steps);

  return {
    uncitedSends,
    unaddressed: owed.filter((b) => !cited.has(b.id.trim().toLowerCase())),
  };
}

/**
 * When every reason is the agent's own, does the campaign set out to test it?
 *
 * A manager who cannot say why customers behave as they do is the ordinary
 * case. The honest response is a strong assumption, stated as one, and a
 * campaign that finds out whether it holds — not a refusal, and not a
 * campaign that quietly treats the guess as established.
 *
 * Satisfied by an experiment declaring `tests: 'explanation'`, which is the
 * claim whose arms `checkExperimentClaims` already forces to differ in
 * something a customer would experience. A journey that simply acts on the
 * assumption returns one number that confirms nothing, and the next campaign
 * starts from the same guess.
 */
export function checkBarrierTesting(
  bp: CampaignBlueprint | null | undefined,
  mustTest: boolean,
): string | null {
  if (!mustTest || !bp) return null;

  let tests = false;
  const visit = (steps: BpStep[] | undefined) => {
    for (const s of steps ?? []) {
      if (s.kind === 'experiment') {
        if (String((s as { tests?: string }).tests ?? '') === 'explanation') tests = true;
        for (const a of s.arms ?? []) visit(a.steps);
      }
      if (s.kind === 'condition') { visit(s.yes); visit(s.no); }
      if (s.kind === 'branch') for (const p of s.paths ?? []) visit(p.steps);
    }
  };
  visit(bp.steps);

  return tests
    ? null
    : 'Every reason this campaign addresses is your own reading, not something the manager established — which is fine, and common. But as built it acts on that reading without testing it, so whatever happens afterwards will not tell you whether the reason was right. Add an experiment that declares it tests "explanation", with arms a customer would actually experience differently.';
}

/**
 * When nobody can say who converts, does the campaign set out to find out?
 *
 * THE SITUATION. A fresh campaign has no converters yet, and a running one
 * may have them without anyone knowing who they are. There is nothing to
 * double down on, so the campaign's job changes: it has to distinguish
 * between the candidate segments the agent and the manager settled on, and
 * report back which responded.
 *
 * A flat single-audience journey cannot do that. Everyone gets the same
 * treatment, the result is one undifferentiated number, and the next campaign
 * starts exactly as ignorant as this one. That is the wrong design for this
 * situation however good its messages are, which is why this is checked
 * against the built journey rather than asked for in the prompt.
 *
 * Satisfied by either an experiment that declares it tests `audience`, or any
 * branch or cohort split — both separate groups and let their responses be
 * compared. Returns null when the campaign is fine or the question does not
 * apply.
 */
export function checkAudienceLearning(
  bp: CampaignBlueprint | null | undefined,
  mustLearn: boolean,
): string | null {
  if (!mustLearn || !bp) return null;

  let separates = false;
  const visit = (steps: BpStep[] | undefined) => {
    for (const s of steps ?? []) {
      if (s.kind === 'experiment') {
        if (String((s as { tests?: string }).tests ?? '') === 'audience') separates = true;
        for (const a of s.arms ?? []) visit(a.steps);
      }
      // A branch on a customer attribute separates groups just as an audience
      // test does. A condition on the LAST MESSAGE'S delivery outcome does
      // not — that splits on what the system did, not on who the customer is,
      // so it tells you nothing about which segment converts.
      if (s.kind === 'branch') separates = true;
      if (s.kind === 'condition') {
        if ((s as { on?: unknown }).on) separates = true;
        visit(s.yes);
        visit(s.no);
      }
    }
  };
  visit(bp.steps);

  return separates
    ? null
    : 'Nobody could say which customers convert today, so this campaign has to find out. As built it treats everyone the same, so the result will be one number with nothing to compare it against, and the next campaign will know no more than this one. Separate the candidate segments — an experiment that tests audience, or a branch that treats them differently — so their responses can be read apart.';
}

export function checkExperimentClaims(bp: CampaignBlueprint | null | undefined): ClaimViolation[] {
  const out: ClaimViolation[] = [];
  const visit = (steps: BpStep[] | undefined) => {
    for (const s of steps ?? []) {
      if (s.kind === 'experiment') {
        const claim = String((s as { tests?: string }).tests ?? '');
        const groups = new Map<string, string[]>();
        for (const a of s.arms ?? []) {
          const k = armShape(a.steps);
          groups.set(k, [...(groups.get(k) ?? []), a.label]);
        }
        const same = [...groups.values()].filter((g) => g.length > 1).flat();
        if (claim !== 'wording' && same.length)
          out.push({
            label: s.label,
            claim: claim || '(not declared)',
            identicalArms: same,
            why: `This experiment says it tests ${claim || 'something it did not declare'}, but ${same.join(' and ')} are the same journey — same contacts, same channels, same spacing. Only the words differ, so whichever arm wins, it cannot tell you ${claim === 'explanation' ? 'which barrier was real' : claim === 'timing' ? 'when to make contact' : 'who responds'}.`,
          });
        for (const a of s.arms ?? []) visit(a.steps);
      }
      if (s.kind === 'condition') { visit(s.yes); visit(s.no); }
    }
  };
  visit(bp?.steps);
  return out;
}

// ------------------------------------------------------------- the candidates

export interface Architecture {
  name: string;
  entry: string;
  mechanism: string;
  timing: string;
  tradeoff: string;
  chosen: boolean;
  whyChosen?: string;
  barrier?: string;
  lever?: string;
  journey?: string;
  measurement?: string;
}

export interface ArchitectureComparison {
  status: 'differentiated' | 'insufficient' | 'incomplete';
  why: string;
}

const norm = (s: unknown) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** The three axes a customer would actually experience differently. */
const consequenceKey = (a: Architecture) =>
  [norm(a.entry), norm(a.timing), norm(a.journey)].join(' || ');

/**
 * Whether the candidates offered can be told apart.
 *
 * NEVER upgrades. A missing field or a single candidate produces a weaker
 * status, not a stronger one, so the worst case of a model that ignores the
 * new fields is an honest "incomplete" rather than a false "differentiated".
 */
export function compareArchitectures(
  archs: Architecture[] | undefined,
): ArchitectureComparison {
  const list = archs ?? [];
  if (list.length === 0)
    return { status: 'incomplete', why: 'No candidate architectures were recorded.' };
  if (list.length === 1)
    return {
      status: 'incomplete',
      why: `Only one candidate ("${list[0].name}") was offered, so nothing was compared. That can be the right answer, but it is not a comparison.`,
    };

  // Required before any claim of difference can be assessed at all.
  const REQUIRED: (keyof Architecture)[] = ['barrier', 'lever', 'journey', 'measurement'];
  const missing = list.flatMap((a) =>
    REQUIRED.filter((f) => !String(a[f] ?? '').trim()).map((f) => `${a.name}.${f}`),
  );
  if (missing.length)
    return {
      status: 'incomplete',
      why: `These candidates did not declare what their intervention actually is, so they cannot be compared: ${missing.join(', ')}.`,
    };

  const badEnum = list.filter((a) => !isJourneyBehaviour(a.journey));
  if (badEnum.length)
    return {
      status: 'incomplete',
      why: `"journey" must be one of ${JOURNEY_BEHAVIOURS.join(', ')}. Not recognised: ${badEnum.map((a) => `${a.name}="${a.journey}"`).join(', ')}.`,
    };

  // Same entry, same timing, same journey behaviour means the same campaign,
  // whatever the two mechanisms are called.
  const seen = new Map<string, string[]>();
  for (const a of list) seen.set(consequenceKey(a), [...(seen.get(consequenceKey(a)) ?? []), a.name]);
  const collisions = [...seen.values()].filter((g) => g.length > 1);
  if (collisions.length)
    return {
      status: 'insufficient',
      why: `These candidates reach the same people, at the same moment, with the same journey behaviour, so they are one campaign described twice: ${collisions.map((g) => g.join(' / ')).join('; ')}. Whatever their stated mechanisms, nothing a customer experiences differs between them.`,
    };

  return {
    status: 'differentiated',
    why: `${list.length} candidates differ in who they reach, when, or what the journey does. This says they are not the same campaign. It does NOT say either is a good idea.`,
  };
}

// --------------------------------------------------------------- the winner

export interface FidelityResult {
  ok: boolean;
  declared: string;
  built: JourneyBehaviour[];
  why: string;
}

/**
 * Did the winner's declared journey behaviour survive into the build?
 *
 * This is the check that cannot be talked around. If the chosen candidate
 * says it branches on how the customer responded, and the blueprint is a
 * fixed chain of sends, then the strategy that was sold is not the campaign
 * that was built — and under the old schema nothing would have noticed.
 */
export function checkFidelity(
  archs: Architecture[] | undefined,
  bp: CampaignBlueprint | null | undefined,
): FidelityResult | null {
  const chosen = (archs ?? []).find((a) => a.chosen);
  if (!chosen || !bp) return null;
  const declared = String(chosen.journey ?? '').trim();
  const built = [...derive(bp)];
  if (!isJourneyBehaviour(declared))
    return {
      ok: false, declared, built,
      why: `The chosen candidate did not declare a recognised journey behaviour, so what was built cannot be checked against what was promised.`,
    };
  // 'linear' is present in almost every journey, so a declared 'linear' is
  // only honest if nothing MORE than linear was built. Any richer behaviour
  // means the campaign does something the strategy never claimed.
  if (declared === 'linear') {
    const extra = built.filter((b) => b !== 'linear');
    return extra.length
      ? { ok: false, declared, built,
          why: `Declared a linear journey, but the campaign also does: ${extra.join(', ')}. The built campaign is not the one described.` }
      : { ok: true, declared, built, why: 'The built journey matches what was chosen.' };
  }
  return built.includes(declared)
    ? { ok: true, declared, built, why: 'The built journey matches what was chosen.' }
    : {
        ok: false, declared, built,
        why: `Chose a "${declared}" journey, but the built campaign does ${built.length ? built.join(', ') : 'nothing of the kind'}. The strategy and the campaign disagree.`,
      };
}
