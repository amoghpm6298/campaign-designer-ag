// The Analytics tab of a flow or campaign: what the designer chose to measure
// (its KPI and charts, each with the question it answers and the SQL behind it),
// run by the app on the bank's data within the scope. Before launch these are
// the baseline: what the target looks like today and over the last 90 days.
// The designer writes the spec (set_analytics); code checks, runs and caches it
// (server/analytics.ts). Charts follow the dataviz rules: one hue, thin marks,
// a labelled latest value, hover for every point, and a table view.
import { useEffect, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { apiUrl } from '../api';

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
export interface ChartResult {
  rows: Record<string, unknown>[];
  error?: string;
}
export interface AnalyticsView {
  spec: { kpi: ChartSpec & { definition?: string; target?: number | null }; charts: ChartSpec[] } | null;
  results: Record<string, ChartResult>;
  ranAt?: string;
  dataAsOf?: string | null;
  error?: string;
}

export async function fetchAnalytics(sessionId: string, tenantId: string, refresh = false): Promise<AnalyticsView> {
  try {
    const res = await fetch(apiUrl(`/api/campaign/analytics?${new URLSearchParams({ sessionId, tenantId, ...(refresh ? { refresh: '1' } : {}) })}`));
    return (await res.json()) as AnalyticsView;
  } catch {
    return { spec: null, results: {}, error: 'Could not reach the server.' };
  }
}

const fmt = (v: unknown, unit?: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v ?? '');
  if (unit === '%') return `${Math.round(n * 10) / 10}%`;
  if (unit === '₹') return `₹${Math.round(n).toLocaleString('en-IN')}`;
  return Math.round(n).toLocaleString('en-IN');
};
const wk = (iso: unknown) => {
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
};

export function AnalyticsPanel({ sessionId, tenantId, kind, busy, onAsk }: { sessionId: string; tenantId: string; kind: 'flow' | 'campaign'; busy: boolean; onAsk: () => void }) {
  const [data, setData] = useState<AnalyticsView | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    let live = true;
    setData(null);
    fetchAnalytics(sessionId, tenantId).then((d) => live && setData(d));
    return () => {
      live = false;
    };
    // Re-read after the designer finishes a turn (it may have rewritten the analytics).
  }, [sessionId, tenantId, busy]);
  const refresh = async () => {
    setRefreshing(true);
    setData(await fetchAnalytics(sessionId, tenantId, true));
    setRefreshing(false);
  };
  if (!data) return <div className="an-empty">Working out the numbers…</div>;
  if (data.error && !data.spec) return <div className="an-empty">{data.error}</div>;
  if (!data.spec)
    return (
      <div className="an-empty">
        <b>No analytics yet</b>
        <p>The designer writes them when it builds this {kind}: the KPI and the charts that show whether its bet is working.</p>
        <button className="cv-btn primary" disabled={busy} onClick={onAsk}>
          <Sparkles size={14} /> Ask the designer for analytics
        </button>
      </div>
    );
  const { kpi, charts } = data.spec;
  return (
    <div className="an">
      <div className="an-head">
        <span className="an-badge" title="Nothing runs yet: these are worked out from the bank's data as it is today.">
          Baseline: before launch
        </span>
        <span className="an-asof">{data.dataAsOf ? `Bank data up to ${wk(data.dataAsOf)}` : ''}</span>
        <button className="cv-btn an-refresh" onClick={refresh} disabled={refreshing}>
          <RefreshCw size={13} /> {refreshing ? 'Running…' : 'Refresh'}
        </button>
      </div>
      <KpiTile spec={kpi} res={data.results[kpi.id]} />
      <div className="an-grid">
        {charts.map((c) => (
          <ChartCard key={c.id} spec={c} res={data.results[c.id]} />
        ))}
      </div>
    </div>
  );
}

function KpiTile({ spec, res }: { spec: ChartSpec & { definition?: string; target?: number | null }; res?: ChartResult }) {
  const rows = res?.rows ?? [];
  const last = rows[rows.length - 1];
  return (
    <section className="an-kpi">
      <div className="an-kpi-text">
        <span className="an-kpi-h">Key result</span>
        <b className="an-kpi-title">{spec.title}</b>
        {spec.definition && <p className="an-kpi-def">{spec.definition}</p>}
        {res?.error ? (
          <p className="an-err">{res.error}</p>
        ) : (
          <div className="an-kpi-num">
            <b>{last ? fmt(last.value, spec.unit) : '—'}</b>
            <span>latest week{last ? ` (to ${wk(last.week)})` : ''}</span>
            {spec.target != null && <span className="an-target">Target {fmt(spec.target, spec.unit)}</span>}
          </div>
        )}
      </div>
      {!res?.error && rows.length > 1 && <LineChart rows={rows} unit={spec.unit} target={spec.target ?? null} big />}
      <Behind spec={spec} />
    </section>
  );
}

function ChartCard({ spec, res }: { spec: ChartSpec; res?: ChartResult }) {
  const [table, setTable] = useState(false);
  const rows = res?.rows ?? [];
  return (
    <article className="an-card">
      <header>
        <b>{spec.title}</b>
        <span className="an-q">{spec.question}</span>
      </header>
      {res?.error ? (
        <p className="an-err">{res.error}</p>
      ) : !rows.length ? (
        <p className="an-muted">No data for this yet.</p>
      ) : table ? (
        <DataTable rows={rows} unit={spec.unit} />
      ) : spec.type === 'line' ? (
        <LineChart rows={rows} unit={spec.unit} />
      ) : spec.type === 'number' ? (
        <div className="an-number">{fmt(rows[0]?.value, spec.unit)}</div>
      ) : (
        <BarChart rows={rows} unit={spec.unit} labelKey={spec.type === 'funnel' ? 'step' : 'label'} valueKey={spec.type === 'funnel' ? 'count' : 'value'} />
      )}
      <footer>
        {!!rows.length && !res?.error && spec.type !== 'number' && (
          <button type="button" className="cv-tool-btn" onClick={() => setTable((v) => !v)}>
            {table ? 'Chart' : 'Table'}
          </button>
        )}
        <Behind spec={spec} />
      </footer>
    </article>
  );
}

/** "Why this chart" and the SQL behind it, both behind small buttons. */
function Behind({ spec }: { spec: ChartSpec }) {
  const [open, setOpen] = useState<'why' | 'sql' | null>(null);
  return (
    <div className="an-behind">
      <span className="an-behind-btns">
        {spec.why && (
          <button type="button" className={`cv-tool-btn${open === 'why' ? ' on' : ''}`} onClick={() => setOpen(open === 'why' ? null : 'why')}>
            Why this chart
          </button>
        )}
        <button type="button" className={`cv-tool-btn${open === 'sql' ? ' on' : ''}`} onClick={() => setOpen(open === 'sql' ? null : 'sql')}>
          SQL
        </button>
      </span>
      {open === 'why' && <p className="an-why">{spec.why}</p>}
      {open === 'sql' && <pre className="cv-sql-code">{spec.sql.trim()}</pre>}
    </div>
  );
}

function DataTable({ rows, unit }: { rows: Record<string, unknown>[]; unit?: string }) {
  const cols = Object.keys(rows[0] ?? {});
  return (
    <div className="cv-sql-table">
      <table>
        <thead>
          <tr>{cols.map((c) => <th key={c}>{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>{cols.map((c) => <td key={c}>{c === 'value' || c === 'count' ? fmt(r[c], unit) : String(r[c] ?? '')}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One line over weeks: the latest value labelled, every week on hover, an optional target as a dashed line. */
function LineChart({ rows, unit, target = null, big = false }: { rows: Record<string, unknown>[]; unit?: string; target?: number | null; big?: boolean }) {
  const W = big ? 420 : 320;
  const H = big ? 120 : 110;
  const pad = { l: 8, r: 48, t: 12, b: 20 };
  const vals = rows.map((r) => Number(r.value) || 0);
  const max = Math.max(...vals, target ?? 0, 1);
  const min = Math.min(...vals, target ?? Infinity, 0);
  const x = (i: number) => pad.l + (i * (W - pad.l - pad.r)) / Math.max(1, rows.length - 1);
  const y = (v: number) => pad.t + (1 - (v - min) / Math.max(1e-9, max - min)) * (H - pad.t - pad.b);
  const d = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const step = (W - pad.l - pad.r) / Math.max(1, rows.length - 1);
  return (
    <svg className="an-line" width="100%" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Weekly values, latest ${fmt(vals[vals.length - 1], unit)}`}>
      <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} className="an-axis" />
      {target != null && <line x1={pad.l} x2={W - pad.r} y1={y(target)} y2={y(target)} className="an-target-line" />}
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(vals.length - 1)} cy={y(vals[vals.length - 1])} r="3.5" fill="currentColor" stroke="var(--surface, #fff)" strokeWidth="2" />
      <text x={x(vals.length - 1) + 7} y={y(vals[vals.length - 1]) + 4} className="an-label">
        {fmt(vals[vals.length - 1], unit)}
      </text>
      <text x={pad.l} y={H - 4} className="an-tick">{wk(rows[0].week)}</text>
      <text x={W - pad.r} y={H - 4} className="an-tick" textAnchor="end">{wk(rows[rows.length - 1].week)}</text>
      {rows.map((r, i) => (
        <rect key={i} x={x(i) - step / 2} y={0} width={step} height={H} fill="transparent">
          <title>{`Week to ${wk(r.week)}: ${fmt(r.value, unit)}`}</title>
        </rect>
      ))}
    </svg>
  );
}

/** Horizontal bars (a funnel is bars in step order): labels in text colour, values beside each bar. */
function BarChart({ rows, unit, labelKey, valueKey }: { rows: Record<string, unknown>[]; unit?: string; labelKey: string; valueKey: string }) {
  const vals = rows.map((r) => Number(r[valueKey]) || 0);
  const max = Math.max(...vals, 1);
  return (
    <div className="an-bars" role="list">
      {rows.map((r, i) => (
        <div key={i} className="an-bar-row" role="listitem" title={`${String(r[labelKey] ?? '')}: ${fmt(vals[i], unit)}`}>
          <span className="an-bar-label">{String(r[labelKey] ?? '')}</span>
          <span className="an-bar-track">
            <span className="an-bar" style={{ width: `${Math.max(2, (100 * vals[i]) / max)}%` }} />
          </span>
          <span className="an-bar-val">{fmt(vals[i], unit)}</span>
        </div>
      ))}
    </div>
  );
}
