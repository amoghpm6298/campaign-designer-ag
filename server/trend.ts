// The 90-day trend of a flow's or campaign's target, for the entry card.
// The same sizing queries the app uses today (agent/autoSize.ts sizingPlan) are
// built as of each of the last 13 weeks: every signal is worked out as if that
// week were "today" (signals.ts resolveSignalSql), within the scope.
//   - a campaign: how many people were in the target each week (the size of the cohort);
//   - a flow: how many people newly entered the target each week (its weekly inflow).
// A bucket sized by its own saved query can't be replayed for a past week: it is
// used as it is today, and the trend says which buckets those are ("partial").
import { createHash } from 'node:crypto';
import { loadStores } from './campaignFiles';
import { resolveTenant } from './tenants';
import { runWarehouseQuery, warehouseAvailable, warehouseSchema } from './warehouse';
import { sizingPlan } from './agent/autoSize';
import { bucketContext } from '../src/designer/v2/contextView';
import { kindOf } from '../src/designer/v2/kind';

export interface TrendPoint {
  /** The week's last day, YYYY-MM-DD. */
  week: string;
  count: number;
}

export interface Trend {
  /** cohort: people in the target that week · inflow: people who newly entered it that week. */
  measure: 'cohort' | 'inflow';
  points: TrendPoint[];
  /** Buckets whose own query can't be replayed for past weeks (used as they are today). */
  partial: string[];
  dataAsOf: string;
}

const WEEKS = 13;
const cache = new Map<string, Trend>();
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

export function cohortTrend(sessionId: string, tenantId: string): Trend | { error: string } {
  const tenant = resolveTenant(tenantId);
  const bank = tenant?.warehouse?.bank;
  if (!bank || !warehouseAvailable(bank)) return { error: 'This bank has no data connected, so there is no trend.' };
  const c = loadStores(sessionId).campaign;
  if (!c?.buckets.length) return { error: 'Nothing designed yet.' };
  const views = bucketContext(loadStores(sessionId).context?.entries ?? []);
  const key = createHash('sha1').update(JSON.stringify([sessionId, c.scope, c.entry, c.everyoneElse?.approach, c.buckets.map((b) => [b.id, b.priority, b.rule]), Object.fromEntries(Object.entries(views).map(([k, v]) => [k, v.sql ?? null]))])).digest('hex');
  const hit = cache.get(key);
  if (hit) return hit;
  const asOf = warehouseSchema(bank).dataAsOf ?? new Date().toISOString().slice(0, 10);
  const measure = kindOf(c) === 'flow' ? 'inflow' : 'cohort';
  const targetAt = (day: string) => sizingPlan(c, tenant, views, day)?.target ?? null;
  const first = sizingPlan(c, tenant, views, asOf);
  if (!first?.target) return { error: first?.blocked ? `Bucket "${first.blocked}" isn't sized yet, so there is no total to follow.` : 'Nothing to count yet.' };
  const partial = first.buckets.filter((b) => b.own).map((b) => b.name);
  const points: TrendPoint[] = [];
  try {
    for (let k = WEEKS - 1; k >= 0; k--) {
      const day = addDays(asOf, -7 * k);
      const now = targetAt(day)!;
      const sql =
        measure === 'cohort'
          ? `SELECT COUNT(*) AS n FROM (${now})`
          : `SELECT COUNT(*) AS n FROM (${now}) WHERE customer_id NOT IN (${targetAt(addDays(day, -7))!})`;
      points.push({ week: day, count: Number(runWarehouseQuery(bank, sql).rows[0]?.n ?? 0) });
    }
  } catch (e) {
    return { error: `The trend could not be worked out (${(e as Error).message}).` };
  }
  const out: Trend = { measure, points, partial, dataAsOf: asOf };
  cache.set(key, out);
  return out;
}
