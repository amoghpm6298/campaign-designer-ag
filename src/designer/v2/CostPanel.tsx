// The estimated cost of the campaign, offer by offer, each with the funnel of
// people that leads to it: every step from the top of the bucket down to
// taking the offer up, each labelled with where its number comes from (the
// bank's delivery rate, the designer's estimate, or worked out). All numbers
// come from the server's cost calculator (code, never the AI). The manager can
// change the designer's estimates on an offer message and the spending cap
// here; those are direct edits, worked out again with no agent involved.
import { useState } from 'react';
import { Gift } from 'lucide-react';
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
  const stages: (FunnelStepView & { left?: number | null; openedNote?: string })[] = [];
  // Only the message carrying the offer narrows the funnel step by step (you must receive and open
  // it to take the offer up). On every earlier message, people it doesn't reach and people who don't
  // open it carry on in the journey too: so an earlier message is one stage, "sent" to everyone who
  // arrived, with how many it reached and how many opened it as a note.
  const offerMsg = steps.map((s) => s.name).findLastIndex((n) => n.endsWith('” delivered'));
  const pct = (n: number | null | undefined, of: number | null | undefined) => (n == null || !of ? null : `${Math.round((1000 * n) / of) / 10}%`);
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    if (i < offerMsg && st.name.endsWith('” delivered')) {
      const arrived = stages[stages.length - 1]?.count ?? null;
      const opened = steps[i + 1]?.name === 'Opened it' ? steps[i + 1] : null;
      const notes = [pct(st.count, arrived) && `${pct(st.count, arrived)} delivered`, opened && pct(opened.count, st.count) && `${pct(opened.count, st.count)} opened it`].filter(Boolean);
      stages.push({ ...st, name: st.name.replace(/ delivered$/, ' sent'), count: arrived, source: 'code', openedNote: notes.join(' · ') || undefined });
      if (opened) i++;
      continue;
    }
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
  // Each stage's headline: the share of the people at the stage before (the first stage is everyone).
  const ofPrev = (i: number) => {
    const n = stages[i].count;
    const p = i === 0 ? n : stages[i - 1].count;
    if (n == null || p == null) return '—';
    if (!p) return '0%';
    return `${Math.round((1000 * n) / p) / 10}%`;
  };
  const chars = Math.max(12, Math.floor(col / 7.4));
  return (
    <div className="cf-funnel-wrap">
      <svg className="cf-funnel" viewBox={`0 0 ${W} ${top + band + 88}`} style={stages.length > 8 ? { minWidth: `${Math.round(W * 0.9)}px` } : undefined} role="img" aria-label={stages.map((st) => `${st.name}: ${num(st.count)}`).join(', ')}>
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
                {ofPrev(i)}
              </text>
              <text x={x0 + 8} y={top + band + 44} className="cf-stage-n">
                {st.count == null ? '—' : `${num(st.count)} ${st.count === 1 ? 'person' : 'people'}`}
              </text>
              {st.left != null && st.left > 0 && (
                <text x={x0 + 8} y={top + band + 64} className="cf-stage-left">
                  {num(st.left)} converted, left
                </text>
              )}
              {st.openedNote?.split(' · ').map((ln, k) => (
                <text key={k} x={x0 + 8} y={top + band + 64 + k * 16} className="cf-stage-left">
                  {ln}
                </text>
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** One of the designer's estimates, with its reasoning. Changed by asking in the chat, not here. */
function EstimateLine({ label, help, est }: { label: string; help: string; est: { rate: number; why: string } | null }) {
  const mine = est?.why === 'Set by the manager.';
  return (
    <div className="cf-est">
      <div className="cf-est-h">
        <b>{label}</b> {est ? pc(est.rate) : 'no estimate yet'} <span className="cv-muted">{help}</span>
      </div>
      {est?.why && <div className="cv-muted">{mine ? 'You set this.' : withCites(est.why)}</div>}
    </div>
  );
}

function OfferFunnel({ l }: { l: CostLineView }) {
  const sms = !l.opens && !l.steps.slice(-3).some((s) => s.name === 'Opened it');
  return (
    <article className="cf-offer">
      <header className="cf-offer-h">
        <div>
          <b className="cf-offer-name">
            <Gift size={16} aria-hidden="true" /> {l.incentiveLabel}
          </b>
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
        {!sms && <EstimateLine label="Nudge open" help="of those it’s delivered to" est={l.opens} />}
        <EstimateLine label="Offer participation" help={sms ? 'of those who receive it' : 'of those who open it'} est={l.converts} />
        <div className="cf-est">
          <div className="cf-est-h">
            <b>Cost per participant</b> {inr(l.avgReward)} on average, at most {inr(l.maxPerCustomer)}
          </div>
          <div className="cv-muted">{l.avgRewardSource === 'incentive menu (flat)' ? 'A fixed amount, set by the offer.' : l.avgRewardSource.replace(/^data: /, "From the bank's data: ").replace(/^no data: /, 'No data to work it out, so ')}</div>
        </div>
        <div className="cv-muted">Each step shows the share of people from the step before, and how many people that is. Hover a step to see where its number comes from.</div>
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
        <OfferFunnel key={`${l.bucketId}-${l.stepId}-${l.incentiveId}`} l={l} />
      ))}
      <p className="cv-muted cv-drawer-hint">To change an offer, a message or who gets it, ask in the chat. Estimates on offer messages and the cap can be changed here.</p>
    </FullPageModal>
  );
}
