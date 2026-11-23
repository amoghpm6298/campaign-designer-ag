// The estimated cost of the campaign, offer by offer, as funnels of people:
// from everyone in the bucket down to those who take the offer up, in three
// versions (underperforms, as expected, outperforms). Every number comes from
// the server's cost calculator (code, never the AI); the funnel counts are
// derived from the same figures, so they always add up to the cost shown.
// The manager can change the designer's estimates and the budget cap here;
// those are direct edits, worked out again with no agent involved.
import { useState } from 'react';
import type { CostLineView, CostReportView } from './api';
import type { DirectOp } from './EditPopover';
import { FullPageModal } from './FullPageModal';
import { withCites } from './Citations';

const inr = (n: number | null | undefined) => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);
const num = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString('en-IN'));
const pc = (f: number | undefined) => (f == null ? '—' : `${Math.round(f * 1000) / 10}%`);

/** "If it underperforms ₹30,000 · As expected ₹90,000 · If it outperforms (max) ₹10,00,000". Used on the bucket cards. */
export function SpendSummary({ under, expected, max, unit, compact }: { under: number; expected: number; max: number; unit?: string; compact?: boolean }) {
  return (
    <span className={`cv-spend${compact ? ' compact' : ''}`}>
      <span>
        <i>{compact ? 'Under' : 'If it underperforms'}</i> {inr(under)}
      </span>
      <span>
        <i>As expected</i> <b>{inr(expected)}</b>
      </span>
      <span className="max">
        <i>{compact ? 'Max' : 'If it outperforms (max)'}</i> {inr(max)}
      </span>
      {unit && <em>{unit}</em>}
    </span>
  );
}

type Version = 'under' | 'expected' | 'max';
const VERSIONS: { key: Version; label: string }[] = [
  { key: 'under', label: 'If it underperforms' },
  { key: 'expected', label: 'As expected' },
  { key: 'max', label: 'If it outperforms' },
];

interface Funnel {
  bucket: number | null;
  qualify: number | null;
  reach: number | null;
  takeUp: number | null;
  cost: number | null;
}

/**
 * One version of an offer's funnel: who qualifies × reach × take-up, as the cost calculator counts it
 * (so the steps match the cost shown).
 * Outperforms is the most it can cost: everyone who qualifies takes it up, at the most per customer.
 */
function funnelOf(l: CostLineView, v: Version, perThousand: boolean): Funnel {
  const bucket = perThousand ? 1000 : l.customers;
  const qualify = perThousand ? 1000 : (l.qualified ?? l.customers);
  if (v === 'max') return { bucket, qualify, reach: qualify, takeUp: qualify, cost: l.max };
  const k = v === 'under' ? 'few' : 'expected';
  const cost = v === 'under' ? l.under : l.expected;
  const r = l.reach?.[k];
  const d = l.redeem?.[k];
  if (cost == null || r == null || d == null || qualify == null) return { bucket, qualify, reach: null, takeUp: null, cost: null };
  // A later message with the same offer only counts those who haven't taken it yet. That share isn't sent
  // to the browser, so it is read back from the cost; within rounding of the average reward it is 1.
  const full = qualify * r * d * l.avgReward;
  const left = full > 0 ? Math.min(1, cost / full) : 1;
  const share = left > 0.97 ? 1 : left;
  const reach = qualify * share * r;
  return { bucket, qualify, reach, takeUp: reach * d, cost };
}

/** A data source in words a manager reads: "data: …" → "From the bank's data: …". */
const plainSource = (s: string) =>
  s === 'incentive menu (flat)' ? 'A fixed amount, set by the offer.' : s.replace(/^data: /, "From the bank's data: ").replace(/^no data: /, 'No data to work it out, so ');

/**
 * A left-to-right funnel (one shape that narrows stage by stage), in one hue getting lighter.
 * Each stage is labelled directly: its name above, its share of the bucket and its count below.
 */
function FunnelChart({ f }: { f: Funnel }) {
  const stages: { name: string; n: number }[] = [
    { name: 'In the bucket', n: f.bucket ?? 0 },
    ...(f.qualify != null && f.qualify !== f.bucket ? [{ name: 'Qualify for the offer', n: f.qualify }] : []),
    { name: 'Reach this message', n: f.reach ?? 0 },
    { name: 'Take the offer up', n: f.takeUp ?? 0 },
  ];
  const base = stages[0].n || 1;
  const W = 1000;
  const top = 34;
  const band = 150;
  const cy = top + band / 2;
  const col = W / stages.length;
  const h = (n: number) => Math.max(4, (band * Math.min(n, base)) / base);
  const share = (n: number) => `${Math.round((1000 * n) / base) / 10}%`;
  const fade = [1, 0.8, 0.62, 0.46, 0.34];
  return (
    <svg className="cf-funnel" viewBox={`0 0 ${W} ${top + band + 58}`} role="img" aria-label={stages.map((st) => `${st.name}: ${num(st.n)}`).join(', ')}>
      {stages.map((st, i) => {
        const x0 = i * col;
        const x1 = (i + 1) * col - (i < stages.length - 1 ? 2 : 0);
        const a = h(st.n);
        const b = i < stages.length - 1 ? h(stages[i + 1].n) : a;
        return (
          <g key={st.name} className="cf-stage">
            <title>{`${st.name}: ${num(st.n)} people, ${share(st.n)} of the bucket`}</title>
            <polygon points={`${x0},${cy - a / 2} ${x1},${cy - b / 2} ${x1},${cy + b / 2} ${x0},${cy + a / 2}`} fill="var(--accent, #1d4ed8)" fillOpacity={fade[i] ?? 0.3} />
            <text x={x0 + 10} y={18} className="cf-stage-name">
              {st.name}
            </text>
            <text x={x0 + 10} y={top + band + 26} className="cf-stage-pct">
              {share(st.n)}
            </text>
            <text x={x0 + 10} y={top + band + 48} className="cf-stage-n">
              {num(st.n)} people
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function EstimateLine({ label, est, onSave, disabled }: { label: string; est: CostLineView['reach']; onSave: (expected: number, few: number) => Promise<void>; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [ex, setEx] = useState(est ? Math.round(est.expected * 100) : 0);
  const [fw, setFw] = useState(est ? Math.round(est.few * 100) : 0);
  const [busy, setBusy] = useState(false);
  const mine = est?.why === 'Set by the manager.';
  return (
    <div className="cf-est">
      <div className="cf-est-h">
        <b>{label}</b> {pc(est?.expected)} as expected, {pc(est?.few)} if it underperforms
        <span className="cf-est-src">{mine ? 'You set it' : 'The designer’s estimate'}</span>
        {!disabled && !open && (
          <button className="cv-link-btn" onClick={() => setOpen(true)}>
            Change
          </button>
        )}
      </div>
      {!mine && est?.why && <div className="cv-muted">{withCites(est.why)}</div>}
      {open && (
        <span className="cv-est-edit">
          <label>
            As expected <input type="number" min={0} max={100} value={ex} onChange={(e) => setEx(Number(e.target.value))} />%
          </label>
          <label>
            If it underperforms <input type="number" min={0} max={100} value={fw} onChange={(e) => setFw(Number(e.target.value))} />%
          </label>
          <button className="cv-btn" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            className="cv-btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onSave(ex, fw);
              setBusy(false);
              setOpen(false);
            }}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </span>
      )}
    </div>
  );
}

function OfferFunnel({ l, perThousand, locked, run }: { l: CostLineView; perThousand: boolean; locked: boolean; run: (op: DirectOp) => Promise<void> }) {
  const [version, setVersion] = useState<Version>('expected');
  const fs = VERSIONS.map((v) => ({ ...v, f: funnelOf(l, v.key, perThousand) }));
  const shown = fs.find((v) => v.key === version)!;
  return (
    <article className="cf-offer">
      <header className="cf-offer-h">
        <div>
          <b>{l.incentiveLabel}</b>
          <span>
            {l.bucketName}
            {l.route ? ` › ${l.route}` : ''} · in “{l.step}”
          </span>
        </div>
        <div className="cf-switch" role="radiogroup" aria-label="Which version">
          {fs.map((v) => (
            <button key={v.key} role="radio" aria-checked={version === v.key} className={version === v.key ? 'on' : ''} onClick={() => setVersion(v.key)}>
              {v.label}
            </button>
          ))}
        </div>
      </header>
      {shown.f.cost == null ? <div className="cf-none">No estimate yet for this version.</div> : <FunnelChart f={shown.f} />}
      <div className="cf-costs">
        <div className="cf-cost-main">
          <span>Cost, {shown.label.toLowerCase()}</span>
          <b>{inr(shown.f.cost)}</b>
        </div>
        {fs
          .filter((v) => v.key !== version)
          .map((v) => (
            <button key={v.key} className="cf-cost-other" onClick={() => setVersion(v.key)}>
              <span>{v.label}</span>
              <b>{inr(v.f.cost)}</b>
            </button>
          ))}
      </div>
      <div className="cf-ests">
        <EstimateLine label="Reach" est={l.reach} disabled={locked || !l.stepId} onSave={(e, f) => run({ op: 'costAssumption', bucketId: l.bucketId, stepId: l.stepId, which: 'reach', expected: e, few: f })} />
        <EstimateLine label="Take-up" est={l.redeem} disabled={locked || !l.stepId} onSave={(e, f) => run({ op: 'costAssumption', bucketId: l.bucketId, stepId: l.stepId, which: 'redeem', expected: e, few: f })} />
        <div className="cf-est">
          <div className="cf-est-h">
            <b>Cost per person who takes it up</b> {inr(l.avgReward)} on average, at most {inr(l.maxPerCustomer)}
          </div>
          <div className="cv-muted">{plainSource(l.avgRewardSource)}</div>
        </div>
        {l.engineOnly.length > 0 && <div className="cv-muted">The engine also checks: {l.engineOnly.join(' ')} So fewer may qualify than shown.</div>}
      </div>
      <details className="cf-working">
        <summary>How it’s worked out</summary>
        <div>
          <i>If it underperforms:</i> {l.equations.under}
        </div>
        <div>
          <i>As expected:</i> {l.equations.expected}
        </div>
        <div>
          <i>If it outperforms:</i> {l.equations.max}
        </div>
      </details>
    </article>
  );
}

export function CostPanel({ report, focusBucket, locked, onDirect, onClose }: { report: CostReportView; focusBucket?: string | null; locked: boolean; onDirect: (op: DirectOp) => Promise<{ ok: boolean; error?: string }>; onClose: () => void }) {
  const [cap, setCap] = useState(report.budgetCap != null ? String(report.budgetCap) : '');
  const [msg, setMsg] = useState<string | null>(null);
  const [only, setOnly] = useState<string | null>(focusBucket ?? null);
  const perThousand = report.mode === 'perThousand';
  const lines = only ? report.lines.filter((l) => l.bucketId === only) : report.lines;
  const run = async (op: DirectOp) => {
    setMsg(null);
    const r = await onDirect(op);
    setMsg(r.ok ? 'Saved. The cost has been worked out again.' : (r.error ?? 'Not saved.'));
  };
  const t = report.total;
  return (
    <FullPageModal title="Estimated cost of campaign" kicker="What the offers may cost the bank. Worked out by code from the bank's data and the designer's estimates." onClose={onClose} wide>
      <section className="cf-total">
        <div className="cf-total-row">
          <div>
            <span>If it underperforms</span>
            <b>{inr(t.under)}</b>
          </div>
          <div className="lead">
            <span>As expected</span>
            <b>{inr(t.expected)}</b>
          </div>
          <div>
            <span>If it outperforms (the most)</span>
            <b>{inr(t.max)}</b>
          </div>
        </div>
        {perThousand && <div className="cv-muted">This bank has no data access, so these are per 1,000 customers, not totals.</div>}
        <div className="cv-cost-cap">
          Spending cap for offers:{' '}
          {locked ? (
            <b>{report.budgetCap != null ? inr(report.budgetCap) : 'none'}</b>
          ) : (
            <>
              ₹<input type="number" min={0} placeholder="none" value={cap} onChange={(e) => setCap(e.target.value)} aria-label="Spending cap in rupees" />
              <button className="cv-btn" onClick={() => run({ op: 'budgetCap', value: cap.trim() ? Number(cap) : null })}>
                Save cap
              </button>
            </>
          )}
          {report.budgetCap != null && t.max > report.budgetCap && <span className="cv-muted">Offers stop once {inr(report.budgetCap)} is spent.</span>}
          {report.budgetCap != null && t.expected > report.budgetCap && <div className="cv-cost-warn">The expected cost is over the cap. Ask the designer to cut offers to fit.</div>}
        </div>
        {msg && <div className="cv-muted">{msg}</div>}
        {report.lines.length > 1 && <div className="cv-muted">The most the campaign can cost counts each customer once per offer, so it can be less than the offers below added up.</div>}
        {report.notes.map((n) => (
          <div key={n} className="cv-muted">
            {n}
          </div>
        ))}
      </section>
      {only && (
        <div className="cf-filter">
          Showing the offers in {report.buckets.find((b) => b.bucketId === only)?.name ?? 'one bucket'}.{' '}
          <button className="cv-link-btn" onClick={() => setOnly(null)}>
            Show all offers
          </button>
        </div>
      )}
      {lines.map((l) => (
        <OfferFunnel key={`${l.bucketId}-${l.stepId}-${l.incentiveId}`} l={l} perThousand={perThousand} locked={locked} run={run} />
      ))}
      <p className="cv-muted cv-drawer-hint">To change an offer or who gets it, ask in the chat. Estimates and the cap can be changed here.</p>
    </FullPageModal>
  );
}
