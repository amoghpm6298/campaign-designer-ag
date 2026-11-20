// Buckets sized by code from their rules. When a bucket's rule is written in
// signals, the app builds its sizing query itself (each signal's own SQL),
// within the eligible population and after excluding every earlier bucket
// (first match wins), leaving out customers who are never messaged (do-not-contact,
// NPA), and counts it. Nobody writes SQL for it. A bucket whose
// rule can't be written in signals is sized by the data analyst instead
// (ask_data with sizeBucket).
import type { AgentState } from './types';
import type { TenantConfig } from '../tenants';
import { conditionSql, signalsFor, type Signal } from '../signals';
import { countCustomers, warehouseAvailable, warehouseSchema } from '../warehouse';
import { bucketContext } from '../../src/designer/v2/contextView';
import { addContext } from './state';

type Group = { entity?: string; conditions?: { attribute?: string; operator?: string; value?: string }[] };

/** The SQL for a set of Signal-only rule groups (ANDed), or null when any part isn't a signal condition. */
function rulesSql(groups: Group[] | undefined, signals: Signal[]): string[] | null {
  if (!groups?.length) return null;
  const out: string[] = [];
  for (const g of groups) {
    if (g.entity !== 'Signal' || !g.conditions?.length) return null;
    for (const c of g.conditions) {
      const sql = conditionSql(signals, c);
      if (!sql) return null;
      out.push(sql);
    }
  }
  return out;
}

/** Sizes every bucket the app can (signal rules), filing new sizing only when the query changed. Returns notes for the build report. */
export function autoSizeBuckets(state: AgentState, tenant: Pick<TenantConfig, 'warehouse'> | null): { state: AgentState; notes: string[] } {
  const bank = tenant?.warehouse?.bank;
  if (!bank || !warehouseAvailable(bank)) return { state, notes: [] };
  const signals = signalsFor(tenant);
  const views = bucketContext(state.context.entries);
  const c = state.campaign;
  // The eligible population: the entry's own signal rule if it has one, else active customers.
  const entryConds = rulesSql((c.entry as { groups?: Group[] } | null)?.groups, signals);
  const tables = warehouseSchema(bank).tables;
  const hasActive = tables.find((t) => t.table === 'customers')?.columns.some((col) => col.name === 'is_active');
  // Never messaged, so never counted: the do-not-contact and NPA lists (the campaign's guardrails).
  const never = ['dnc_list', 'npa_list'].filter((t) => tables.some((x) => x.table === t)).map((t) => `customer_id NOT IN (SELECT customer_id FROM ${t})`);
  const where = [...(entryConds?.length ? entryConds.map((q) => `customer_id IN (${q})`) : hasActive ? ['is_active = 1'] : []), ...never];
  const base = `SELECT customer_id FROM customers${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`;
  const earlier: string[] = [];
  const notes: string[] = [];
  const add: Record<string, unknown>[] = [];
  let blocked: string | null = null;
  for (const b of [...c.buckets].sort((x, y) => x.priority - y.priority)) {
    const conds = rulesSql(b.rule as Group[], signals);
    if (conds && !blocked) {
      const where = [...conds.map((q) => `customer_id IN (${q})`), ...earlier.map((q) => `customer_id NOT IN (${q})`)].join(' AND ');
      const sql = `SELECT customer_id FROM (${base}) WHERE ${where}`;
      if (views[b.id]?.sql !== sql) {
        try {
          const n = countCustomers(bank, sql);
          add.push({ kind: 'sizing', bucketId: b.id, topic: 'size', text: `Sized by the app from the bucket's rule (first match wins).`, source: 'data', data: { sql, size: n } });
        } catch (e) {
          notes.push(`Bucket "${b.name}": could not be sized (${(e as Error).message}).`);
        }
      }
      earlier.push(sql);
      continue;
    }
    const own = views[b.id]?.sql;
    if (own) earlier.push(own);
    else {
      notes.push(`Bucket "${b.name}" isn't sized: its rule isn't written in signals. Rewrite it in signals (list_signals), or ask_data with sizeBucket "${b.id}".`);
      blocked ??= b.name;
    }
  }
  if (blocked) notes.push(`Buckets after "${blocked}" can't be sized exactly until it is (first match wins).`);
  if (!add.length) return { state, notes };
  return { state: addContext(state, add, 'app').state, notes };
}
