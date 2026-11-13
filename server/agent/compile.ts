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
              { label: 'Holdout', pct: h, steps: [{ kind: 'exit', reason: 'Holdout: no messages' }] },
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
    }
    if (s.kind === 'condition') {
      checkSteps(s.yes as BpStep[] | undefined, `${where} › yes`, out, channel);
      checkSteps(s.no as BpStep[] | undefined, `${where} › no`, out, channel);
    }
  });
}

/** Problems a change may have left further down the tree. Empty when all is well. */
export function checkJourneys(campaign: CampaignObject): string[] {
  const out: string[] = [];
  for (const b of campaign.buckets) checkSteps(b.journey, `Bucket "${b.name}"`, out, null);
  if (campaign.everyoneElse?.journey) checkSteps(campaign.everyoneElse.journey, 'Everyone else', out, null);
  return out;
}
