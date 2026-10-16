// Do two campaigns actually DIFFER, or do they only read differently?
//
// This file exists because the one thing the recorded runs do reliably is
// produce two "alternatives" that are the same campaign with different words.
// The agent's own prose cannot settle the question — it will happily call two
// identical journeys "two architectures" — so the comparison has to be made
// against structure the model did not author directly.
//
// THE CENTRAL RULE: names, labels, describe text and message copy are EXCLUDED
// from every signature below. If they were included, every comparison would
// trivially report "different", because two runs never phrase anything the
// same way. What is left is what a customer would actually experience
// differently: where they enter, who is let in, when they are contacted, and
// what the journey does.
//
// WHAT THIS CANNOT DO, stated plainly: it cannot tell that an intervention is
// intelligent, or that one of two genuinely different campaigns is the better
// one. A divergence verdict is a floor, not a grade. Code can prove two things
// are not the same; only a person can say whether either is any good.
import type { CampaignBlueprint, BpStep, BpCondition } from '../server/blueprint';

/** The four things a customer could experience differently. */
export type Aspect = 'entry' | 'audience' | 'timing' | 'shape';

export const ASPECTS: Aspect[] = ['entry', 'audience', 'timing', 'shape'];

export interface Signature {
  /** Where the journey starts: audience pull vs event, and on what. */
  entry: string;
  /** Who is let in: the entry's conditions, order-independent. */
  audience: string;
  /** When contact happens: the ordered cadence of waits, anchors and sends. */
  timing: string;
  /** What the journey does: step kinds and branching, no names. */
  shape: string;
}

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase();

/** Conditions compared as a SET — the model's ordering is not a decision. */
function conditionSig(cs: BpCondition[] | undefined): string {
  if (!cs?.length) return 'none';
  return cs
    .map((c) => `${norm(c.attribute)}${norm(c.operator)}${norm(c.value)}`)
    .sort()
    .join('+');
}

function entrySig(bp: CampaignBlueprint): string {
  const e = bp.entry;
  if (!e) return 'none';
  return e.kind === 'event'
    ? `event:${norm(e.eventCategory)}/${norm(e.eventType)}`
    : `audience:${norm(e.entity)}`;
}

function audienceSig(bp: CampaignBlueprint): string {
  return conditionSig(bp.entry?.conditions);
}

/**
 * Cadence, in traversal order.
 *
 * A send contributes its presence and nothing else: its copy is the thing most
 * likely to differ between two runs and the thing least likely to mean a
 * different campaign. What matters is how many contacts there are and what
 * sits between them.
 */
/**
 * Arms in a stable order that depends only on allocation and content.
 *
 * Shared by both signatures so neither can order arms differently from the
 * other and produce two disagreeing answers about the same campaign.
 */
function sortedArms(
  arms: { label: string; pct: number; steps: BpStep[] }[] | undefined,
  tokenise: (steps: BpStep[] | undefined, out?: string[]) => string[],
) {
  return (arms ?? [])
    .map((a) => ({ pct: a.pct, tokens: tokenise(a.steps, []).join(',') }))
    .sort((p, q) => p.pct - q.pct || p.tokens.localeCompare(q.tokens));
}

function timingTokens(steps: BpStep[] | undefined, out: string[] = []): string[] {
  for (const s of steps ?? []) {
    switch (s.kind) {
      case 'send':
        out.push(`s:${norm(s.stage)}`);
        break;
      case 'wait':
        out.push(`w:${s.durationHours}`);
        break;
      case 'waitForEvent':
        out.push(`e:${norm(s.eventCategory)}/${norm(s.eventType)}/${s.timeoutDays}`);
        break;
      case 'exit':
        out.push('x');
        break;
      case 'experiment':
        // Arms are ordered by allocation AND THEN BY THEIR OWN CONTENT, never
        // by the order the model happened to list them.
        //
        // Sorting on pct alone is not enough, and the unit test caught it: an
        // even split leaves two arms tied, so their original order survived
        // into the signature and two identical arms listed the other way round
        // read as a changed campaign. That is the precise false positive this
        // whole file exists to avoid.
        out.push('X[');
        for (const a of sortedArms(s.arms, timingTokens)) {
          out.push(`${a.pct}:(${a.tokens})`);
        }
        out.push(']');
        break;
      case 'condition':
        out.push(`C[${[...(s.outcomes ?? [])].map(norm).sort().join('|')}:(`);
        timingTokens(s.yes, out);
        out.push(')(');
        timingTokens(s.no, out);
        out.push(')]');
        break;
    }
  }
  return out;
}

function shapeTokens(steps: BpStep[] | undefined, out: string[] = []): string[] {
  for (const s of steps ?? []) {
    // Channel belongs here and copy does not, and the line between them is
    // deliberate: a customer notices being reached by SMS instead of email,
    // and does not notice that two drafts of the same message were worded
    // differently. Omitting channel would flag a fork that genuinely switches
    // channel as doing nothing — a false positive I verified was NOT firing on
    // the live runs only by reading their raw blueprints, which is not a check
    // I want to rely on.
    out.push(s.kind === 'send' ? `send:${(s.channelPreference ?? []).join('|')}` : s.kind);
    if (s.kind === 'experiment') {
      out.push('[');
      for (const a of sortedArms(s.arms, shapeTokens)) out.push(`(${a.tokens})`);
      out.push(']');
    }
    if (s.kind === 'condition') {
      out.push('[(');
      shapeTokens(s.yes, out);
      out.push(')(');
      shapeTokens(s.no, out);
      out.push(')]');
    }
  }
  return out;
}

export function signature(bp: CampaignBlueprint | null | undefined): Signature {
  if (!bp) return { entry: 'none', audience: 'none', timing: 'none', shape: 'none' };
  return {
    entry: entrySig(bp),
    audience: audienceSig(bp),
    timing: timingTokens(bp.steps).join(','),
    shape: shapeTokens(bp.steps).join(','),
  };
}

// --------------------------------------------------------------- comparison

export interface AspectResult {
  aspect: Aspect;
  differs: boolean;
  a: string;
  b: string;
}

export interface DivergenceResult {
  aspects: AspectResult[];
  /** Did every aspect the pair DECLARED must differ actually differ? */
  met: Aspect[];
  unmet: Aspect[];
  /** Nothing whatsoever differs — the strongest possible failure. */
  identical: boolean;
  verdict: 'diverged' | 'partial' | 'identical';
}

export function compare(
  a: CampaignBlueprint | null | undefined,
  b: CampaignBlueprint | null | undefined,
  mustDiffer: Aspect[],
): DivergenceResult {
  const sa = signature(a);
  const sb = signature(b);
  const aspects: AspectResult[] = ASPECTS.map((k) => ({
    aspect: k,
    differs: sa[k] !== sb[k],
    a: sa[k],
    b: sb[k],
  }));
  const met = mustDiffer.filter((k) => aspects.find((x) => x.aspect === k)!.differs);
  const unmet = mustDiffer.filter((k) => !met.includes(k));
  const identical = aspects.every((x) => !x.differs);
  return {
    aspects,
    met,
    unmet,
    identical,
    verdict: unmet.length === 0 ? 'diverged' : met.length ? 'partial' : 'identical',
  };
}

// ------------------------------------------- can an experiment discriminate?

export interface ArmCheck {
  label: string;
  armCount: number;
  /** Arms whose structure is indistinguishable, by signature. */
  collidingArms: string[];
  /** True when at least two arms are structurally the same journey. */
  cannotDiscriminate: boolean;
}

/**
 * An experiment claiming to test two EXPLANATIONS must vary something a
 * customer experiences. Two arms that differ only in message copy test
 * copy — which is a legitimate experiment, but it cannot establish which
 * underlying barrier was real, and the strategy must not claim it can.
 *
 * MEASURED: this is the exact defect in the recorded growth-config run, where
 * two arms labelled cost-hesitation and friction-hesitation were the identical
 * journey with different wording.
 */
/**
 * A fork whose branches do the same thing.
 *
 * FOUND IN A LIVE RUN, not theorised. The count arm of the goal counterfactual
 * built `condition on delivered` whose yes-branch and no-branch were identical
 * token for token: send, wait 48h, send, wait 48h, send, exit — on both sides.
 * The campaign therefore behaves identically whether the message was delivered
 * or not, while carrying a node that lets "conditional branching" be claimed
 * as used.
 *
 * The existing option auditor could not see this. It verifies that a condition
 * EXISTS in the journey, which this one does. Nothing checked that it changes
 * anything.
 */
export interface DecorativeFork {
  label: string;
  outcomes: string[];
  /** The identical token sequence both branches run. */
  bothBranchesDo: string;
}

export function decorativeForks(bp: CampaignBlueprint | null | undefined): DecorativeFork[] {
  const found: DecorativeFork[] = [];
  const walk = (steps: BpStep[] | undefined) => {
    for (const s of steps ?? []) {
      if (s.kind === 'condition') {
        const yes = `${timingTokens(s.yes).join(',')}|${shapeTokens(s.yes).join(',')}`;
        const no = `${timingTokens(s.no).join(',')}|${shapeTokens(s.no).join(',')}`;
        // Two empty branches are a different defect (a fork that goes nowhere),
        // already caught by graph readiness. This is about a fork that runs the
        // same real journey either way.
        if (yes === no && yes !== '|')
          found.push({ label: s.label, outcomes: s.outcomes ?? [], bothBranchesDo: shapeTokens(s.yes).join(',') });
        walk(s.yes); walk(s.no);
      }
      if (s.kind === 'experiment') for (const a of s.arms ?? []) walk(a.steps);
    }
  };
  walk(bp?.steps);
  return found;
}

export function experimentArms(bp: CampaignBlueprint | null | undefined): ArmCheck[] {
  const found: ArmCheck[] = [];
  const walk = (steps: BpStep[] | undefined) => {
    for (const s of steps ?? []) {
      if (s.kind === 'experiment') {
        const sigs = (s.arms ?? []).map((a) => ({
          label: a.label,
          sig: `${timingTokens(a.steps).join(',')}|${shapeTokens(a.steps).join(',')}`,
        }));
        const seen = new Map<string, string[]>();
        for (const x of sigs) seen.set(x.sig, [...(seen.get(x.sig) ?? []), x.label]);
        const colliding = [...seen.values()].filter((g) => g.length > 1);
        found.push({
          label: s.label,
          armCount: sigs.length,
          collidingArms: colliding.flat(),
          cannotDiscriminate: colliding.length > 0,
        });
        for (const a of s.arms ?? []) walk(a.steps);
      }
      if (s.kind === 'condition') { walk(s.yes); walk(s.no); }
    }
  };
  walk(bp?.steps);
  return found;
}
