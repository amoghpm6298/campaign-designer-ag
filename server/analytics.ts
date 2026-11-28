// A flow's or campaign's analytics: written by the designer (set_analytics), run by
// the app. The designer chooses what to measure (a KPI and 2-6 charts, each with the
// question it answers and its SQL); code makes that safe the way it does bucket sizing:
// every query is read-only, resolved within the scope (only the scoped logos' cards and
// their holders), must return its chart type's columns, and is refused with the reason
// when it doesn't. Results are cached beside the campaign (analytics.json) and rerun
// when the spec, the scope or the data changes. Nothing executes yet, so these are the
// baseline: the bank's data as of its last day.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadStores, sessionFolder } from './campaignFiles';
import { resolveTenant } from './tenants';
import { checkReadOnly, runWarehouseQuery, warehouseAvailable, warehouseSchema } from './warehouse';
import { resolveSignalSql } from './signals';
import { holdersSql, scopeContext, type Scope } from './logos';

export type ChartType = 'line' | 'bar' | 'funnel' | 'number';
export interface ChartSpec {
  id: string;
  title: string;
  question: string;
  type: ChartType;
  sql: string;
  unit?: '%' | 'count' | '₹';
  bucketId?: string;
  why?: string;
}
export interface AnalyticsSpec {
  kpi: ChartSpec & { definition?: string; target?: number | null };
  charts: ChartSpec[];
}
export interface ChartResult {
  rows: Record<string, unknown>[];
  error?: string;
}

/** The columns each chart type must return, and how many rows it may have. */
const SHAPE: Record<ChartType, { cols: string[]; max: number }> = {
  line: { cols: ['week', 'value'], max: 26 },
  bar: { cols: ['label', 'value'], max: 20 },
  funnel: { cols: ['step', 'count'], max: 10 },
  number: { cols: ['value'], max: 1 },
};
const UNITS = ['%', 'count', '₹'];
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Checks the shape of what the designer sent (before anything runs). */
export function parseAnalytics(input: unknown): { value: AnalyticsSpec } | { error: string } {
  const o = (input ?? {}) as { kpi?: Record<string, unknown>; charts?: unknown };
  const chart = (c: Record<string, unknown> | undefined, i: number, isKpi = false): ChartSpec | string => {
    if (!c) return isKpi ? 'kpi is required' : `chart ${i + 1} is empty`;
    const type = (isKpi ? 'line' : str(c.type)) as ChartType;
    if (!SHAPE[type]) return `chart "${str(c.title) || i + 1}": type must be line, bar, funnel or number`;
    for (const k of ['title', 'question', 'sql']) if (!str(c[k]) && !(isKpi && k === 'question')) return `${isKpi ? 'kpi' : `chart "${str(c.title) || i + 1}"`} needs ${k}`;
    const unit = str(c.unit);
    return {
      id: isKpi ? 'kpi' : str(c.id) || `c${i + 1}`,
      title: str(c.title),
      question: str(c.question) || str(c.definition),
      type,
      sql: str(c.sql),
      ...(UNITS.includes(unit) ? { unit: unit as ChartSpec['unit'] } : {}),
      ...(str(c.bucketId) ? { bucketId: str(c.bucketId) } : {}),
      ...(str(c.why) ? { why: str(c.why) } : {}),
    };
  };
  const kpi = chart(o.kpi, 0, true);
  if (typeof kpi === 'string') return { error: kpi };
  const raw = Array.isArray(o.charts) ? (o.charts as Record<string, unknown>[]) : [];
  if (raw.length < 1 || raw.length > 6) return { error: `charts: give 1 to 6 (you gave ${raw.length}).` };
  const charts: ChartSpec[] = [];
  for (const [i, c] of raw.entries()) {
    const r = chart(c, i);
    if (typeof r === 'string') return { error: r };
    if (charts.some((x) => x.id === r.id)) r.id = `${r.id}-${i + 1}`;
    charts.push(r);
  }
  const k = o.kpi as Record<string, unknown>;
  const target = k.target == null || k.target === '' ? null : Number(k.target);
  return { value: { kpi: { ...kpi, ...(str(k.definition) ? { definition: str(k.definition) } : {}), target: Number.isFinite(target) ? target : null }, charts } };
}

/** The designer's SQL with the app's placeholders filled in for the scope. */
export function resolveAnalyticsSql(sql: string, scope: Scope | null | undefined): string {
  return resolveSignalSql(sql.replaceAll('{{SCOPE}}', `(${holdersSql(scope)})`), scopeContext(scope));
}

/** Runs one chart's query: read-only, within the scope, and the right columns for its type. */
export function runChart(bank: string, c: ChartSpec, scope: Scope | null | undefined): ChartResult {
  const ro = checkReadOnly(c.sql);
  if (ro) return { rows: [], error: `"${c.title}": ${ro}` };
  const shape = SHAPE[c.type];
  try {
    const r = runWarehouseQuery(bank, resolveAnalyticsSql(c.sql, scope));
    const missing = shape.cols.filter((x) => !r.columns.includes(x));
    if (missing.length) return { rows: [], error: `"${c.title}" returned columns ${r.columns.join(', ') || 'none'}; a ${c.type} needs ${shape.cols.join(', ')}.` };
    if (r.rows.length > shape.max) return { rows: [], error: `"${c.title}" returned ${r.rows.length} rows; a ${c.type} shows at most ${shape.max}.` };
    const rows = r.rows.map((row) => Object.fromEntries(shape.cols.map((k) => [k, row[k]])));
    // A line reads left to right in time, whatever order the query gave: oldest week first, the latest last (and labelled).
    if (c.type === 'line') rows.sort((a, b) => String(a.week).localeCompare(String(b.week)));
    return { rows };
  } catch (e) {
    return { rows: [], error: `"${c.title}": the query failed (${(e as Error).message.split('\n')[0]}).` };
  }
}

export interface AnalyticsView {
  spec: AnalyticsSpec | null;
  results: Record<string, ChartResult>;
  ranAt?: string;
  dataAsOf?: string | null;
  error?: string;
}

/** The analytics for the Analytics tab: the spec and its results, from the cache unless something changed (or `force`). */
export function analyticsFor(sessionId: string, tenantId: string, force = false): AnalyticsView {
  const c = loadStores(sessionId).campaign;
  const spec = (c?.analytics as AnalyticsSpec | undefined) ?? null;
  if (!spec) return { spec: null, results: {} };
  const bank = resolveTenant(tenantId)?.warehouse?.bank;
  if (!bank || !warehouseAvailable(bank)) return { spec, results: {}, error: "This bank's data isn't connected, so there is nothing to run." };
  const dataAsOf = warehouseSchema(bank).dataAsOf;
  const key = createHash('sha1').update(JSON.stringify([spec, c?.scope ?? null, dataAsOf])).digest('hex');
  const file = join(sessionFolder(sessionId), 'analytics.json');
  if (!force && existsSync(file)) {
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as AnalyticsView & { key?: string };
      if (cached.key === key) return { spec, results: cached.results, ranAt: cached.ranAt, dataAsOf };
    } catch {
      /* rerun */
    }
  }
  const results: Record<string, ChartResult> = {};
  for (const ch of [spec.kpi, ...spec.charts]) results[ch.id] = runChart(bank, ch, c?.scope);
  const ranAt = new Date().toISOString();
  writeFileSync(file, JSON.stringify({ key, results, ranAt }, null, 1));
  return { spec, results, ranAt, dataAsOf };
}
