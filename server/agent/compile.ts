// Plan file → one campaign recipe.
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
import type { PlanFile } from './types';

export interface CompileResult {
  blueprint: CampaignBlueprint | null;
  /** Things the agent should fix or tell the manager about. */
  problems: string[];
  bucketsIncluded: string[];
}

export function planToBlueprint(pf: PlanFile): CompileResult {
  const problems: string[] = [];
  const shell = pf.campaign;
  if (!shell) return { blueprint: null, problems: ['There is no campaign shell yet. Write it with edit_campaign (entry, goal, membership).'], bucketsIncluded: [] };

  const ready = pf.buckets
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
