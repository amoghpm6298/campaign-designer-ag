// The estimated cost of the campaign, offer by offer, each with the funnel of
// people that leads to it: every step from the top of the bucket down to
// taking the offer up, each labelled with where its number comes from (the
// bank's delivery rate, the designer's estimate, or worked out). All numbers
// come from the server's cost calculator (code, never the AI). The manager can
// change the designer's estimates on an offer message and the spending cap
// here; those are direct edits, worked out again with no agent involved.
import { useState } from 'react';
import type { CostLineView, CostReportView, FunnelStepView } from './api';
import type { DirectOp } from './EditPopover';
import { FullPageModal } from './FullPageModal';
import { withCites } from './Citations';

const inr = (n: number | null | undefined) => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);
const num = (n: number | null | undefined) => (n == null ? '—' : Math.round(n).toLocaleString('en-IN'));
const pc = (f: number | undefined) => (f == null ? '—' : `${Math.round(f * 1000) / 10}%`);

/** "Est. ₹90,000 · Max ₹10,00,000". Used on the bucket cards. */
export function SpendSummary({ expected, max, unit, compact }: { expected: number; max: number; unit?: string; compact?: boolean }) {
  return (
    <span className={`cv-spend${compact ? ' compact' : ''}`}>
      <span>
        <i>{compact ? 'Est.' : 'Estimated'}</i> <b>{inr(expected)}</b>
      </span>
      <span className="max">
        <i>Max</i> {inr(max)}
      </span>
      {unit && <em>{unit}</em>}
    </span>
  );
}

const SOURCE: Record<FunnelStepView['source'], string> = { bank: "Bank's rate", designer: "Designer's estimate", code: 'Worked out' };
/** Short form under each stage, where columns are narrow. */
const SOURCE_SHORT: Record<FunnelStepView['source'], string> = { bank: 'Bank', designer: 'Designer', code: 'Worked out' };

/** Lines of at most `max` characters, at word breaks (at most three). */
function wrap(text: string, max: number): string[] {
  const out: string[] = [];
  let line = '';
  for (const w of text.split(/\s+/)) {
    if (line && (line + ' ' + w).length > max) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.slice(0, 4);
}

/**
 * The funnel, left to right, one stage per step on the way to the offer. People who convert and
 * leave at a goal check are a note on the stage after it, so the shape only ever narrows.
 */
function FunnelChart({ steps }: { steps: FunnelStepView[] }) {
  const stages: (FunnelStepView & { left?: number | null })[] = [];
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (st.name === 'Converted') {
      // Converters leave: a note on the step after. When a path follows the goal check, the path is
      // what this offer's people are (e.g. those who read and didn't buy), so the count of everyone
      // left in the journey is skipped: it includes people on other paths.
      let j = i + 1;
      if (steps[j]?.name === 'Haven’t converted yet' && steps[j + 1]?.name.startsWith('Path:')) j++;
      const next = steps[j];
      if (next) {
        stages.push({ ...next, left: st.count });
        i = j;
      }
      continue;
    }
    stages.push(st);
  }
  const base = stages[0]?.count || 1;
  const COL = 128;
  const W = Math.max(960, COL * stages.length);
  const col = W / stages.length;
  const top = 72;
  const band = 140;
  const cy = top + band / 2;
  const h = (n: number | null) => (n == null ? 4 : Math.max(4, (band * Math.min(n, base)) / base));
  const share = (n: number | null) => (n == null ? '—' : `${Math.round((1000 * n) / base) / 10}%`);
  const chars = Math.max(12, Math.floor(col / 7.4));
  return (
    <div className="cf-funnel-wrap">
      <svg className="cf-funnel" viewBox={`0 0 ${W} ${top + band + 92}`} style={stages.length > 8 ? { minWidth: `${Math.round(W * 0.9)}px` } : undefined} role="img" aria-label={stages.map((st) => `${st.name}: ${num(st.count)}`).join(', ')}>
        {stages.map((st, i) => {
          const x0 = i * col;
          const x1 = (i + 1) * col - (i < stages.length - 1 ? 2 : 0);
          const a = h(st.count);
          const b = i < stages.length - 1 ? h(stages[i + 1].count) : a;
          const fade = 1 - (0.62 * i) / Math.max(1, stages.length - 1);
          return (
            <g key={i} className="cf-stage">
              <title>{`${st.name}: ${num(st.count)} people (${share(st.count)} of the bucket). ${SOURCE[st.source]}${st.rate != null ? ` ${pc(st.rate)}` : ''}${st.why ? `: ${st.why}` : ''}`}</title>
              <polygon points={`${x0},${cy - a / 2} ${x1},${cy - b / 2} ${x1},${cy + b / 2} ${x0},${cy + a / 2}`} fill="var(--accent, #1d4ed8)" fillOpacity={st.count == null ? 0.12 : fade} />
              {wrap(st.name, chars).map((ln, k) => (
                <text key={k} x={x0 + 8} y={14 + k * 15} className="cf-stage-name">
                  {ln}
                </text>
              ))}
              <text x={x0 + 8} y={top + band + 24} className="cf-stage-pct">
                {num(st.count)}
              </text>
              <text x={x0 + 8} y={top + band + 44} className="cf-stage-n">
                {share(st.count)}
              </text>
              <text x={x0 + 8} y={top + band + 64} className={`cf-stage-src ${st.source}`}>
                {SOURCE_SHORT[st.source]}
                {st.rate != null && st.source !== 'code' ? ` · ${pc(st.rate)}` : ''}
              </text>
              {st.left != null && st.left > 0 && (
                <text x={x0 + 8} y={top + band + 84} className="cf-stage-left">
                  {num(st.left)} converted, left
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function EstimateLine({ label, help, est, onSave, disabled }: { label: string; help: string; est: { rate: number; why: string } | null; onSave: (pct: number) => Promise<void>; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(est ? Math.round(est.rate * 1000) / 10 : 0);
  const [busy, setBusy] = useState(false);
  const mine = est?.why === 'Set by the manager.';
  return (
    <div className="cf-est">
      <div className="cf-est-h">
        <b>{label}</b> {est ? pc(est.rate) : 'no estimate yet'} <span className="cv-muted">{help}</span>
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
            {label} <input type="number" min={0} max={100} step="0.5" value={v} onChange={(e) => setV(Number(e.target.value))} />%
          </label>
          <button className="cv-btn" onClick={() => setOpen(false)}>
            Cancel
          </button>
          <button
            className="cv-btn primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onSave(v);
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

function OfferFunnel({ l, locked, run }: { l: CostLineView; locked: boolean; run: (op: DirectOp) => Promise<void> }) {
  const sms = !l.opens && !l.steps.slice(-3).some((s) => s.name === 'Opened it');
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
      </header>
      <FunnelChart steps={l.steps} />
      <div className="cf-costs">
        <div className="cf-cost-main">
          <span>Estimated cost</span>
          <b>{inr(l.expected)}</b>
        </div>
        <div className="cf-cost-other">
          <span>Max, if everyone who qualifies takes it</span>
          <b>{inr(l.max)}</b>
        </div>
      </div>
      {l.expected == null && <div className="cv-cost-warn">{l.equations.expected}</div>}
      <div className="cf-ests">
        {!sms && <EstimateLine label="Opens" help="of those it’s delivered to" est={l.opens} disabled={locked || !l.stepId} onSave={(pct) => run({ op: 'funnelRate', bucketId: l.bucketId, stepId: l.stepId, which: 'opens', pct })} />}
        <EstimateLine label="Takes the offer up" help={sms ? 'of those who receive it' : 'of those who open it'} est={l.converts} disabled={locked || !l.stepId} onSave={(pct) => run({ op: 'funnelRate', bucketId: l.bucketId, stepId: l.stepId, which: 'converts', pct })} />
        <div className="cf-est">
          <div className="cf-est-h">
            <b>Cost per person who takes it up</b> {inr(l.avgReward)} on average, at most {inr(l.maxPerCustomer)}
          </div>
          <div className="cv-muted">{l.avgRewardSource === 'incentive menu (flat)' ? 'A fixed amount, set by the offer.' : l.avgRewardSource.replace(/^data: /, "From the bank's data: ").replace(/^no data: /, 'No data to work it out, so ')}</div>
        </div>
        <div className="cv-muted">Under each step: its share of the bucket, and where its number comes from (Bank: the bank's delivery rate, set in Knowledge Base › Delivery · Designer: the designer's estimate · Worked out: by code). Hover a step to see why.</div>
        {l.engineOnly.length > 0 && <div className="cv-muted">The engine also checks: {l.engineOnly.join(' ')} So fewer may qualify than shown.</div>}
      </div>
      <details className="cf-working">
        <summary>How it’s worked out</summary>
        <div>
          <i>Estimated:</i> {l.equations.expected}
        </div>
        <div>
          <i>Max:</i> {l.equations.max}
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
    setMsg(r.ok ? 'Saved. The funnel and cost have been worked out again.' : (r.error ?? 'Not saved.'));
  };
  const t = report.total;
  return (
    <FullPageModal title="Estimated cost of campaign" kicker="What the offers may cost the bank, worked out by code from the bank's delivery rates, its data and the designer's estimates." onClose={onClose} wide>
      <section className="cf-total">
        <div className="cf-total-row two">
          <div className="lead">
            <span>Estimated cost</span>
            <b>{inr(t.expected)}</b>
          </div>
          <div>
            <span>Max, if everyone who qualifies takes every offer</span>
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
          {report.budgetCap != null && t.expected > report.budgetCap && <div className="cv-cost-warn">The estimated cost is over the cap. Ask the designer to cut offers to fit.</div>}
        </div>
        {msg && <div className="cv-muted">{msg}</div>}
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
        <OfferFunnel key={`${l.bucketId}-${l.stepId}-${l.incentiveId}`} l={l} locked={locked} run={run} />
      ))}
      <p className="cv-muted cv-drawer-hint">To change an offer, a message or who gets it, ask in the chat. Estimates on offer messages and the cap can be changed here.</p>
    </FullPageModal>
  );
}
