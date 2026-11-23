// The cost calculator: what the campaign's offers may cost the bank, worked
// out by code, never by the AI. It walks each journey with a running count of
// people, step by step, like a growth model:
//
//   message:   delivered = arriving × the bank's delivery rate (Knowledge Base)
//              opened    = delivered × the designer's "opens" estimate
//              converted = opened × the designer's "converts" estimate
//   goal check: everyone who converted since the last check leaves
//   branches:  split by those counts (read / delivered, not opened / the rest),
//              by real sizes from the data (signal routes), or by percentages (tests)
//
//   estimated cost of an offer = those who convert on its message, among those
//                                who qualify for it, × the average reward
//   max cost = everyone who qualifies takes it, at the most per person
//              (bucket: the most expensive offer path; campaign: the sum)
//
// The designer gives one best estimate per step, for the people who arrive at
// that step. Never stored as truth: worked out whenever it's shown.
import type { CampaignContext, CampaignObject } from './agent/types';
import type { BpStep } from './blueprint';
import type { TenantConfig } from './tenants';
import { bucketContext } from '../src/designer/v2/contextView';
import { incentivesFor, type Incentive } from './incentives';
import { conditionSql, signalsFor } from './signals';
import { customerIds, runWarehouseQuery, warehouseAvailable } from './warehouse';
import { DEFAULT_DELIVERY_RATES, fallbackFor, getBankSettings } from './bankSettings';

/** One of the designer's estimates on a step: a rate (0-1) for the people who arrive there, and why. */
export interface Rate {
  rate: number;
  why: string;
}

/** A step of an offer's funnel, from the top of the bucket down to taking the offer up. */
export interface FunnelStep {
  name: string;
  /** People at this step (null: can't be worked out, an estimate is missing upstream). */
  count: number | null;
  /** bank: the bank's delivery rate · designer: the designer's estimate · code: worked out (data, goal checks, branches). */
  source: 'bank' | 'designer' | 'code';
  /** The rate applied to the step before, when there is one. */
  rate?: number;
  why?: string;
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
  /** Customers in the bucket (or route), after any holdout (null = not sized). */
  customers: number | null;
  /** Of those, how many meet the offer's requirements and targeting (null = can't count). */
  qualified: number | null;
  /** The designer's estimates on the offer message. */
  opens: Rate | null;
  converts: Rate | null;
  /** The funnel from the top of the bucket to taking the offer up. */
  steps: FunnelStep[];
  avgReward: number;
  avgRewardSource: string;
  maxPerCustomer: number;
  /** Estimated cost (null: an estimate is missing on the way). */
  expected: number | null;
  /** If everyone who qualifies takes it, at the most per person. */
  max: number | null;
  /** The working, in words. */
  equations: { expected: string; max: string };
  /** The signal route this send sits on ("Electronics"; nested: "Electronics › EMI-eligible"), or null. */
  route: string | null;
  routeKey: string;
  /** Bucket evidence + where the estimate comes from. */
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

/** One message's funnel, for the designer (who arrives, opens, converts). */
export interface MessageFunnel {
  bucketId: string;
  stepId: string;
  name: string;
  /** Who arrives, in words: "everyone in the bucket", "opened “Welcome back” and didn't convert". */
  arriving: string;
  arrivingCount: number | null;
  delivered: number | null;
  opened: number | null;
  converted: number | null;
}

export interface CostReport {
  /** totals: rupee totals from sized buckets · perThousand: no data access, so per 1,000 customers · none: no offers. */
  mode: 'totals' | 'perThousand' | 'none';
  lines: CostLine[];
  buckets: { bucketId: string; name: string; expected: number; max: number }[];
  total: { expected: number; max: number; maxWithCap: number };
  budgetCap: number | null;
  notes: string[];
  /** Every signal route's size, for the canvas and the route checks. */
  routes: RouteSize[];
  /** Every message's funnel (offers or not), for the designer's build report. */
  messages: MessageFunnel[];
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
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

const isRate = (v: unknown): v is Rate => {
  const r = v as Rate;
  return !!r && typeof r === 'object' && typeof r.rate === 'number' && r.rate >= 0 && r.rate <= 1;
};

/** A step's funnel estimates (opens, converts), read leniently. */
export function funnelOf(step: Record<string, unknown>): { opens: Rate | null; converts: Rate | null } {
  const f = (step.funnel ?? {}) as { opens?: unknown; converts?: unknown };
  return { opens: isRate(f.opens) ? f.opens : null, converts: isRate(f.converts) ? f.converts : null };
}

/** Channels with no read receipts: delivered → converts, no "opens" step. */
export const NO_READS = new Set(['SMS']);

/** Every offer in the campaign, costed, per step, per bucket and in total, from a step-by-step funnel. */
export function campaignCost(campaign: CampaignObject, context: CampaignContext | null, tenant: Pick<TenantConfig, 'tenantId' | 'incentives' | 'warehouse'> | null): CostReport {
  const menu = incentivesFor(tenant);
  const bank = tenant?.warehouse?.bank && warehouseAvailable(tenant.warehouse.bank) ? tenant.warehouse.bank : null;
  const signals = signalsFor(tenant);
  const views = bucketContext(context?.entries ?? []);
  const settings = tenant?.tenantId ? getBankSettings(tenant.tenantId) : { smsFallback: true, deliveryRates: DEFAULT_DELIVERY_RATES };
  const rates = { ...DEFAULT_DELIVERY_RATES, ...(settings.deliveryRates ?? {}) };
  const delivery = (ch: string) => rates[ch as keyof typeof rates] ?? 0.9;
  const lanes = [
    ...[...campaign.buckets].sort((a, b) => a.priority - b.priority).map((b) => ({ id: b.id, name: b.name, holdoutPct: b.holdoutPct ?? 0, journey: b.journey, evidence: views[b.id]?.evidence })),
    ...(campaign.everyoneElse?.approach === 'journey' ? [{ id: 'everyone_else', name: 'Everyone else', holdoutPct: 0, journey: campaign.everyoneElse.journey, evidence: undefined }] : []),
  ];
  const perThousand = !bank;
  const notes: string[] = [];
  const lines: CostLine[] = [];
  const routes: RouteSize[] = [];
  const messages: MessageFunnel[] = [];
  const bucketMaxes: Record<string, number> = {};
  const ids = (sql: string | null | undefined): Set<string> | null => {
    if (!bank || !sql) return null;
    try {
      return customerIds(bank, sql);
    } catch {
      return null;
    }
  };
  const inter = (a: Set<string>, b: Set<string>) => new Set([...a].filter((x) => b.has(x)));

  /** What happened to the last message on this path: for a branch on its delivery status. */
  /** sms: no read receipts, so everyone who received it counts as "delivered" (converters come out of that group). */
  type Last = { name: string; notDelivered: number; deliveredNotOpened: number; opened: number; sms: boolean } | null;
  /**
   * A path through the journey: who is on it (customer ids, for routes and who qualifies), how many people
   * are still in the journey (traffic, null once an estimate is missing), the funnel so far, and who
   * converted since the last goal check (they leave there).
   */
  type Path = {
    set: Set<string> | null;
    key: string;
    label: string;
    traffic: number | null;
    pending: number;
    steps: FunnelStep[];
    last: Last;
    arriving: string;
    /** Offers already on this path (an offer is once per customer; the max counts it once). */
    offersSeen: Set<string>;
    /** Per offer, people on this path who took it up and are still in the journey (no goal check since). */
    taken: Record<string, number>;
    /** Inside a route nobody can count in advance: costed on the whole group above it. */
    unsplit: boolean;
  };

  for (const lane of lanes) {
    const laneSql = views[lane.id]?.sql;
    const laneSet = ids(laneSql);
    const savedSize = typeof views[lane.id]?.size === 'number' ? (views[lane.id]!.size as number) : null;
    const held = (n: number | null) => (n == null ? null : Math.round(n * (1 - lane.holdoutPct / 100)));
    const top = perThousand ? 1000 : held(savedSize ?? laneSet?.size ?? null);
    /** People per customer id in this lane (the saved size and the id set can differ slightly). */
    const scale = top != null && laneSet?.size ? top / laneSet.size : 1;

    const costSend = (s: Record<string, unknown>, p: Path): number => {
      const name = String(s.name ?? s.label ?? 'a message');
      const sid = typeof s.id === 'string' ? s.id : '';
      const channel = String(((s.channelPreference as string[] | undefined) ?? [])[0] ?? 'SMS');
      const { opens, converts } = funnelOf(s);
      const noReads = NO_READS.has(channel);
      const arriving = p.traffic;
      // Delivered, with the bank's SMS retry for WhatsApp/RCS messages that don't arrive.
      const fb = fallbackFor(s as { channelPreference?: string[]; fallbackChannel?: string }, settings.smsFallback);
      const d = delivery(channel);
      const delivered = arriving == null ? null : arriving * d;
      const viaFallback = arriving == null || !fb ? 0 : (arriving - (delivered ?? 0)) * delivery(fb);
      const opened = delivered == null ? null : noReads ? delivered + viaFallback : opens ? (delivered + viaFallback) * opens.rate : null;
      const converted = opened == null || !converts ? null : opened * converts.rate;
      messages.push({ bucketId: lane.id, stepId: sid, name, arriving: p.arriving, arrivingCount: arriving, delivered: delivered == null ? null : delivered + viaFallback, opened, converted });
      const msgSteps: FunnelStep[] = [
        { name: `“${name}” delivered`, count: delivered == null ? null : delivered + viaFallback, source: 'bank', rate: d, ...(viaFallback ? { why: `By ${channel}, or by ${fb} when it isn't delivered (the bank's retry setting).` } : {}) },
        ...(noReads ? [] : [{ name: 'Opened it', count: opened, source: 'designer' as const, rate: opens?.rate, why: opens?.why }]),
      ];
      const offerMax = offerLine(s, p, { name, sid, opens, converts, msgSteps, converted, noReads, arriving });
      // Converters leave at the next goal check; the path remembers what happened to this message.
      if (converted == null) p.traffic = null;
      else p.pending += converted;
      p.steps = [...p.steps, ...msgSteps, { name: 'Converted', count: converted, source: 'designer', rate: converts?.rate, why: converts?.why }];
      p.last =
        arriving == null || delivered == null || opened == null
          ? null
          : noReads
            ? { name, notDelivered: Math.max(0, arriving - delivered - viaFallback), deliveredNotOpened: delivered + viaFallback, opened: 0, sms: true }
            : { name, notDelivered: Math.max(0, arriving - delivered - viaFallback), deliveredNotOpened: Math.max(0, delivered + viaFallback - opened), opened, sms: false };
      return offerMax;
    };

    /** Costs the offer on a send (if any). Returns its max for this path (0 if none, or already counted on it). */
    const offerLine = (s: Record<string, unknown>, p: Path, m: { name: string; sid: string; opens: Rate | null; converts: Rate | null; msgSteps: FunnelStep[]; converted: number | null; noReads: boolean; arriving: number | null }): number => {
      if (typeof s.incentive !== 'string' || !s.incentive) return 0;
      const inc = menu.find((x) => x.id === s.incentive);
      if (!inc) {
        notes.push(`${lane.name} › "${m.name}": offer "${s.incentive}" is not on the menu, so it is not costed.`);
        return 0;
      }
      const customers = perThousand ? 1000 : p.set ? Math.round(p.set.size * scale) : top;
      let qualified: number | null = perThousand ? 1000 : null;
      if (bank && p.set) {
        // Who on this path meets the offer's requirements and targeting: set arithmetic on each condition.
        let q: Set<string> | null = p.set;
        for (const c of [...inc.requires, ...inc.eligibility]) {
          const cs = ids(conditionSql(signals, c));
          if (cs && q) q = inter(q, cs);
        }
        qualified = q ? Math.round(q.size * scale) : 0;
      }
      if (bank && customers == null) notes.push(`${p.label}: not sized yet, so its offer "${inc.label}" is not in the totals.`);
      const share = customers && qualified != null ? qualified / customers : 1;
      const reward = averageReward(inc, bank, laneSql);
      // An offer is once per customer: a repeat on this path (no goal check since) only counts those who haven't taken it.
      const eligible = (m.arriving ?? 0) * share;
      const left = eligible > 0 ? Math.max(0, 1 - (p.taken[inc.id] ?? 0) / eligible) : 1;
      const takers = m.converted == null ? null : m.converted * share * left;
      if (takers != null) p.taken[inc.id] = (p.taken[inc.id] ?? 0) + takers;
      const expected = takers == null ? null : Math.round(takers * reward.avg);
      const maxBase = qualified ?? customers;
      const max = maxBase == null ? null : Math.round(maxBase * reward.max);
      // Of those who open (receive, for SMS), only those who qualify can take the offer up.
      const openedCount = m.msgSteps[m.msgSteps.length - 1]?.count ?? null;
      const steps: FunnelStep[] = [
        ...p.steps,
        ...m.msgSteps,
        ...(share < 1 ? [{ name: 'Qualify for the offer', count: openedCount == null ? null : openedCount * share, source: 'code' as const, rate: share }] : []),
        { name: 'Take the offer up', count: takers, source: 'designer', rate: m.converts?.rate, why: m.converts?.why },
      ];
      const why = `${m.converts?.why ?? ''} ${m.opens?.why ?? ''}`;
      const fromResults = /(past|previous|last) campaign|measured|history shows|from (past )?results/i.test(why) && !/\bno (campaign )?(history|past)|judg(e)?ment/i.test(why);
      const missing = [!m.noReads && !m.opens ? 'opens' : null, !m.converts ? 'converts' : null].filter(Boolean).join(' and ');
      lines.push({
        bucketId: lane.id,
        bucketName: lane.name,
        route: p.key === lane.id ? null : p.label.replace(`${lane.name} › `, ''),
        routeKey: p.key,
        step: m.name,
        stepId: m.sid,
        incentiveId: inc.id,
        incentiveLabel: inc.label,
        customers,
        qualified,
        opens: m.opens,
        converts: m.converts,
        steps,
        avgReward: Math.round(reward.avg),
        avgRewardSource: reward.source,
        maxPerCustomer: Math.round(reward.max),
        expected,
        max,
        equations: {
          expected:
            expected == null
              ? missing
                ? `No estimate yet for ${missing} on “${m.name}”.`
                : 'An estimate is missing on an earlier message, so the people reaching this one can’t be worked out.'
              : `${Math.round(takers!).toLocaleString('en-IN')} take the offer up${left < 1 ? ` (of the ${Math.round(left * 100)}% who haven't already taken this offer)` : ''} × ${inr(reward.avg)} average reward = ${inr(expected)}${p.unsplit ? ' (on the whole group: who takes this route isn’t known in advance)' : ''}`,
          max: maxBase == null ? 'not sized' : `${maxBase.toLocaleString('en-IN')} who qualify × ${inr(reward.max)} (the most one person can cost) = ${inr(max ?? 0)}`,
        },
        confidence: lane.evidence === 'measured' ? (fromResults ? 'high' : 'medium') : 'low',
        engineOnly: inc.unmatchedCriteria,
      });
      if (inc.unmatchedCriteria.length) notes.push(`${lane.name} › "${m.name}": who qualifies and the cost may be lower than shown, because the engine also checks: ${inc.unmatchedCriteria.join(' ')}`);
      if (p.offersSeen.has(inc.id)) return 0;
      p.offersSeen.add(inc.id);
      return max ?? 0;
    };

    const fork = (p: Path, key: string, label: string, traffic: number | null, set: Set<string> | null, step: FunnelStep | null, arriving: string, unsplit = p.unsplit): Path => ({
      ...p,
      unsplit,
      taken: Object.fromEntries(Object.entries(p.taken).map(([k, v]) => [k, p.traffic && traffic != null ? (v * traffic) / p.traffic : 0])),
      key,
      label,
      set,
      traffic,
      // Converters who haven't hit a goal check yet stay with the people they're among: shared out by traffic.
      pending: p.traffic && traffic != null ? (p.pending * traffic) / p.traffic : 0,
      steps: step ? [...p.steps, step] : [...p.steps],
      last: p.last,
      arriving,
      offersSeen: new Set(p.offersSeen),
    });

    /**
     * Walks a list of steps with the people on this path. Returns the most the offers below can cost
     * (alternative paths: the larger; signal routes, which split people: the sum).
     */
    const walk = (list: BpStep[] | null | undefined, path: Path): number => {
      const p: Path = { ...path, steps: [...path.steps], offersSeen: new Set(path.offersSeen), taken: { ...path.taken } };
      let max = 0;
      for (const st of (list ?? []) as unknown as Record<string, unknown>[]) {
        const sid = typeof st.id === 'string' ? st.id : '';
        if (st.kind === 'send') {
          max += costSend(st, p);
          const name = String(st.name ?? st.label ?? 'a message');
          p.arriving = `got “${name}” and haven't converted yet`;
          continue;
        }
        if (st.kind === 'goalCheck') {
          if (p.traffic != null) {
            p.traffic = Math.max(0, p.traffic - p.pending);
            // Those who converted came from the people who opened it (who received it, for SMS).
            if (p.last) p.last = p.last.sms ? { ...p.last, deliveredNotOpened: Math.max(0, p.last.deliveredNotOpened - p.pending) } : { ...p.last, opened: Math.max(0, p.last.opened - p.pending) };
          }
          p.pending = 0;
          // Those who took an offer converted, so they've left too.
          p.taken = {};
          p.steps.push({ name: 'Haven’t converted yet', count: p.traffic, source: 'code' });
          continue;
        }
        if (st.kind === 'waitForEvent') {
          const { converts } = funnelOf(st);
          const did = p.traffic == null || !converts ? null : p.traffic * converts.rate;
          const ev = String(st.eventType ?? st.label ?? 'the event');
          const yes = fork(p, `${p.key}/${sid}:yes`, `${p.label} › did ${ev}`, did, p.set, { name: `Did ${ev}`, count: did, source: 'designer', rate: converts?.rate, why: converts?.why }, `did ${ev}`);
          const no = fork(p, `${p.key}/${sid}:no`, `${p.label} › didn't do ${ev}`, did == null || p.traffic == null ? null : p.traffic - did, p.set, { name: `Didn't do ${ev}`, count: did == null || p.traffic == null ? null : p.traffic - did, source: 'code' }, `didn't do ${ev}`);
          return max + Math.max(walk(st.yes as BpStep[], yes), walk(st.no as BpStep[], no));
        }
        if (st.kind === 'branch' && typeof st.signal === 'string' && st.signal) {
          // A signal switch: real route sizes from the data; people split, so the max adds up.
          const paths = (st.paths as { label?: string; operator?: string; value?: string; steps?: BpStep[] }[]) ?? [];
          const condSets = paths.map((q) => ids(conditionSql(signals, { attribute: st.signal as string, operator: q.operator, value: q.value })));
          const routeShare = (set: Set<string> | null) => (p.set && set && p.set.size ? set.size / p.set.size : null);
          let sum = 0;
          paths.forEach((q, i) => {
            const label = q.label ?? `route ${i + 1}`;
            const countable = !!condSets[i];
            const set = p.set ? (countable ? inter(p.set, condSets[i]!) : p.set) : null;
            routes.push({ bucketId: lane.id, stepId: sid, label, size: held(countable && set ? set.size : null) });
            const shareOf = countable ? routeShare(set) : null;
            const t = p.traffic == null ? null : shareOf == null ? p.traffic : p.traffic * shareOf;
            sum += walk(q.steps, fork(p, `${p.key}/${sid}:${i}`, `${p.label} › ${label}`, t, set, { name: `Route: ${label}`, count: t, source: 'code' }, `on the "${label}" route`, p.unsplit || !countable));
          });
          const allCountable = condSets.every(Boolean);
          const elseSet = p.set ? (allCountable ? new Set([...p.set].filter((x) => !condSets.some((c) => c!.has(x)))) : p.set) : null;
          routes.push({ bucketId: lane.id, stepId: sid, label: 'Everyone else', size: held(allCountable && elseSet ? elseSet.size : null), otherwise: true });
          const elseShare = allCountable ? routeShare(elseSet) : null;
          const te = p.traffic == null ? null : elseShare == null ? p.traffic : p.traffic * elseShare;
          sum += walk(st.otherwise as BpStep[] | undefined, fork(p, `${p.key}/${sid}:else`, `${p.label} › Everyone else`, te, elseSet, { name: 'Route: everyone else', count: te, source: 'code' }, 'on the "everyone else" route', p.unsplit || !allCountable));
          return max + sum;
        }
        if (st.kind === 'branch' && Array.isArray(st.paths)) {
          // A branch on what happened to the last message: read / delivered, not opened / the rest.
          const last = p.last;
          const paths = st.paths as { label?: string; statuses?: string[]; steps?: BpStep[] }[];
          let used = { opened: false, deliveredNotOpened: false };
          const best: number[] = [];
          const assigned: number[] = [];
          paths.forEach((q, i) => {
            const sts = (q.statuses ?? []).map((x) => x.toUpperCase());
            let t = 0;
            if (last && (sts.some((x) => ['READ', 'OPENED', 'CLICKED', 'SEEN'].includes(x)) && !used.opened)) {
              t += last.opened;
              used = { ...used, opened: true };
            }
            if (last && sts.includes('DELIVERED') && !used.deliveredNotOpened) {
              t += last.deliveredNotOpened;
              used = { ...used, deliveredNotOpened: true };
            }
            assigned.push(t);
            const label = q.label ?? `path ${i + 1}`;
            const tr = last && p.traffic != null ? t : null;
            best.push(walk(q.steps, fork(p, `${p.key}/${sid}:${i}`, `${p.label} › ${label}`, tr, p.set, { name: `Path: ${label}`, count: tr, source: 'code' }, `${label.charAt(0).toLowerCase()}${label.slice(1)} (after “${last?.name ?? 'the last message'}”)`)));
          });
          if (st.otherwise) {
            const rest = last && p.traffic != null ? Math.max(0, p.traffic - assigned.reduce((a, b) => a + b, 0)) : null;
            best.push(walk(st.otherwise as BpStep[], fork(p, `${p.key}/${sid}:else`, `${p.label} › Everyone else`, rest, p.set, { name: 'Path: everyone else', count: rest, source: 'code' }, `the rest (after “${last?.name ?? 'the last message'}”)`)));
          }
          return max + Math.max(0, ...best);
        }
        if (Array.isArray(st.arms)) {
          // A test: each arm gets its share of the people.
          const arms = st.arms as { label?: string; pct?: number; steps?: BpStep[] }[];
          const best = arms.map((a, i) => {
            const t = p.traffic == null ? null : (p.traffic * (a.pct ?? 0)) / 100;
            return walk(a.steps, fork(p, `${p.key}/${sid}:${i}`, `${p.label} › ${a.label ?? `arm ${i + 1}`}`, t, p.set, { name: `Test arm: ${a.label ?? i + 1} (${a.pct ?? 0}%)`, count: t, source: 'code' }, `in test arm "${a.label ?? i + 1}"`));
          });
          return max + Math.max(0, ...best);
        }
        if (Array.isArray(st.yes) || Array.isArray(st.no)) {
          // A condition nobody can count in advance: each side is costed on everyone (an upper bound).
          const best = ['yes', 'no'].map((k) => walk(st[k] as BpStep[], fork(p, `${p.key}/${sid}:${k}`, `${p.label} › ${k}`, p.traffic, p.set, null, p.arriving)));
          return max + Math.max(0, ...best);
        }
      }
      return max;
    };

    bucketMaxes[lane.id] = walk(lane.journey as BpStep[] | null | undefined, {
      set: laneSet,
      key: lane.id,
      label: lane.name,
      traffic: top,
      pending: 0,
      steps: [{ name: 'In the bucket', count: top, source: 'code' }],
      last: null,
      arriving: 'everyone in the bucket',
      offersSeen: new Set(),
      taken: {},
      unsplit: false,
    });
  }
  const sum = (list: { expected: number | null }[]) => list.reduce((n, l) => n + (l.expected ?? 0), 0);
  const buckets = [...new Set(lines.map((l) => l.bucketId))].map((id) => {
    const ls = lines.filter((l) => l.bucketId === id);
    return { bucketId: id, name: ls[0].bucketName, expected: sum(ls), max: bucketMaxes[id] ?? 0 };
  });
  const cap = typeof campaign.budgetCap === 'number' ? campaign.budgetCap : null;
  const max = buckets.reduce((n, b) => n + b.max, 0);
  if (perThousand && lines.length) notes.push('No data access: costs are per 1,000 customers, not campaign totals.');
  return {
    mode: !lines.length ? 'none' : bank ? 'totals' : 'perThousand',
    lines,
    buckets,
    total: { expected: sum(lines), max, maxWithCap: cap != null ? Math.min(max, cap) : max },
    budgetCap: cap,
    notes,
    routes,
    messages,
  };
}

/** The totals a version keeps, so history can show what each change did to the cost. Null when there are no offers. */
export interface CostSnapshot {
  expected: number;
  max: number;
  cap: number | null;
  unit: 'totals' | 'perThousand';
}

export function costSnapshot(campaign: CampaignObject, context: CampaignContext | null, tenant: Pick<TenantConfig, 'tenantId' | 'incentives' | 'warehouse'> | null): CostSnapshot | null {
  try {
    const r = campaignCost(campaign, context, tenant);
    if (r.mode === 'none') return null;
    return { expected: r.total.expected, max: r.total.max, cap: r.budgetCap, unit: r.mode };
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
  if (!before && after) return `Offers added: estimated ${shortInr(after.expected)} · max ${shortInr(after.max)}${after.unit === 'perThousand' ? ' (per 1,000)' : ''}`;
  if (before && !after) return 'Offers removed: no spend on offers';
  const a = before!;
  const b = after!;
  const parts: string[] = [];
  if (Math.round(a.expected) !== Math.round(b.expected)) parts.push(`Estimated ${shortInr(a.expected)} → ${shortInr(b.expected)}`);
  if (Math.round(a.max) !== Math.round(b.max)) parts.push(`Max ${shortInr(a.max)} → ${shortInr(b.max)}`);
  if ((a.cap ?? null) !== (b.cap ?? null)) parts.push(`Cap ${a.cap != null ? shortInr(a.cap) : 'none'} → ${b.cap != null ? shortInr(b.cap) : 'none'}`);
  return parts.length ? parts.join(' · ') : null;
}

/** One line for the agent and the brief, e.g. "Estimated ₹90,000 · Max ₹10,00,000 → capped at ₹5,00,000". */
export function costLine(r: CostReport): string {
  if (r.mode === 'none') return 'No offers in this campaign.';
  const unit = r.mode === 'perThousand' ? ' per 1,000 customers' : '';
  return `Estimated ${inr(r.total.expected)} · Max ${inr(r.total.max)}${r.budgetCap != null && r.total.max > r.budgetCap ? ` → capped at ${inr(r.budgetCap)}` : ''}${unit}`;
}

/**
 * The funnel per bucket, for the designer, one line per message with who arrives:
 * Lapsed: “Welcome back” to 13,800 (everyone in the bucket): delivered 13,731, opened 8,239, converted 824 → …
 */
export function funnelReport(r: CostReport, names: Record<string, string>): string {
  const n = (x: number | null) => (x == null ? '?' : Math.round(x).toLocaleString('en-IN'));
  const by = new Map<string, MessageFunnel[]>();
  for (const m of r.messages) by.set(m.bucketId, [...(by.get(m.bucketId) ?? []), m]);
  return [...by.entries()]
    .map(([id, ms]) => `${names[id] ?? id}: ${ms.map((m) => `“${m.name}” to ${n(m.arrivingCount)} (${m.arriving}): delivered ${n(m.delivered)}, opened ${n(m.opened)}, converted ${m.converted == null ? 'no estimate yet' : n(m.converted)}`).join(' → ')}`)
    .join(' | ');
}
