// Campaign object → one campaign recipe for the builder.
//
// The agent never writes the bucket chain. It writes buckets (rule + journey)
// and a campaign shell; this turns them into one campaign:
//
//   Entry · Audience (eligible, not yet at goal; repeats if membership is open)
//     └─ Bucket 1 rule? ─yes─▶ [holdout split] ─▶ Bucket 1 journey
//          └─no─▶ Bucket 2 rule? ─yes─▶ …
//                   └─no─▶ … ─▶ Everyone else (journey, or exit)
//
// First match wins, which is what keeps the buckets mutually exclusive.

import type { BpStep, CampaignBlueprint } from '../blueprint';
import type { CampaignObject } from './types';
import { linkProblem, type BankLink } from '../links';
import { fallbackFor } from '../bankSettings';
import { walkSteps } from './stepIds';

export interface CompileResult {
  blueprint: CampaignBlueprint | null;
  /** Things the agent should fix or tell the manager about. */
  problems: string[];
  bucketsIncluded: string[];
}

export function planToBlueprint(campaign: CampaignObject): CompileResult {
  const problems: string[] = [];
  const shell = campaign;
  if (!shell.goal && !shell.entry && !shell.membership && !shell.buckets.length)
    return { blueprint: null, problems: ['There is no campaign yet. Write it with edit_campaign (entry, goal, membership) and edit_bucket.'], bucketsIncluded: [] };

  const ready = campaign.buckets
    .slice()
    .sort((a, b) => a.priority - b.priority)
    .filter((b) => {
      if (!b.rule?.length) {
        problems.push(`Bucket "${b.name}" has no rule the builder can check, so it was left out.`);
        return false;
      }
      if (!b.journey?.length) {
        problems.push(`Bucket "${b.name}" has no journey yet, so it was left out.`);
        return false;
      }
      return true;
    });
  if (!ready.length) return { blueprint: null, problems: [...problems, 'No bucket has both a rule and a journey, so there is nothing to build.'], bucketsIncluded: [] };

  const ee = shell.everyoneElse;
  let tail: BpStep[] =
    ee?.approach === 'journey' && ee.journey?.length
      ? ee.journey
      : [{ kind: 'exit', reason: ee?.approach === 'none' ? 'In no bucket: no messages, by design' : 'In no bucket' }];
  if (!ee) problems.push('What customers in no bucket get is not decided; they exit without messages. Set everyoneElse in edit_campaign.');

  for (const b of [...ready].reverse()) {
    const h = typeof b.holdoutPct === 'number' && b.holdoutPct > 0 ? Math.round(b.holdoutPct) : 0;
    const path: BpStep[] = h
      ? [
          {
            kind: 'experiment',
            label: `${b.name}: holdout`,
            tests: 'holdout',
            arms: [
              { label: 'Holdout', pct: h, steps: [{ kind: 'exit', reason: 'Held back: no messages while the campaign runs', outcome: 'held_back' }] },
              { label: 'Journey', pct: 100 - h, steps: b.journey! },
            ],
          },
        ]
      : b.journey!;
    tail = [{ kind: 'condition', label: b.name, audience: { name: b.name, groups: b.rule }, yes: path, no: tail }];
  }

  const entry = shell.entry ?? { kind: 'audience' as const, entity: 'Customer' };
  if (!shell.entry) problems.push('No entry audience set; everyone eligible enters. Set entry in edit_campaign if that is wrong.');
  const open = shell.membership?.type === 'open';
  if (!shell.membership) problems.push('Locked or open buckets is not decided; built as locked (membership fixed at launch).');

  return {
    blueprint: {
      campaignName: shell.name || 'Campaign',
      description: shell.description || '',
      goal: shell.goal ?? null,
      entry: { ...entry, ...(open ? { repeat: { every: shell.membership!.refresh ?? 'weekly' } } : {}) },
      steps: tail,
    },
    problems,
    bucketsIncluded: ready.map((b) => b.name),
  };
}

// --- knock-on checks --------------------------------------------------------------
//
// Things a change can break further down the tree. They run on every build and
// go back to the agent as "fix before you finish", so a cascade does not depend
// only on the model noticing.

const READ_LIKE = /READ|OPEN|CLICK|SEEN|VIEW/i;

function checkSteps(steps: BpStep[] | null | undefined, where: string, out: string[], prevChannel: string | null): void {
  let channel = prevChannel;
  (steps ?? []).forEach((st, i) => {
    const s = st as unknown as Record<string, unknown>;
    const name = String(s.name ?? s.label ?? s.kind);
    // Anything after an exit in the same list can never be reached.
    if (i > 0 && (steps![i - 1] as { kind?: string }).kind === 'exit') out.push(`${where}: "${name}" comes after an exit, so nobody can reach it.`);
    if (s.kind === 'send') channel = ((s.channelPreference as string[] | undefined) ?? [])[0] ?? channel;
    if (s.kind === 'experiment') {
      const arms = (s.arms as { pct?: number; steps?: BpStep[]; label?: string }[] | undefined) ?? [];
      const total = arms.reduce((n, a) => n + (Number(a.pct) || 0), 0);
      if (arms.length && Math.round(total) !== 100) out.push(`${where}: the A/B test "${name}" splits ${arms.map((a) => `${a.pct}%`).join(' + ')} = ${total}%, not 100%.`);
      arms.forEach((a) => checkSteps(a.steps, `${where} › arm "${a.label}"`, out, channel));
    }
    if (s.kind === 'branch') {
      const paths = (s.paths as { label?: string; statuses?: string[]; steps?: BpStep[] }[] | undefined) ?? [];
      if (channel === 'SMS') {
        for (const p of paths) if ((p.statuses ?? []).some((x) => READ_LIKE.test(x))) out.push(`${where}: the branch "${name}" reacts to "${p.label}" (${(p.statuses ?? []).join(', ')}), but the message before it goes by SMS, which does not report reads or clicks.`);
      }
      paths.forEach((p) => checkSteps(p.steps, `${where} › path "${p.label}"`, out, channel));
      checkSteps(s.otherwise as BpStep[] | undefined, `${where} › "Anything else"`, out, channel);
    }
    if (s.kind === 'condition') {
      checkSteps(s.yes as BpStep[] | undefined, `${where} › yes`, out, channel);
      checkSteps(s.no as BpStep[] | undefined, `${where} › no`, out, channel);
    }
  });
}

// --- endings: how each customer leaves -------------------------------------------
//
// The agent designs every ending. Nothing here writes one: a gap goes back to
// the agent as something to decide, through the same repair rounds.

const stepName = (s: Record<string, unknown>) => String(s.name ?? s.label ?? s.kind);

/** Every place a path in this list ends without saying how the customer left. */
function endingGapsIn(list: BpStep[] | null | undefined, where: string, out: string[], covered = false): void {
  const steps = (list ?? []) as unknown as Record<string, unknown>[];
  const last = steps[steps.length - 1];
  if (!last) {
    if (!covered) out.push(`${where} is empty, so customers on it just stop. End it with an exit and an outcome.`);
    return;
  }
  // A trailing exit right after a fork closes every arm still open under it.
  const prev = steps[steps.length - 2];
  if (last.kind === 'exit') {
    if (!last.outcome) out.push(`${where}: the exit "${String(last.reason ?? '')}" does not say how the customer left. Give it an outcome.`);
    if (prev?.kind === 'send') out.push(noWindow(where, `the exit "${String(last.reason ?? '')}"`, prev));
    if (prev && ['branch', 'experiment', 'condition'].includes(String(prev.kind))) forkGaps(prev, where, out, Boolean(last.outcome));
    return;
  }
  if (['branch', 'experiment', 'condition'].includes(String(last.kind))) {
    forkGaps(last, where, out, covered);
    return;
  }
  // Flows straight into the exit after the fork: the same missing window.
  if (covered && last.kind === 'send') out.push(noWindow(where, 'the exit after it', last));
  if (!covered) out.push(`${where} ends after "${stepName(last)}" without saying how the customer left. Decide the ending: an exit with an outcome (no_response, not_reachable or declined).`);
}

/** An exit straight after a message closes customers out before they could act on it. */
const noWindow = (where: string, exit: string, send: Record<string, unknown>) =>
  `${where}: ${exit} comes straight after "${stepName(send)}", so customers are closed out before they could act on it. Put a wait (the response window) before the exit; you choose the length.`;

function forkGaps(s: Record<string, unknown>, where: string, out: string[], covered: boolean): void {
  const name = stepName(s);
  for (const a of (s.arms as { label?: string; steps?: BpStep[] }[] | undefined) ?? []) endingGapsIn(a.steps, `${where} › "${name}" arm "${a.label}"`, out, covered);
  for (const p of (s.paths as { label?: string; steps?: BpStep[] }[] | undefined) ?? []) endingGapsIn(p.steps, `${where} › "${name}" path "${p.label}"`, out, covered);
  if (s.kind === 'branch') {
    const other = s.otherwise as BpStep[] | undefined;
    // Never covered by a trailing exit: the builder does not carry what comes
    // after a fork onto its "Anything else" route.
    if (!other?.length) {
      const delivery = ((s.paths as { statuses?: string[] }[] | undefined) ?? []).some((p) => p.statuses?.length);
      out.push(
        `${where} › "${name}": the "Anything else" route is not decided. ${delivery ? 'These are the people the message never reached (failed, queued, unknown).' : 'These are the customers no path matched.'} Decide it: e.g. one try on a different channel, then an exit with outcome not_reachable, or just that exit.`,
      );
    } else endingGapsIn(other, `${where} › "${name}" › "Anything else"`, out, false);
  }
  if (s.kind === 'condition') {
    endingGapsIn(s.yes as BpStep[] | undefined, `${where} › "${name}" yes`, out, covered);
    endingGapsIn(s.no as BpStep[] | undefined, `${where} › "${name}" no`, out, covered);
  }
}

/**
 * Design decisions still open about how customers leave and what happens next.
 * With `since`, only the journeys changed since then are looked at, so a small
 * edit is not turned into a redesign of every bucket's endings.
 */
export function endingGaps(campaign: CampaignObject, since?: CampaignObject): string[] {
  const out: string[] = [];
  const touched = (id: string, journey: unknown) => !since || since.buckets.find((x) => x.id === id)?.journey !== journey;
  for (const b of campaign.buckets) if (b.journey?.length && touched(b.id, b.journey)) endingGapsIn(b.journey, `Bucket "${b.name}"`, out);
  if (campaign.everyoneElse?.approach === 'journey' && campaign.everyoneElse.journey?.length && (!since || since.everyoneElse?.journey !== campaign.everyoneElse.journey))
    endingGapsIn(campaign.everyoneElse.journey, 'Everyone else', out);
  const shapeChanged = !since || since.membership !== campaign.membership || !since.buckets.some((b) => b.journey?.length);
  if (shapeChanged && campaign.membership?.type === 'open' && campaign.buckets.some((b) => b.journey?.length) && !campaign.afterJourney)
    out.push('This campaign is recurring, but what happens after the journey is not decided: for each outcome (no_response, not_reachable, declined, converted), how many days before the customer may come back and be bucketed again, or "leave". Set afterJourney with edit_campaign.');
  // The stopping rule.
  const recurring = campaign.membership?.type === 'open' && campaign.buckets.some((b) => b.journey?.length);
  if (shapeChanged && recurring && !campaign.maxAttempts)
    out.push('This campaign is recurring, but it has no stopping rule: set maxAttempts with edit_campaign, the most times one customer goes through it (usually 2). After their last time everyone leaves for good, whatever their ending.');
  const max = campaign.maxAttempts ?? 0;
  if (max) {
    for (const b of campaign.buckets) {
      const t = (b.rule ?? []).filter((g) => g.entity === 'Campaign History').flatMap((g) => g.conditions ?? []).find((c) => /times through/i.test(c.attribute ?? ''));
      if (t && Number(t.value) >= max)
        out.push(`Bucket "${b.name}" is for customers on time ${Number(t.value) + 1} through the campaign, but the campaign stops after ${max}. Nobody can reach it: change the bucket or the stopping rule.`);
    }
  }
  return out;
}

/** Problems a change may have left further down the tree. Empty when all is well. `brokenOnly` leaves out open design decisions (endings). */
export function checkJourneys(campaign: CampaignObject, links?: BankLink[], smsFallback = true, brokenOnly = false, since?: CampaignObject): string[] {
  const out: string[] = brokenOnly ? [] : endingGaps(campaign, since);
  for (const b of campaign.buckets) checkSteps(b.journey, `Bucket "${b.name}"`, out, null);
  if (campaign.everyoneElse?.journey) checkSteps(campaign.everyoneElse.journey, 'Everyone else', out, null);
  if (links) {
    for (const b of campaign.buckets) out.push(...linkProblemsIn(b.journey, links, smsFallback).map((p) => `Bucket "${b.name}": ${p}`));
    if (campaign.everyoneElse?.journey) out.push(...linkProblemsIn(campaign.everyoneElse.journey, links, smsFallback).map((p) => `Everyone else: ${p}`));
  }
  return out;
}

/** Every message whose link cannot be sent on its channel, or on the SMS it may fall back to under the bank's policy. */
export function linkProblemsIn(steps: BpStep[] | null | undefined, links: BankLink[], smsFallback = true): string[] {
  const out: string[] = [];
  walkSteps(steps, (s) => {
    if (s.kind !== 'send' || typeof s.link !== 'string' || !s.link) return;
    const name = String(s.name ?? s.label ?? 'a message');
    const ch = ((s.channelPreference as string[] | undefined) ?? [])[0] ?? 'SMS';
    const fb = fallbackFor(s as { channelPreference?: string[]; fallbackChannel?: string }, smsFallback);
    const problem = linkProblem(links, s.link, ch) ?? (fb ? linkProblem(links, s.link, fb) : null);
    if (problem) out.push(`"${name}": ${problem}`);
  });
  return out;
}
