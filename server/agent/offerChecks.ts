// Checks on the offers a campaign uses, and the final budget pass. Code only
// points at problems; the agent fixes them (the repair loop), like the
// endings and goal-check gaps.
import type { CampaignContext, CampaignObject } from './types';
import type { BpStep } from '../blueprint';
import type { TenantConfig } from '../tenants';
import { walkSteps } from './stepIds';
import { incentivesFor, qualifyingShare, validFor } from '../incentives';
import { signalsFor } from '../signals';
import { warehouseAvailable } from '../warehouse';
import { bucketContext, currentEntries } from '../../src/designer/v2/contextView';
import { campaignCost, costLine, type CostReport } from '../costModel';
import { todayIST } from './schedule';
import { routeProblems } from './routeChecks';

/** Below this share of a bucket qualifying, most of it would get the message without the offer. */
export const MIN_QUALIFYING_SHARE = 0.8;

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
/** Amounts, percentages and rates belong to the system's offer line, never the AI's copy. */
const AMOUNT = /(₹\s?\d)|(\brs\.?\s?\d)|(\binr\s?\d)|(\d+(\.\d+)?\s?%)|(\b\d+x\b)/i;

/** Every problem with the offers, plus the cost report they were judged against. */
export function offerProblems(campaign: CampaignObject, context: CampaignContext | null, tenant: Pick<TenantConfig, 'incentives' | 'warehouse' | 'minRouteSize'> | null): { problems: string[]; cost: CostReport } {
  const problems: string[] = [];
  const menu = incentivesFor(tenant);
  const bank = tenant?.warehouse?.bank && warehouseAvailable(tenant.warehouse.bank) ? tenant.warehouse.bank : null;
  const signals = signalsFor(tenant);
  const views = bucketContext(context?.entries ?? []);
  const lanes = [
    ...campaign.buckets.map((b) => ({ id: b.id, name: `Bucket "${b.name}"`, journey: b.journey })),
    ...(campaign.everyoneElse?.approach === 'journey' ? [{ id: 'everyone_else', name: 'Everyone else', journey: campaign.everyoneElse.journey }] : []),
  ];
  let usesOffers = false;
  for (const lane of lanes) {
    walkSteps(lane.journey as BpStep[] | null | undefined, (st) => {
      const s = st as unknown as Record<string, unknown>;
      if (s.kind !== 'send') return;
      const step = `${lane.name} › "${String(s.name ?? s.label ?? 'a message')}"`;
      if (typeof s.incentive !== 'string' || !s.incentive) return;
      usesOffers = true;
      const inc = menu.find((m) => m.id === s.incentive);
      if (!inc) {
        problems.push(`${step}: "${s.incentive}" is not an offer on this bank's menu. Use an id from list_incentives, or remove the offer.`);
        return;
      }
      if (!validFor(inc, campaign.schedule, todayIST())) problems.push(`${step}: the offer "${inc.label}" isn't valid for the campaign's dates (${inc.validFrom} to ${inc.validTo}) or has no budget left. Choose another offer or change the dates.`);
      if (campaign.goal && !inc.fitsGoals.includes(campaign.goal.eventType)) problems.push(`${step}: the offer "${inc.label}" is earned by ${inc.trigger.action.replace('_', ' ')}, which doesn't serve the goal "${campaign.goal.eventType}". Choose an offer whose trigger fits the goal.`);
      const words = `${String(s.copy ?? '')} ${String(s.cta ?? '')}`;
      if (AMOUNT.test(words)) problems.push(`${step}: the copy states an amount or rate. Remove it: the system adds the offer's exact line ("${inc.offerLine}") after your copy. Write copy that leads into it.`);
      const ca = (s.costAssumptions ?? {}) as Record<string, { expected?: unknown; few?: unknown; why?: unknown } | undefined>;
      const okEst = (e?: { expected?: unknown; few?: unknown; why?: unknown }) => !!e && [e.expected, e.few].every((x) => typeof x === 'number' && x >= 0 && x <= 1) && Number(e.few) <= Number(e.expected) && typeof e.why === 'string' && !!e.why.trim();
      if (!okEst(ca.reach) || !okEst(ca.redeem)) problems.push(`${step}: the offer needs costAssumptions: reach and redeem, each {expected, few, why} as fractions 0-1 (few ≤ expected), so the cost can be worked out.`);
      const sql = views[lane.id]?.sql;
      if (bank && sql) {
        const q = qualifyingShare(bank, signals, sql, inc);
        if (!('error' in q) && q.size) {
          const share = q.qualify / q.size;
          if (share < MIN_QUALIFYING_SHARE)
            problems.push(`${step}: only ${q.qualify.toLocaleString('en-IN')} of ${q.size.toLocaleString('en-IN')} (${Math.round(share * 100)}%) qualify for "${inc.label}" (${q.checkedBy.join('; ') || 'its rules'}). The rest would get the message without the offer. Narrow the bucket to those who qualify, or choose another offer.`);
        }
      } else if (bank && !sql) {
        problems.push(`${lane.name}: uses an offer but isn't sized, so who qualifies and what it costs can't be worked out. Size it (add_context kind "sizing").`);
      }
    });
  }
  const cost = campaignCost(campaign, context, tenant);
  // Routes inside buckets (signal switches): size, depth, count, everyone else.
  problems.push(...routeProblems(campaign, context, tenant, cost));
  if (!usesOffers) return { problems, cost };
  const notes = currentEntries(context?.entries ?? []);
  const strategy = notes.find((e) => e.kind === 'note' && ['campaign strategy', 'incentive strategy'].includes(e.topic.toLowerCase()));
  if (!strategy)
    problems.push('The campaign uses offers but has no campaign strategy: write it (add_context kind "note", topic "campaign strategy"), including per bucket whether money is needed, the offer and rung, why, the cheaper option, and an Offers and budget section.');
  else {
    // The strategy must cover every offer actually used.
    const used = [...new Set(cost.lines.map((l) => l.incentiveId))].filter((id) => !strategy.text.includes(id) && !strategy.text.toLowerCase().includes((menu.find((m) => m.id === id)?.label ?? id).toLowerCase()));
    if (used.length) problems.push(`Your campaign strategy doesn't mention ${used.map((u) => `"${u}"`).join(', ')}, which the campaign uses. Rewrite it so it matches what is built.`);
  }
  if (!notes.some((e) => e.kind === 'brief' && e.topic.toLowerCase() === 'spend'))
    problems.push('The campaign uses offers but the manager\'s speed vs spend appetite isn\'t on file (brief topic "Spend"). Ask them, or note your assumption ("cheapest first").');
  // The final budget pass: "as expected" must fit the budget; the cap protects the max.
  if (cost.mode === 'totals' && cost.budgetCap != null && cost.total.expected > cost.budgetCap) problems.push(budgetPass(cost));
  return { problems, cost };
}

/** The budget pass, as the agent sees it: the offers ranked so the uncertain, expensive ones are cut first. */
export function budgetPass(cost: CostReport): string {
  const rank = { low: 0, medium: 1, high: 2 } as const;
  const rows = [...cost.lines]
    .sort((a, b) => rank[a.confidence] - rank[b.confidence] || (b.expected ?? 0) - (a.expected ?? 0))
    .map((l) => `- ${l.bucketName} › "${l.step}" · ${l.incentiveLabel}: as expected ${inr(l.expected ?? 0)}, max ${inr(l.max ?? 0)}, confidence ${l.confidence}`);
  return [
    `BUDGET PASS: as expected the offers cost ${inr(cost.total.expected)}, over the ${inr(cost.budgetCap!)} budget. Fit it: cut offers, not people (no bucket is dropped). Cheapest change first: move an offer later (non-responders only), step a big offer down to a small one, narrow it to who needs it, or remove it (messages only). Start with low-confidence, expensive offers:`,
    ...rows,
    'Then write what you cut, why, and what it costs in results, in the Offers and budget section of your campaign strategy.',
  ].join('\n');
}

export { costLine };
