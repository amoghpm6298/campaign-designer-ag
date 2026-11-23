// Checks on signal switches (routes inside a bucket): each route big enough
// to measure, not too deep or too many to review, an "everyone else" route,
// and a signal that can be used for switching. Code only points at problems;
// the agent (or the split helper) fixes them.
import type { CampaignContext, CampaignObject } from './types';
import type { BpStep } from '../blueprint';
import type { TenantConfig } from '../tenants';
import { signalsFor } from '../signals';
import { bucketContext, currentEntries } from '../../src/designer/v2/contextView';
import type { CostReport } from '../costModel';

export const MAX_SWITCH_DEPTH = 2;
export const MAX_ROUTES = 4;
/** Default when the bank sets none: the larger of 1,000 customers and 5% of the bucket. */
export const DEFAULT_MIN_ROUTE = { customers: 1000, pctOfBucket: 5 };

type Rec = Record<string, unknown>;

/** Wording: what a route may change without being a different treatment. */
const WORDING = new Set(['id', 'copy', 'cta', 'name', 'label', 'rationale', 'describe', 'objective', 'stage', 'reason', 'splitIdea', 'costAssumptions', 'funnel', 'hypothesis', 'successMetric', 'barrier', 'why']);

/**
 * A route's treatment: everything that changes what customers get or when (the offer, the link,
 * channels, timing, waits, the shape of the journey), and none of its wording.
 */
export function treatmentOf(steps: unknown): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Rec).filter(([k]) => !WORDING.has(k)).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, norm(x)]));
    return v;
  };
  return JSON.stringify(norm(steps ?? []));
}

export function routeProblems(campaign: CampaignObject, context: CampaignContext | null, tenant: Pick<TenantConfig, 'incentives' | 'warehouse' | 'minRouteSize'> | null, cost: CostReport): string[] {
  const out: string[] = [];
  const signals = signalsFor(tenant);
  const views = bucketContext(context?.entries ?? []);
  const rule = tenant?.minRouteSize ?? DEFAULT_MIN_ROUTE;
  const lanes = [
    ...campaign.buckets.map((b) => ({ id: b.id, name: `Bucket "${b.name}"`, journey: b.journey })),
    ...(campaign.everyoneElse?.approach === 'journey' ? [{ id: 'everyone_else', name: 'Everyone else', journey: campaign.everyoneElse.journey }] : []),
  ];
  for (const lane of lanes) {
    const bucketSize = typeof views[lane.id]?.size === 'number' ? (views[lane.id]!.size as number) : null;
    const min = bucketSize != null ? Math.max(rule.customers, Math.round((bucketSize * rule.pctOfBucket) / 100)) : rule.customers;
    const walk = (list: BpStep[] | null | undefined, depth: number) => {
      for (const st of (list ?? []) as unknown as Rec[]) {
        const isSwitch = st.kind === 'branch' && typeof st.signal === 'string' && !!st.signal;
        if (isSwitch) {
          const name = `${lane.name} › switch "${String(st.label ?? st.signal)}"`;
          const sig = signals.find((x) => x.key === st.signal);
          if (!sig) out.push(`${name}: "${st.signal}" is not a signal for this bank.`);
          else if (!sig.usableIn.includes('switch')) out.push(`${name}: "${sig.key}" can't be used to route people.`);
          const paths = (st.paths as Rec[] | undefined) ?? [];
          if (paths.length > MAX_ROUTES) out.push(`${name}: ${paths.length} routes; at most ${MAX_ROUTES} so the campaign stays reviewable. Merge the smaller ones.`);
          if (!Array.isArray(st.otherwise) || !(st.otherwise as unknown[]).length) out.push(`${name}: needs an "everyone else" route (otherwise), so nobody falls through.`);
          if (depth + 1 > MAX_SWITCH_DEPTH) out.push(`${name}: a switch inside ${depth} other switch${depth === 1 ? '' : 'es'}; at most ${MAX_SWITCH_DEPTH} deep. Fold it into the one above.`);
          // Route sizes come from the cost report (worked out by code). Journey signals can't be counted: exempt.
          const sizes = cost.routes.filter((r) => r.stepId === st.id && !r.otherwise);
          for (const r of sizes)
            if (r.size != null && r.size < min)
              out.push(`${name}: route "${r.label}" has ${r.size.toLocaleString('en-IN')} customers, below the ${min.toLocaleString('en-IN')} needed to measure it. Merge it into another route or into everyone else.`);
          // A split is for different TREATMENT (offer, link, channel, timing, journey shape), not different wording.
          const routes = [...paths.map((p) => ({ label: String(p.label ?? ''), sig: treatmentOf(p.steps) })), { label: 'Everyone else', sig: treatmentOf(st.otherwise) }];
          if (routes.length > 1 && routes.every((r) => r.sig === routes[0].sig))
            out.push(`${name}: every route gets the same treatment (same offer, link, channel and timing); only the wording differs. A split is for groups that need something different. Undo it (one message for everyone), or give the routes genuinely different treatment.`);
          else
            for (let i = 0; i < routes.length; i++)
              for (let j = i + 1; j < routes.length; j++)
                if (routes[i].sig === routes[j].sig) out.push(`${name}: routes "${routes[i].label}" and "${routes[j].label}" get the same treatment; only the wording differs. Merge them.`);
          // The campaign strategy must describe the split as it is built.
          const strategy = currentEntries(context?.entries ?? [], { kind: 'note', topic: 'campaign strategy' })[0]?.text ?? '';
          const words = [String(st.signal), String(st.signal).replace(/_/g, ' '), ...paths.map((p) => String(p.label ?? ''))].filter((w) => w.length > 2).map((w) => w.toLowerCase());
          if (strategy && !words.some((w) => strategy.toLowerCase().includes(w)))
            out.push(`${name}: your campaign strategy doesn't describe this split (by ${String(st.signal).replace(/_/g, ' ')}). Rewrite the bucket's section so it matches what is built.`);
          paths.forEach((p) => walk(p.steps as BpStep[], depth + 1));
          walk(st.otherwise as BpStep[] | undefined, depth + 1);
          continue;
        }
        for (const k of ['yes', 'no', 'otherwise']) if (Array.isArray(st[k])) walk(st[k] as BpStep[], depth);
        for (const k of ['arms', 'paths']) if (Array.isArray(st[k])) (st[k] as Rec[]).forEach((a) => walk(a.steps as BpStep[], depth));
      }
    };
    walk(lane.journey as BpStep[] | null | undefined, 0);
  }
  return out;
}
