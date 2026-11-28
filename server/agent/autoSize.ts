// Buckets sized by code from their rules. When a bucket's rule is written in
// signals, the app builds its sizing query itself (each signal's own SQL),
// within the eligible population and after excluding every earlier bucket
// (first match wins), leaving out customers who are never messaged (do-not-contact,
// NPA), and counts it. Nobody writes SQL for it. A bucket whose
// rule can't be written in signals is sized by the data analyst instead
// (ask_data with sizeBucket).
//
// Everything is counted within the scope (which card logos it is for): signals
// look only at the scoped logos' cards, and only their holders count. The same
// queries, built for a past day, give the 90-day trend (server/trend.ts).
import type { AgentState, CampaignObject } from './types';
import type { TenantConfig } from '../tenants';
import { conditionSql, signalConditionText, signalsFor, type Signal, type SignalContext } from '../signals';
import { holdersSql, scopeContext } from '../logos';
import { countCustomers, warehouseAvailable, warehouseSchema } from '../warehouse';
import { bucketContext, type BucketView } from '../../src/designer/v2/contextView';
import { addContext } from './state';

/** The sizing entry for the whole target: everyone the campaign reaches (its buckets, plus everyone else when they get a journey). */
export const TARGET_ID = '__target';

type Group = { entity?: string; conditions?: { attribute?: string; operator?: string; value?: string }[] };

/** The SQL for a set of Signal-only rule groups (ANDed), or null when any part isn't a signal condition. */
function rulesSql(groups: Group[] | undefined, signals: Signal[], ctx: SignalContext = {}): string[] | null {
  if (!groups?.length) return null;
  const out: string[] = [];
  for (const g of groups) {
    if (g.entity !== 'Signal' || !g.conditions?.length) return null;
    for (const c of g.conditions) {
      const sql = conditionSql(signals, c, ctx);
      if (!sql) return null;
      out.push(sql);
    }
  }
  return out;
}

export interface SizingPlan {
  /** Everyone eligible, within the scope, never-messaged lists left out. */
  base: string;
  /** Per bucket in priority order: its first-match query, built from signals by the app (own: false) or the designer's saved query (own: true); null if neither. */
  buckets: { id: string; name: string; sql: string | null; own: boolean }[];
  /** The first bucket with no query: those after it can't be sized exactly. */
  blocked: string | null;
  /** Everyone in no bucket. */
  everyoneElse: string | null;
  /** Everyone it reaches: the buckets, plus everyone else when they get a journey. Null while a bucket has no query. */
  target: string | null;
}

/**
 * The sizing queries for a campaign, as of the data's last day or a past day (`asOf`, for the trend).
 * A bucket with its own saved query is used as it is today (it can't be replayed for a past day).
 */
export function sizingPlan(c: CampaignObject, tenant: Pick<TenantConfig, 'warehouse'> | null, views: Record<string, BucketView>, asOf?: string): SizingPlan | null {
  const bank = tenant?.warehouse?.bank;
  if (!bank || !warehouseAvailable(bank)) return null;
  const signals = signalsFor(tenant);
  const ctx = scopeContext(c.scope, asOf);
  const tables = warehouseSchema(bank).tables;
  // The eligible population: the entry's own signal rule if it has one, else active customers; within the scope.
  const entryConds = rulesSql((c.entry as { groups?: Group[] } | null)?.groups, signals, ctx);
  const inScope = tables.some((t) => t.table === 'cards') ? [`customer_id IN (${holdersSql(c.scope, asOf)})`] : [];
  const hasActive = tables.find((t) => t.table === 'customers')?.columns.some((col) => col.name === 'is_active');
  // Never messaged, so never counted: the do-not-contact and NPA lists (the campaign's guardrails).
  const never = ['dnc_list', 'npa_list'].filter((t) => tables.some((x) => x.table === t)).map((t) => `customer_id NOT IN (SELECT customer_id FROM ${t})`);
  const where = [...(entryConds?.length ? entryConds.map((q) => `customer_id IN (${q})`) : hasActive ? ['is_active = 1'] : []), ...inScope, ...never];
  const base = `SELECT customer_id FROM customers${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
  const earlier: string[] = [];
  const buckets: SizingPlan['buckets'] = [];
  let blocked: string | null = null;
  for (const b of [...c.buckets].sort((x, y) => x.priority - y.priority)) {
    const conds = rulesSql(b.rule as Group[], signals, ctx);
    if (conds && !blocked) {
      const w = [...conds.map((q) => `customer_id IN (${q})`), ...earlier.map((q) => `customer_id NOT IN (${q})`)].join(' AND ');
      const sql = `SELECT customer_id FROM (${base}) WHERE ${w}`;
      buckets.push({ id: b.id, name: b.name, sql, own: false });
      earlier.push(sql);
      continue;
    }
    const own = views[b.id]?.sql ?? null;
    buckets.push({ id: b.id, name: b.name, sql: own, own: true });
    if (own) earlier.push(own);
    else blocked ??= b.name;
  }
  const everyoneElse = blocked ? null : earlier.length ? `SELECT customer_id FROM (${base}) WHERE ${earlier.map((q) => `customer_id NOT IN (${q})`).join(' AND ')}` : base;
  const reach = c.everyoneElse?.approach === 'journey';
  const target = blocked || !c.buckets.length ? null : reach ? base : `SELECT customer_id FROM (${base}) WHERE ${earlier.map((q) => `customer_id IN (${q})`).join(' OR ')}`;
  return { base, buckets, blocked, everyoneElse, target };
}

/** Who is eligible, in plain words: the entry rule (within the scope), and who is never counted. For the entry card. */
export function entryWords(c: CampaignObject, tenant: Pick<TenantConfig, 'warehouse'> | null): string[] {
  const signals = signalsFor(tenant);
  const groups = ((c.entry as { groups?: Group[] } | null)?.groups ?? []).filter((g) => g.entity === 'Signal');
  const conds = groups.flatMap((g) => g.conditions ?? []).map((x) => signalConditionText(signals, { attribute: String(x.attribute ?? ''), operator: String(x.operator ?? ''), value: x.value }));
  return [...(conds.length ? conds : ['Every active customer holding one of these cards']), 'Not on the do-not-contact or NPA lists'];
}

/** Sizes every bucket the app can (signal rules), filing new sizing only when the query changed. Returns notes for the build report. */
export function autoSizeBuckets(state: AgentState, tenant: Pick<TenantConfig, 'warehouse'> | null): { state: AgentState; notes: string[] } {
  const bank = tenant?.warehouse?.bank;
  if (!bank || !warehouseAvailable(bank)) return { state, notes: [] };
  const views = bucketContext(state.context.entries);
  const plan = sizingPlan(state.campaign, tenant, views);
  if (!plan) return { state, notes: [] };
  const notes: string[] = [];
  const add: Record<string, unknown>[] = [];
  const size = (id: string, sql: string, text: string, label: string, extra: Record<string, unknown> = {}) => {
    if (views[id]?.sql === sql && JSON.stringify(views[id]?.rule ?? null) === JSON.stringify((extra.rule as unknown) ?? null)) return;
    try {
      add.push({ kind: 'sizing', bucketId: id, topic: 'size', text, source: 'data', data: { sql, size: countCustomers(bank, sql), ...extra } });
    } catch (e) {
      notes.push(`${label}: could not be sized (${(e as Error).message}).`);
    }
  };
  for (const b of plan.buckets) {
    if (!b.own && b.sql) size(b.id, b.sql, `Sized by the app from the bucket's rule (first match wins).`, `Bucket "${b.name}"`);
    else if (!b.sql) notes.push(`Bucket "${b.name}" isn't sized: its rule isn't written in signals. Rewrite it in signals (list_signals), or ask_data with sizeBucket "${b.id}".`);
  }
  if (plan.blocked) notes.push(`Buckets after "${plan.blocked}" can't be sized exactly until it is (first match wins).`);
  // The totals for the canvas: everyone it reaches, and everyone else (in the target, in no bucket).
  if (plan.target) size(TARGET_ID, plan.target, 'Everyone the campaign reaches, within the scope: its buckets (and everyone else, when they get a journey).', 'The total in target', { rule: entryWords(state.campaign, tenant) });
  if (plan.everyoneElse) size('everyone_else', plan.everyoneElse, 'Everyone else: eligible and within the scope, but in no bucket.', 'Everyone else');
  if (!add.length) return { state, notes };
  return { state: addContext(state, add, 'app').state, notes };
}
