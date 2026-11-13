// The edit popover beside a focused box: where it sits, a direct control for
// clear-cut numbers (saved instantly, no agent), suggestion chips, and a text
// box whose request goes to the agent pointed at this box.
import { useState } from 'react';
import { ArrowUp, Loader2, X } from 'lucide-react';
import { OUTCOME_LABEL, fmtWait, sendTitle, waitHours, type CStep } from './canvasModel';
import type { CdNodeData } from './canvasNodes';
import type { AfterOutcome, CampaignObject } from './types';

export type DirectOp =
  | { op: 'membership'; type: 'locked' | 'open'; refresh?: 'daily' | 'weekly' | 'monthly' }
  | { op: 'holdout'; bucketId: string; pct: number }
  | { op: 'split'; bucketId: string; stepId: string; pcts: number[] }
  | { op: 'wait'; bucketId: string; stepId: string; days: number }
  | { op: 'afterJourney'; outcome: AfterOutcome; value: number | 'leave' }
  | { op: 'maxAttempts'; value: number };

const rejoinIn = (d: number) => (d === 0 ? 'Can rejoin at the next refresh' : `Can rejoin in ${d} day${d === 1 ? '' : 's'}`);
const AFTER_CHOICES: [string, string][] = [['leave', 'Leaves the campaign'], ...[0, 7, 14, 30, 60, 90].map((d): [string, string] => [String(d), rejoinIn(d)])];

const CHIPS: Record<string, string[]> = {
  send: ['Change the channel', 'Rewrite the message', 'Change the timing', 'Remove this message'],
  experiment: ['Change the split', 'Stop the test, keep the better version'],
  branch: ['Change what we react to', 'Remove this check'],
  condition: ['Change this check', 'Remove this check'],
  wait: ['Make it shorter', 'Remove this wait'],
  waitForEvent: ['Change what we wait for', 'Wait longer'],
  bucket: ["Change who's in it", 'Remove this bucket', 'Redesign its journey'],
  holdout: ['Change the holdout', 'Remove the holdout'],
  entry: ['Change who can join', 'Change the goal'],
  everyone: ['Give them a journey', 'Send them nothing'],
  goalcheck: ['Change the goal'],
  exit: ['Add a last message before this'],
};

/** "Bucket 2 · Fresh issuance › A/B test" — where the box sits, in words. */
export function breadcrumb(data: CdNodeData, campaign: CampaignObject | null): string {
  const st = (data.step ?? {}) as CStep;
  const buckets = [...(campaign?.buckets ?? [])].sort((a, b) => a.priority - b.priority);
  const bi = buckets.findIndex((b) => b.id === data.lane);
  const lane = data.lane === 'everyone_else' ? 'Everyone else' : bi >= 0 ? `Bucket ${bi + 1} · ${buckets[bi].name}` : '';
  const what: Record<string, string> = {
    entry: 'Entry · who can join',
    bucket: 'The bucket',
    everyone: '',
    holdout: 'Holdout',
    goalcheck: 'Goal check',
    send: `Message · ${sendTitle({ ...st, name: st.name || st.label })}`,
    wait: fmtWait(waitHours(st)),
    waitForEvent: 'Wait for event',
    branch: st.label ? `Branch · ${st.label}` : 'Branch',
    experiment: st.label ? `A/B test · ${st.label}` : 'A/B test',
    condition: st.label ? `Check · ${st.label}` : 'Check',
    exit: data.text || 'Exit',
  };
  return [lane, what[data.kind]].filter(Boolean).join(' › ');
}

export function EditPopover({
  data,
  campaign,
  busy,
  onClose,
  onSend,
  onDirect,
}: {
  data: CdNodeData;
  campaign: CampaignObject | null;
  busy: boolean;
  onClose: () => void;
  onSend: (text: string) => void;
  onDirect: (op: DirectOp) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const st = (data.step ?? {}) as CStep & { arms?: { label?: string; pct?: number }[] };
  const bucket = campaign?.buckets.find((b) => b.id === data.lane);
  const m = campaign?.membership;

  const direct = async (op: DirectOp) => {
    setSaving(true);
    setMsg(null);
    const r = await onDirect(op);
    setSaving(false);
    setMsg(r.ok ? { ok: true, text: 'Saved · rebuilt' } : { ok: false, text: r.error ?? 'Not saved' });
  };

  const [pcts, setPcts] = useState<number[]>(() => (st.arms ?? []).map((a) => Number(a.pct) || 0));
  const [holdout, setHoldout] = useState<number>(bucket?.holdoutPct ?? 0);
  const [days, setDays] = useState<number>(() => Math.round(((waitHours(st) ?? 24) / 24) * 10) / 10);
  const total = pcts.reduce((a, b) => a + b, 0);

  let control: React.ReactNode = null;
  if (data.kind === 'entry') {
    const cur = !m ? '' : m.type === 'locked' ? 'once' : (m.refresh ?? 'weekly');
    control = (
      <div className="cv-pop-control">
        <span className="cv-pop-label">How new customers come in</span>
        <div className="cv-seg">
          {(
            [
              ['once', 'One-time'],
              ['daily', 'Daily'],
              ['weekly', 'Weekly'],
              ['monthly', 'Monthly'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              className={cur === k ? 'on' : ''}
              disabled={saving}
              onClick={() => direct(k === 'once' ? { op: 'membership', type: 'locked' } : { op: 'membership', type: 'open', refresh: k })}
            >
              {label}
            </button>
          ))}
        </div>
        {m?.type === 'open' && (
          <>
            <span className="cv-pop-label" style={{ marginTop: 10 }}>Stopping rule</span>
            <label className="cv-pop-after">
              <span>Most times through</span>
              <select value={campaign?.maxAttempts ? String(campaign.maxAttempts) : ''} disabled={saving} onChange={(e) => e.target.value && direct({ op: 'maxAttempts', value: Number(e.target.value) })}>
                {!campaign?.maxAttempts && <option value="">Not set</option>}
                {[1, 2, 3, 4, 5].map((n) => (
                  <option key={n} value={n}>
                    {n === 1 ? 'Once, then leaves' : `${n} times, then leaves`}
                  </option>
                ))}
              </select>
            </label>
            <span className="cv-pop-label" style={{ marginTop: 10 }}>After the journey</span>
            {(['no_response', 'not_reachable', 'declined', 'converted'] as const).map((k) => {
              const v = campaign?.afterJourney?.[k];
              const val = v === undefined ? '' : String(v);
              const choices = val && !AFTER_CHOICES.some(([c]) => c === val) ? [...AFTER_CHOICES, [val, rejoinIn(Number(val))] as [string, string]] : AFTER_CHOICES;
              return (
                <label key={k} className="cv-pop-after">
                  <span>{OUTCOME_LABEL[k]}</span>
                  <select value={val} disabled={saving} onChange={(e) => e.target.value && direct({ op: 'afterJourney', outcome: k, value: e.target.value === 'leave' ? 'leave' : Number(e.target.value) })}>
                    {!val && <option value="">Not decided</option>}
                    {choices.map(([c, l]) => (
                      <option key={c} value={c}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })}
            <span className="cv-pop-hint">Opted out (STOP, unsubscribe): never comes back. Fixed.</span>
          </>
        )}
      </div>
    );
  } else if ((data.kind === 'bucket' || data.kind === 'holdout') && bucket) {
    control = (
      <div className="cv-pop-control">
        <span className="cv-pop-label">Held back to measure (no messages)</span>
        <div className="cv-pop-row">
          <input type="number" min={0} max={30} value={holdout} onChange={(e) => setHoldout(Number(e.target.value))} /> %
          <button className="cv-pop-save" disabled={saving || holdout === (bucket.holdoutPct ?? 0)} onClick={() => direct({ op: 'holdout', bucketId: bucket.id, pct: holdout })}>
            Save
          </button>
        </div>
      </div>
    );
  } else if (data.kind === 'experiment' && st.id) {
    control = (
      <div className="cv-pop-control">
        <span className="cv-pop-label">Split</span>
        <div className="cv-pop-row wrap">
          {(st.arms ?? []).map((a, i) => (
            <label key={i} className="cv-pop-arm">
              {a.label}
              <input type="number" min={1} max={99} value={pcts[i]} onChange={(e) => setPcts(pcts.map((x, j) => (j === i ? Number(e.target.value) : x)))} /> %
            </label>
          ))}
          <button className="cv-pop-save" disabled={saving || total !== 100} onClick={() => direct({ op: 'split', bucketId: data.lane, stepId: st.id!, pcts })}>
            Save
          </button>
        </div>
        {total !== 100 && <span className="cv-pop-warn">Adds up to {total}%. It must total 100%.</span>}
      </div>
    );
  } else if (data.kind === 'wait' && st.id) {
    control = (
      <div className="cv-pop-control">
        <span className="cv-pop-label">Wait</span>
        <div className="cv-pop-row">
          <input type="number" min={0.5} max={60} step={0.5} value={days} onChange={(e) => setDays(Number(e.target.value))} /> days
          <button className="cv-pop-save" disabled={saving} onClick={() => direct({ op: 'wait', bucketId: data.lane, stepId: st.id!, days })}>
            Save
          </button>
        </div>
      </div>
    );
  }

  const send = () => {
    if (!text.trim() || busy) return;
    onSend(text.trim());
    setText('');
  };

  return (
    <div className="cv-pop" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <header>
        <div>
          <b>Change this</b>
          <span className="cv-pop-crumb">{breadcrumb(data, campaign)}</span>
        </div>
        <button className="cv-icon-btn" onClick={onClose} aria-label="Close">
          <X size={15} />
        </button>
      </header>
      <div className="cv-pop-compose">
        <textarea
          autoFocus
          rows={4}
          placeholder="Describe the change. Anything that has to change because of it will be updated too."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="cv-pop-send" disabled={busy || !text.trim()} onClick={send}>
          {busy ? (
            <>
              <Loader2 size={15} className="v2-spin" /> Working on it…
            </>
          ) : (
            <>
              Send <ArrowUp size={15} />
            </>
          )}
        </button>
      </div>
      {control && (
        <div className="cv-pop-section">
          <span className="cv-pop-head">Quick change</span>
          {control}
          {msg && <div className={`cv-pop-msg ${msg.ok ? 'ok' : 'err'}`}>{saving ? <Loader2 size={12} className="v2-spin" /> : null}{msg.text}</div>}
        </div>
      )}
      {(CHIPS[data.kind] ?? []).length > 0 && (
        <div className="cv-pop-section">
          <span className="cv-pop-head">Suggested changes</span>
          <div className="cv-pop-chips">
            {(CHIPS[data.kind] ?? []).map((c) => (
              <button key={c} className={`v2-opt sugg${text === c ? ' on' : ''}`} onClick={() => setText(c)}>
                {c}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
