// The cost calculator: what the campaign's offers may cost the bank, worked
// out by code, never by the AI. The AI supplies only its estimates on each
// offer step (costAssumptions: how many reach the offer, how many take it up);
// sizes come from the data (each bucket's saved sizing query), rewards and
// caps from the incentive menu, averages from the data.
//
//   cost = customers × P(reach the offer) × P(take it up) × average reward
//   max  = customers who qualify × the most one customer can cost
//
// Three scenarios, named by how the campaign performs: if it underperforms
// (the "few" estimates), as expected, and if it outperforms (max: everyone
// who qualifies takes it up, at the most they can cost). Never stored as
// truth: worked out whenever it's shown.
import type { CampaignContext, CampaignObject } from './agent/types';
import type { BpStep } from './blueprint';
import type { TenantConfig } from './tenants';
import { bucketContext } from '../src/designer/v2/contextView';
import { incentivesFor, type Incentive } from './incentives';
import { conditionSql, signalsFor } from './signals';
import { customerIds, runWarehouseQuery, warehouseAvailable } from './warehouse';

export interface Estimate {
  expected: number;
  few: number;
  why: string;
}

export interface CostLine {
  bucketId: string;
  bucketName: string;
  /** The message that makes the offer. */
  step: string;
  /** Its backend id (for editing its estimates from the canvas). */
  stepId: string;
  incentiveId: string;
  incentiveLabel: string;
  /** Customers in the bucket, after any holdout (null = not sized). */
  customers: number | null;
  /** Of those, how many meet the offer's requirements and targeting (null = can't count). */
  qualified: number | null;
  reach: Estimate | null;
  redeem: Estimate | null;
  avgReward: number;
  avgRewardSource: string;
  maxPerCustomer: number;
  under: number | null;
  expected: number | null;
  max: number | null;
  /** The working, one line per scenario. */
  equations: { under: string; expected: string; max: string };
  /** The signal route this send sits on ("Electronics"; nested: "Electronics › EMI-eligible"), or null. */
  route: string | null;
  /** Internal: which route (for counting an offer once per route). */
  routeKey: string;
  /** Bucket evidence + where the take-up estimate comes from. */
  confidence: 'high' | 'medium' | 'low';
  /** Offer rules the data can't check (the engine checks them when it sends): the counts may be lower. */
  engineOnly: string[];
}

/** How many customers take each route of a signal switch (null = can't count: no data, or a journey signal). */
export interface RouteSize {
  bucketId: string;
  /** The switch step's id. */
  stepId: string;
  label: string;
  size: number | null;
  otherwise?: boolean;
}

export interface CostReport {
  /** totals: rupee totals from sized buckets · perThousand: no data access, so per 1,000 customers · none: no offers. */
  mode: 'totals' | 'perThousand' | 'none';
  lines: CostLine[];
  buckets: { bucketId: string; name: string; under: number; expected: number; max: number }[];
  total: { under: number; expected: number; max: number; maxWithCap: number };
  budgetCap: number | null;
  notes: string[];
  /** Every signal route's size, for the canvas and the route checks. */
  routes: RouteSize[];
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const pct = (f: number) => `${Math.round(f * 1000) / 10}%`;
const ASOF = `(SELECT MAX(transaction_date) FROM transactions)`;

function one(bank: string, sql: string): number | null {
  try {
    const v = runWarehouseQuery(bank, sql).rows[0];
    const n = v ? Number(Object.values(v)[0]) : NaN;
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** The average reward one redemption costs, and where that number comes from. */
function averageReward(i: Incentive, bank: string | null, groupSql: string | undefined): { avg: number; max: number; source: string } {
  const c = i.cost;
  switch (i.costType) {
    case 'flat':
      return { avg: c.perRedemption ?? i.maxCostPerCustomer, max: c.perRedemption ?? i.maxCostPerCustomer, source: 'incentive menu (flat)' };
    case 'pctOfSpend': {
      const cap = c.capPerCustomer ?? i.maxCostPerCustomer;
      const rate = (c.ratePct ?? 0) / 100;
      // Someone who redeems is spending: use what customers who spend typically spend in the offer's window.
      const spend = bank ? one(bank, `SELECT AVG(s) FROM (SELECT customer_id, SUM(amount) AS s FROM transactions WHERE transaction_date >= date(${ASOF}, '-${i.trigger.withinDays} day') GROUP BY customer_id)`) : null;
      if (spend == null) return { avg: cap, max: cap, source: 'no data: assumed the cap' };
      return { avg: Math.min(cap, rate * spend), max: cap, source: `data: ${i.cost.ratePct}% of the typical ${i.trigger.withinDays}-day spend of customers who spend (${inr(spend)}), capped at ${inr(cap)}` };
    }
    case 'interest': {
      const disc = (c.interestDiscountPctPa ?? 0) / 100;
      const amount = bank ? one(bank, `SELECT AVG(amount) FROM transactions WHERE is_emi = 1`) : null;
      const tenure = bank ? one(bank, `SELECT AVG(preferred_tenure) FROM emi_eligibility WHERE eligible_for_emi = 1`) : null;
      if (amount == null || tenure == null) return { avg: i.maxCostPerCustomer, max: i.maxCostPerCustomer, source: 'no data: assumed the most per customer' };
      // Interest on a reducing balance averages about 55% of the starting amount over the tenure.
      const cost = Math.min(i.maxCostPerCustomer, amount * disc * (tenure / 12) * 0.55);
      return { avg: cost, max: i.maxCostPerCustomer, source: `data: typical EMI ${inr(amount)} over ${Math.round(tenure)} months × ${c.interestDiscountPctPa}% p.a. (reducing balance), capped at ${inr(i.maxCostPerCustomer)}` };
    }
    case 'cardFee': {
      const fees = c.feeByCardType ?? {};
      const cases = Object.entries(fees).map(([k, v]) => `WHEN '${k.replace(/'/g, "''")}' THEN ${Number(v)}`).join(' ');
      const maxFee = Math.max(0, ...Object.values(fees));
      if (bank && groupSql && cases) {
        const inner = groupSql.trim().replace(/;+\s*$/, '');
        const avg = one(bank, `SELECT AVG(CASE c.card_type ${cases} ELSE 0 END) FROM customers c WHERE c.customer_id IN (SELECT customer_id FROM (${inner}))`);
        const mx = one(bank, `SELECT MAX(CASE c.card_type ${cases} ELSE 0 END) FROM customers c WHERE c.customer_id IN (SELECT customer_id FROM (${inner}))`);
        if (avg != null) return { avg, max: mx ?? maxFee, source: "data: average annual fee of this bucket's card types (fees assumed per card type)" };
      }
      return { avg: maxFee, max: maxFee, source: 'no data: assumed the highest fee' };
    }
  }
}

const isEstimate = (v: unknown): v is Estimate => {
  const e = v as Estimate;
  return !!e && typeof e === 'object' && [e.expected, e.few].every((x) => typeof x === 'number' && x >= 0 && x <= 1);
};

/** Every offer in the campaign, costed, per step, per bucket and in total. */
export function campaignCost(campaign: CampaignObject, context: CampaignContext | null, tenant: Pick<TenantConfig, 'incentives' | 'warehouse'> | null): CostReport {
  const menu = incentivesFor(tenant);
  const bank = tenant?.warehouse?.bank && warehouseAvailable(tenant.warehouse.bank) ? tenant.warehouse.bank : null;
  const signals = signalsFor(tenant);
  const views = bucketContext(context?.entries ?? []);
  const lanes = [
    ...[...campaign.buckets].sort((a, b) => a.priority - b.priority).map((b) => ({ id: b.id, name: b.name, holdoutPct: b.holdoutPct ?? 0, journey: b.journey, evidence: views[b.id]?.evidence })),
    ...(campaign.everyoneElse?.approach === 'journey' ? [{ id: 'everyone_else', name: 'Everyone else', holdoutPct: 0, journey: campaign.everyoneElse.journey, evidence: undefined }] : []),
  ];
  const notes: string[] = [];
  const lines: CostLine[] = [];
  const routes: RouteSize[] = [];
  const ids = (sql: string | null | undefined): Set<string> | null => {
    if (!bank || !sql) return null;
    try {
      return customerIds(bank, sql);
    } catch {
      return null;
    }
  };
  const inter = (a: Set<string>, b: Set<string>) => new Set([...a].filter((x) => b.has(x)));
  type Scope = { set: Set<string> | null; key: string; label: string };
  for (const lane of lanes) {
    const laneSql = views[lane.id]?.sql;
    /**
     * Walks the journey with the customers each step applies to (its scope): the bucket, narrowed by
     * every signal route above it. Sends inside a route are costed on the route's size. Routes are set
     * arithmetic on each signal's customers, loaded once.
     */
    const walk = (list: BpStep[] | null | undefined, scope: Scope) => {
      for (const st of (list ?? []) as unknown as Record<string, unknown>[]) {
        if (st.kind === 'send') costSend(st, scope);
        if (st.kind === 'branch' && typeof st.signal === 'string' && st.signal) {
          const paths = (st.paths as { label?: string; operator?: string; value?: string; steps?: BpStep[] }[]) ?? [];
          const condSets = paths.map((p) => ids(conditionSql(signals, { attribute: st.signal as string, operator: p.operator, value: p.value })));
          const sid = typeof st.id === 'string' ? st.id : '';
          const held = (n: number | null) => (n == null ? null : Math.round(n * (1 - lane.holdoutPct / 100)));
          paths.forEach((p, i) => {
            const label = p.label ?? `route ${i + 1}`;
            const set = scope.set && condSets[i] ? inter(scope.set, condSets[i]!) : null;
            routes.push({ bucketId: lane.id, stepId: sid, label, size: held(set ? set.size : null) });
            walk(p.steps, { set, key: `${scope.key}/${sid}:${i}`, label: `${scope.label} › ${label}` });
          });
          // Everyone else: the scope minus every route (when all routes can be counted).
          const elseSet = scope.set && condSets.every(Boolean) ? new Set([...scope.set].filter((x) => !condSets.some((c) => c!.has(x)))) : null;
          routes.push({ bucketId: lane.id, stepId: sid, label: 'Everyone else', size: held(elseSet ? elseSet.size : null), otherwise: true });
          walk(st.otherwise as BpStep[] | undefined, { set: elseSet, key: `${scope.key}/${sid}:else`, label: `${scope.label} › Everyone else` });
          continue;
        }
        for (const k of ['yes', 'no', 'otherwise']) if (Array.isArray(st[k])) walk(st[k] as BpStep[], scope);
        for (const k of ['arms', 'paths']) if (Array.isArray(st[k])) (st[k] as { steps?: BpStep[] }[]).forEach((a) => walk(a.steps, scope));
      }
    };
    const costSend = (s: Record<string, unknown>, scope: Scope) => {
      if (typeof s.incentive !== 'string' || !s.incentive) return;
      const inc = menu.find((m) => m.id === s.incentive);
      const step = String(s.name ?? s.label ?? 'a message');
      if (!inc) {
        notes.push(`${lane.name} › "${step}": offer "${s.incentive}" is not on the menu, so it is not costed.`);
        return;
      }
      // At the bucket level the saved size is used (it is what the canvas shows); inside a route, the route's count.
      const atBucket = scope.key === lane.id;
      const savedSize = typeof views[lane.id]?.size === 'number' ? (views[lane.id]!.size as number) : null;
      const sized = atBucket ? (savedSize ?? scope.set?.size ?? null) : scope.set ? scope.set.size : null;
      const perThousand = !bank;
      const customers = perThousand ? 1000 : sized == null ? null : Math.round(sized * (1 - lane.holdoutPct / 100));
      let qualified: number | null = perThousand ? 1000 : null;
      if (bank && scope.set && customers != null) {
        // Who in this scope meets the offer's requirements and targeting: set arithmetic on each condition.
        let q: Set<string> | null = scope.set;
        for (const c of [...inc.requires, ...inc.eligibility]) {
          const cs = ids(conditionSql(signals, c));
          if (cs && q) q = inter(q, cs);
        }
        qualified = q && scope.set.size ? Math.round((customers * q.size) / scope.set.size) : 0;
      }
      if (bank && customers == null) notes.push(`${scope.label}: not sized yet, so its offer "${inc.label}" is not in the totals.`);
      const reward = averageReward(inc, bank, laneSql);
      const ca = (s.costAssumptions ?? {}) as { reach?: unknown; redeem?: unknown };
      const reach = isEstimate(ca.reach) ? (ca.reach as Estimate) : null;
      const redeem = isEstimate(ca.redeem) ? (ca.redeem as Estimate) : null;
      const base = qualified ?? customers;
      const cost = (r: number | undefined, d: number | undefined) => (base == null || r == null || d == null ? null : Math.round(base * r * d * reward.avg));
      const who = qualified != null && !perThousand ? `${qualified.toLocaleString('en-IN')} who qualify` : perThousand ? '1,000 customers' : `${(customers ?? 0).toLocaleString('en-IN')} customers`;
      const eq = (label: string, r?: number, d?: number) =>
        base == null ? 'not sized' : r == null || d == null ? 'no estimate yet' : `${who} × ${pct(r)} reach × ${pct(d)} take it up × ${inr(reward.avg)} = ${inr(base * r * d * reward.avg)}${label}`;
      const maxBase = qualified ?? customers;
      const why = `${redeem?.why ?? ''} ${reach?.why ?? ''}`;
      // High only when the take-up comes from real past results; judgement (or "no history") is medium at best.
      const fromResults = /(past|previous|last) campaign|measured take-?up|history shows|from (past )?results/i.test(why) && !/\bno (campaign )?(history|past)|judg(e)?ment/i.test(why);
      const confidence: CostLine['confidence'] = lane.evidence === 'measured' ? (fromResults ? 'high' : 'medium') : 'low';
      lines.push({
        bucketId: lane.id,
        bucketName: lane.name,
        route: scope.key === lane.id ? null : scope.label.replace(`${lane.name} › `, ''),
        routeKey: scope.key,
        step,
        stepId: typeof s.id === 'string' ? s.id : '',
        incentiveId: inc.id,
        incentiveLabel: inc.label,
        customers,
        qualified,
        reach,
        redeem,
        avgReward: Math.round(reward.avg),
        avgRewardSource: reward.source,
        maxPerCustomer: Math.round(reward.max),
        under: cost(reach?.few, redeem?.few),
        expected: cost(reach?.expected, redeem?.expected),
        max: maxBase == null ? null : Math.round(maxBase * reward.max),
        equations: {
          under: eq('', reach?.few, redeem?.few),
          expected: eq('', reach?.expected, redeem?.expected),
          max: maxBase == null ? 'not sized' : `${who} × 100% × 100% × ${inr(reward.max)} (the most one customer can cost) = ${inr(maxBase * reward.max)}`,
        },
        confidence,
        engineOnly: inc.unmatchedCriteria,
      });
      if (inc.unmatchedCriteria.length)
        notes.push(`${lane.name} › "${step}": who qualifies and the cost may be lower than shown, because the engine also checks: ${inc.unmatchedCriteria.join(' ')}`);
    };
    walk(lane.journey as BpStep[] | null | undefined, { set: ids(laneSql), key: lane.id, label: lane.name });
  }
  const sum = (k: 'under' | 'expected' | 'max', list: CostLine[]) => list.reduce((n, l) => n + (l[k] ?? 0), 0);
  // The max counts each offer once per bucket: an offer is once per customer, and the same offer on two
  // routes of one bucket (e.g. readers / SMS retry) reaches each customer on one route only.
  const bucketMax = (ls: CostLine[]) => [...new Set(ls.map((l) => `${l.routeKey}|${l.incentiveId}`))].reduce((n, k) => n + Math.max(0, ...ls.filter((l) => `${l.routeKey}|${l.incentiveId}` === k).map((l) => l.max ?? 0)), 0);
  const buckets = [...new Set(lines.map((l) => l.bucketId))].map((id) => {
    const ls = lines.filter((l) => l.bucketId === id);
    return { bucketId: id, name: ls[0].bucketName, under: sum('under', ls), expected: sum('expected', ls), max: bucketMax(ls) };
  });
  const cap = typeof campaign.budgetCap === 'number' ? campaign.budgetCap : null;
  const max = buckets.reduce((n, b) => n + b.max, 0);
  if (!bank && lines.length) notes.push('No data access: costs are per 1,000 customers, not campaign totals.');
  return {
    mode: !lines.length ? 'none' : bank ? 'totals' : 'perThousand',
    lines,
    buckets,
    total: { under: sum('under', lines), expected: sum('expected', lines), max, maxWithCap: cap != null ? Math.min(max, cap) : max },
    budgetCap: cap,
    notes,
    routes,
  };
}

/** The totals a version keeps, so history can show what each change did to the cost. Null when there are no offers. */
export interface CostSnapshot {
  under: number;
  expected: number;
  max: number;
  cap: number | null;
  unit: 'totals' | 'perThousand';
}

export function costSnapshot(campaign: CampaignObject, context: CampaignContext | null, tenant: Pick<TenantConfig, 'incentives' | 'warehouse'> | null): CostSnapshot | null {
  try {
    const r = campaignCost(campaign, context, tenant);
    if (r.mode === 'none') return null;
    return { under: r.total.under, expected: r.total.expected, max: r.total.max, cap: r.budgetCap, unit: r.mode };
  } catch {
    return null;
  }
}

/** "₹1.6L", "₹95k", "₹800" — short enough for a history line. */
export function shortInr(n: number): string {
  if (n >= 1e7) return `₹${Math.round(n / 1e6) / 10}Cr`;
  if (n >= 1e5) return `₹${Math.round(n / 1e4) / 10}L`;
  if (n >= 1e3) return `₹${Math.round(n / 100) / 10}k`;
  return `₹${Math.round(n)}`;
}

/** What a change did to the cost, in one line, or null when nothing moved. */
export function costChange(before: CostSnapshot | null | undefined, after: CostSnapshot | null | undefined): string | null {
  // undefined = not recorded (versions from before cost history): nothing to compare against.
  if (before === undefined || after === undefined) return null;
  if (!before && !after) return null;
  if (!before && after) return `Offers added: as expected ${shortInr(after.expected)} · max ${shortInr(after.max)}${after.unit === 'perThousand' ? ' (per 1,000)' : ''}`;
  if (before && !after) return 'Offers removed: no spend on offers';
  const a = before!;
  const b = after!;
  const parts: string[] = [];
  if (Math.round(a.expected) !== Math.round(b.expected)) parts.push(`As expected ${shortInr(a.expected)} → ${shortInr(b.expected)}`);
  if (Math.round(a.max) !== Math.round(b.max)) parts.push(`Max ${shortInr(a.max)} → ${shortInr(b.max)}`);
  if ((a.cap ?? null) !== (b.cap ?? null)) parts.push(`Cap ${a.cap != null ? shortInr(a.cap) : 'none'} → ${b.cap != null ? shortInr(b.cap) : 'none'}`);
  return parts.length ? parts.join(' · ') : null;
}

/** One line for the agent and the brief, e.g. "If it underperforms ₹30,000 · As expected ₹90,000 · If it outperforms (max) ₹10,00,000 → capped at ₹5,00,000". */
export function costLine(r: CostReport): string {
  if (r.mode === 'none') return 'No offers in this campaign.';
  const unit = r.mode === 'perThousand' ? ' per 1,000 customers' : '';
  return `If it underperforms ${inr(r.total.under)} · As expected ${inr(r.total.expected)} · If it outperforms (max) ${inr(r.total.max)}${r.budgetCap != null && r.total.max > r.budgetCap ? ` → capped at ${inr(r.budgetCap)}` : ''}${unit}`;
}
