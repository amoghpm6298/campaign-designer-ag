// What the campaign's offers may cost, with the working behind every rupee.
// All numbers come from the server's cost calculator (code, never the AI).
// The manager can override the designer's estimates and the budget cap here;
// those are direct edits, worked out again with no agent involved.
import { useState } from 'react';
import { X } from 'lucide-react';
import type { CostLineView, CostReportView } from './api';
import type { DirectOp } from './EditPopover';

const inr = (n: number | null | undefined) => (n == null ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);
const pc = (f: number | undefined) => (f == null ? '—' : `${Math.round(f * 1000) / 10}%`);

/** "If it underperforms ₹30,000 · As expected ₹90,000 · If it outperforms (max) ₹10,00,000". */
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

function EstimateEditor({ label, est, onSave, disabled }: { label: string; est: CostLineView['reach']; onSave: (expected: number, few: number) => Promise<void>; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [ex, setEx] = useState(est ? Math.round(est.expected * 100) : 0);
  const [fw, setFw] = useState(est ? Math.round(est.few * 100) : 0);
  const [busy, setBusy] = useState(false);
  return (
    <tr>
      <td>{label}</td>
      <td>
        {open ? (
          <span className="cv-est-edit">
            <label>
              As expected <input type="number" min={0} max={100} value={ex} onChange={(e) => setEx(Number(e.target.value))} />%
            </label>
            <label>
              If it underperforms <input type="number" min={0} max={100} value={fw} onChange={(e) => setFw(Number(e.target.value))} />%
            </label>
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
        ) : (
          <>
            {pc(est?.expected)} <span className="cv-muted">(underperforms {pc(est?.few)})</span>
            {!disabled && (
              <button className="cv-link-btn" onClick={() => setOpen(true)}>
                ✎ change
              </button>
            )}
          </>
        )}
      </td>
      <td>
        <span className={`cv-src ${est?.why === 'Set by the manager.' ? 'you' : 'ai'}`}>{est?.why === 'Set by the manager.' ? 'You set it' : 'AI estimate'}</span>
        {est?.why && est.why !== 'Set by the manager.' && <div className="cv-muted">{est.why}</div>}
      </td>
    </tr>
  );
}

export function CostPanel({ report, focusBucket, locked, onDirect, onClose }: { report: CostReportView; focusBucket?: string | null; locked: boolean; onDirect: (op: DirectOp) => Promise<{ ok: boolean; error?: string }>; onClose: () => void }) {
  const [cap, setCap] = useState(report.budgetCap != null ? String(report.budgetCap) : '');
  const [msg, setMsg] = useState<string | null>(null);
  const unit = report.mode === 'perThousand' ? 'per 1,000 customers (no data access)' : undefined;
  const buckets = focusBucket ? report.buckets.filter((b) => b.bucketId === focusBucket) : report.buckets;
  const run = async (op: DirectOp) => {
    setMsg(null);
    const r = await onDirect(op);
    setMsg(r.ok ? 'Saved · cost worked out again' : r.error ?? 'Not saved');
  };
  return (
    <aside className="cv-drawer cv-cost" aria-label="Potential spend">
      <header>
        <div>
          <div className="cv-drawer-kicker">Offers · worked out by code from the data and the designer's estimates</div>
          <b>Potential spend</b>
        </div>
        <button className="cv-icon-btn" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </header>
      <div className="cv-cost-body">
        <section className="cv-cost-total">
          <div className="cv-cost-h">Whole campaign</div>
          <SpendSummary under={report.total.under} expected={report.total.expected} max={report.total.max} unit={unit} />
          <div className="cv-cost-cap">
            Budget cap:{' '}
            {locked ? (
              <b>{report.budgetCap != null ? inr(report.budgetCap) : 'none'}</b>
            ) : (
              <>
                ₹<input type="number" min={0} placeholder="none" value={cap} onChange={(e) => setCap(e.target.value)} />
                <button className="cv-btn" onClick={() => run({ op: 'budgetCap', value: cap.trim() ? Number(cap) : null })}>
                  Save cap
                </button>
              </>
            )}
            {report.budgetCap != null && report.total.max > report.budgetCap && <span className="cv-muted"> · the cap stops offers once {inr(report.budgetCap)} is spent</span>}
            {report.budgetCap != null && report.total.expected > report.budgetCap && <div className="cv-cost-warn">As expected is over the cap: ask the designer to cut offers to fit.</div>}
          </div>
          {msg && <div className="cv-muted">{msg}</div>}
          {report.notes.map((n) => (
            <div key={n} className="cv-muted">
              {n}
            </div>
          ))}
        </section>
        {buckets.map((b) => (
          <section key={b.bucketId} className="cv-cost-bucket">
            <div className="cv-cost-h">{b.name}</div>
            <SpendSummary under={b.under} expected={b.expected} max={b.max} compact unit={unit} />
            {report.lines
              .filter((l) => l.bucketId === b.bucketId)
              .map((l) => (
                <div key={`${l.stepId}-${l.incentiveId}`} className="cv-cost-line">
                  <div className="cv-cost-offer">
                    🎁 {l.incentiveLabel} <span className="cv-muted">· on "{l.step}" · confidence {l.confidence}</span>
                  </div>
                  <table className="cv-cost-table">
                    <tbody>
                      <tr>
                        <td>Customers</td>
                        <td>
                          {l.customers?.toLocaleString('en-IN') ?? 'not sized'}
                          {l.qualified != null && l.customers != null && l.qualified !== l.customers ? <span className="cv-muted"> · {l.qualified.toLocaleString('en-IN')} qualify</span> : null}
                        </td>
                        <td>
                          <span className="cv-src data">{report.mode === 'perThousand' ? 'Per 1,000' : 'Data'}</span>
                        </td>
                      </tr>
                      <EstimateEditor label="Reach the offer" est={l.reach} disabled={locked || !l.stepId} onSave={(e, f) => run({ op: 'costAssumption', bucketId: l.bucketId, stepId: l.stepId, which: 'reach', expected: e, few: f })} />
                      <EstimateEditor label="Take it up" est={l.redeem} disabled={locked || !l.stepId} onSave={(e, f) => run({ op: 'costAssumption', bucketId: l.bucketId, stepId: l.stepId, which: 'redeem', expected: e, few: f })} />
                      <tr>
                        <td>Average reward</td>
                        <td>{inr(l.avgReward)}</td>
                        <td>
                          <span className="cv-src menu">{/^data/.test(l.avgRewardSource) ? 'Data + menu' : 'Menu'}</span>
                          <div className="cv-muted">{l.avgRewardSource}</div>
                        </td>
                      </tr>
                      <tr>
                        <td>Most per customer</td>
                        <td>{inr(l.maxPerCustomer)}</td>
                        <td>
                          <span className="cv-src menu">Menu</span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                  <div className="cv-eq">
                    <div>
                      <i>If it underperforms</i> {l.equations.under}
                    </div>
                    <div>
                      <i>As expected</i> {l.equations.expected}
                    </div>
                    <div>
                      <i>If it outperforms (max)</i> {l.equations.max}
                    </div>
                  </div>
                </div>
              ))}
          </section>
        ))}
        <p className="cv-muted cv-drawer-hint">To change an offer or who gets it, ask in the chat. Estimates and the cap can be changed here.</p>
      </div>
    </aside>
  );
}
