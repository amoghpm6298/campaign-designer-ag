// Offers: the bank's offer menu, managed by its ops team. The designer only
// ever picks a live offer from here, by its reference, and the line the
// customer reads comes from here too. So a change here reaches every campaign,
// and pausing an offer takes it off the menu at once. Every save is checked
// by the server (server/incentives.ts checkIncentive).
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiUrl } from './api';
import { fmtDate } from './time';
import type { Tenant } from './types';
import './links.css';
import './offers.css';

type CostType = 'flat' | 'pctOfSpend' | 'interest' | 'cardFee';
type Action = 'spend' | 'first_spend' | 'emi_conversion';
interface Cond {
  attribute?: string;
  operator?: string;
  value?: string;
}
export interface Offer {
  id: string;
  label: string;
  size: 'small' | 'big';
  mechanic: string;
  trigger: { action: Action; minAmount?: number; withinDays: number; category?: string };
  costType: CostType;
  cost: { perRedemption?: number; ratePct?: number; capPerCustomer?: number; interestDiscountPctPa?: number; feeByCardType?: Record<string, number> };
  maxCostPerCustomer: number;
  requires: Cond[];
  eligibility: Cond[];
  unmatchedCriteria: string[];
  validFrom: string;
  validTo: string;
  terms: string;
  offerLine: string;
  status: 'live' | 'paused' | 'draft';
  mock?: boolean;
  updatedAt?: string;
}
interface SignalInfo {
  key: string;
  label: string;
  type: string;
  values?: string[];
  operators: string[];
}

const ACTION: Record<Action, string> = { spend: 'Spend', first_spend: 'Make a first spend', emi_conversion: 'Convert a purchase to EMI' };
const COST: Record<CostType, string> = { flat: 'A fixed amount', pctOfSpend: 'A share of spend', interest: 'An interest discount', cardFee: 'A card fee waived' };
const STATUS: Record<Offer['status'], string> = { live: 'Live', paused: 'Paused', draft: 'Draft' };
const inr = (n: number | undefined) => (n == null || !Number.isFinite(n) ? '—' : `₹${Math.round(n).toLocaleString('en-IN')}`);
const today = () => new Date().toISOString().slice(0, 10);

const blank = (): Offer => ({
  id: '',
  label: '',
  size: 'small',
  mechanic: '',
  trigger: { action: 'spend', withinDays: 30 },
  costType: 'flat',
  cost: { perRedemption: 100 },
  maxCostPerCustomer: 0,
  requires: [],
  eligibility: [],
  unmatchedCriteria: [],
  validFrom: today(),
  validTo: today(),
  terms: '',
  offerLine: '',
  status: 'live',
});

/** A draft from the describe step as a form value: what was said is filled, what wasn't stays empty (never a made-up default). */
function fromDraft(d: Partial<Offer> | null): Offer {
  const b = blank();
  if (!d) return b;
  return {
    ...b,
    ...d,
    trigger: { ...b.trigger, ...(d.trigger ?? {}) } as Offer['trigger'],
    cost: d.cost ?? {},
    costType: d.costType ?? b.costType,
    size: d.size ?? b.size,
    validFrom: d.validFrom ?? '',
    validTo: d.validTo ?? '',
    requires: d.requires ?? [],
    eligibility: d.eligibility ?? [],
    unmatchedCriteria: d.unmatchedCriteria ?? [],
    status: 'live',
  };
}

async function getJson<T>(path: string): Promise<T | null> {
  const res = await fetch(apiUrl(path));
  return res.ok ? ((await res.json()) as T) : null;
}
async function post(path: string, body: unknown): Promise<{ ok: boolean; error?: string; problems?: string[] }> {
  const res = await fetch(apiUrl(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json().catch(() => ({ ok: false, error: `Request failed (${res.status})` }))) as { ok: boolean; error?: string; problems?: string[] };
}

/** What the customer must do, in a sentence. */
const doText = (o: Offer) =>
  `${ACTION[o.trigger.action]}${o.trigger.minAmount ? ` ${inr(o.trigger.minAmount)} or more` : ''}${o.trigger.category ? ` on ${o.trigger.category}` : ''} within ${o.trigger.withinDays} days`;

/** What it costs the bank, in a sentence. */
function costText(o: Offer): string {
  const c = o.cost;
  if (o.costType === 'flat') return `${inr(c.perRedemption)} per customer who earns it`;
  if (o.costType === 'pctOfSpend') return `${c.ratePct}% of spend, capped at ${inr(c.capPerCustomer)} a customer`;
  if (o.costType === 'interest') return `${c.interestDiscountPctPa} points a year of interest, at most ${inr(o.maxCostPerCustomer)} a customer`;
  return `The annual fee: ${Object.entries(c.feeByCardType ?? {}).map(([k, v]) => `${k} ${inr(v)}`).join(', ')}`;
}

export function OffersView({ tenant }: { tenant: Tenant | null }) {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [signals, setSignals] = useState<SignalInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ offer: Offer; isNew: boolean } | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [describing, setDescribing] = useState(false);
  const tenantId = tenant?.tenantId ?? '';

  const reload = async () => {
    if (!tenantId) return;
    const r = await getJson<{ incentives?: Offer[] }>(`/api/incentives?tenantId=${encodeURIComponent(tenantId)}`).catch(() => null);
    setOffers(r?.incentives ?? []);
    setLoading(false);
  };
  useEffect(() => {
    setLoading(true);
    setEditing(null);
    reload();
    getJson<{ signals?: SignalInfo[] }>(`/api/signals?tenantId=${encodeURIComponent(tenantId)}`)
      .then((r) => setSignals(r?.signals ?? []))
      .catch(() => setSignals([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const sigLabel = useMemo(() => new Map(signals.map((s) => [s.key, s.label])), [signals]);
  const condText = (c: Cond) => {
    const name = sigLabel.get(c.attribute ?? '') ?? c.attribute;
    if (c.operator === 'Is') return `${name}: ${c.value === 'true' ? 'yes' : 'no'}`;
    return `${name} ${String(c.operator ?? '').toLowerCase()} ${String(c.value ?? '').replace(/,/g, c.operator === 'Between' ? ' and ' : ', ')}`;
  };

  if (!tenant) return null;
  const order: Offer['status'][] = ['live', 'draft', 'paused'];
  const sorted = [...offers].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status) || a.maxCostPerCustomer - b.maxCostPerCustomer);

  const open = (offer: Offer, isNew: boolean) => {
    setDescribing(false);
    setProblems([]);
    setEditing({ offer: structuredClone(offer), isNew });
  };
  const save = async () => {
    if (!editing) return;
    setSaving(true);
    const r = await post('/api/incentives', { tenantId, incentive: editing.offer });
    setSaving(false);
    if (!r.ok) return setProblems(r.problems ?? [r.error ?? 'Not saved.']);
    setEditing(null);
    reload();
  };
  const setStatus = async (id: string, status: Offer['status']) => {
    const r = await post('/api/incentives/status', { tenantId, id, status });
    if (r.ok) reload();
  };

  return (
    <div className="cd-page">
      <div className="cd-page-head">
        <div>
          <h1>Offers</h1>
          <p className="cd-lede">
            The offers {tenant.displayName}'s campaigns can use, and what each costs the bank. The designer only picks a live offer from this list, and
            the line a customer reads comes from here. A change here reaches every campaign.
          </p>
        </div>
        {tenant.incentiveMenu && (
          <button
            className="cd-btn primary"
            onClick={() => {
              setEditing(null);
              setDescribing(true);
            }}
          >
            Add offer
          </button>
        )}
      </div>

      {!tenant.incentiveMenu && <div className="of-empty">{tenant.displayName} has no offer menu. Its campaigns persuade with messages only.</div>}

      {describing && (
        <DescribeOffer
          tenantId={tenantId}
          onCancel={() => setDescribing(false)}
          onForm={(draft) => open(fromDraft(draft), true)}
        />
      )}

      {editing && (
        <OfferForm
          key={editing.isNew ? 'new' : editing.offer.id}
          draft={editing.offer}
          isNew={editing.isNew}
          signals={signals}
          problems={problems}
          saving={saving}
          onChange={(offer) => setEditing((e) => (e ? { ...e, offer } : e))}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      )}

      {tenant.incentiveMenu && loading && <div className="of-empty">Loading offers…</div>}
      {tenant.incentiveMenu && !loading && !offers.length && <div className="of-empty">No offers yet. Without offers, campaigns persuade with messages only.</div>}

      <div className="of-list">
        {sorted.map((o) => (
          <article key={o.id} className={`of-card ${o.status}`}>
            <header className="of-head">
              <div className="of-title">
                <b>{o.label}</b>
                <code>{o.id}</code>
                {o.status !== 'live' && <span className="of-state">{STATUS[o.status]}</span>}
              </div>
              <div className="of-act">
                <button onClick={() => open(o, false)}>Edit</button>
                {o.status === 'paused' ? <button onClick={() => setStatus(o.id, 'live')}>Resume</button> : <button className="warn" onClick={() => setStatus(o.id, 'paused')}>Pause</button>}
              </div>
            </header>
            <p className="of-line">“{o.offerLine}”</p>
            <dl className="of-facts">
              <div>
                <dt>Customer gets</dt>
                <dd>{o.mechanic}</dd>
              </div>
              <div>
                <dt>To earn it</dt>
                <dd>{doText(o)}</dd>
              </div>
              <div>
                <dt>Cost to the bank</dt>
                <dd>
                  <span>
                    {costText(o)}
                    {o.costType === 'cardFee' && <span className="of-muted"> · at most {inr(o.maxCostPerCustomer)} a customer</span>}
                  </span>
                </dd>
              </div>
              <div>
                <dt>Valid</dt>
                <dd>
                  {fmtDate(o.validFrom)} to {fmtDate(o.validTo)}
                </dd>
              </div>
              <div>
                <dt>Who can get it</dt>
                <dd>
                  {!o.requires.length && !o.eligibility.length && !o.unmatchedCriteria.length && 'Any cardholder'}
                  {o.requires.map((c, i) => (
                    <span key={`r${i}`} className="of-cond">
                      Must have: {condText(c)}
                    </span>
                  ))}
                  {o.eligibility.map((c, i) => (
                    <span key={`e${i}`} className="of-cond">
                      Meant for: {condText(c)}
                    </span>
                  ))}
                  {o.unmatchedCriteria.map((t, i) => (
                    <span key={`u${i}`} className="of-cond">
                      Checked when issued: {t}
                    </span>
                  ))}
                </dd>
              </div>
            </dl>
            <details className="of-terms">
              <summary>Full terms</summary>
              <p>{o.terms}</p>
            </details>
            {o.updatedAt && <div className="of-when">Changed {fmtDate(o.updatedAt)}</div>}
          </article>
        ))}
      </div>
    </div>
  );
}

function CondRows({ title, hint, rows, signals, onChange }: { title: string; hint: string; rows: Cond[]; signals: SignalInfo[]; onChange: (rows: Cond[]) => void }) {
  const set = (i: number, patch: Cond) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="of-conds wide">
      <span className="of-label">{title}</span>
      <span className="kl-hint">{hint}</span>
      {rows.map((r, i) => {
        const s = signals.find((x) => x.key === r.attribute);
        return (
          <div key={i} className="of-cond-row">
            <select aria-label="Signal" value={r.attribute ?? ''} onChange={(e) => set(i, { attribute: e.target.value, operator: signals.find((x) => x.key === e.target.value)?.operators[0], value: '' })}>
              <option value="">Choose a signal</option>
              {signals.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.label}
                </option>
              ))}
            </select>
            <select aria-label="Operator" value={r.operator ?? ''} onChange={(e) => set(i, { operator: e.target.value })}>
              {(s?.operators ?? []).map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
            {s?.type === 'bool' ? (
              <select aria-label="Value" value={r.value ?? ''} onChange={(e) => set(i, { value: e.target.value })}>
                <option value="">Choose</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            ) : (
              <input aria-label="Value" value={r.value ?? ''} list={s?.values?.length ? `of-v-${s.key}` : undefined} placeholder={r.operator === 'Between' ? 'min,max' : 'Value'} onChange={(e) => set(i, { value: e.target.value })} />
            )}
            {s?.values?.length ? (
              <datalist id={`of-v-${s.key}`}>
                {s.values.map((v) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            ) : null}
            <button className="of-x" aria-label="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
        );
      })}
      <button className="of-add" onClick={() => onChange([...rows, { attribute: '', operator: '', value: '' }])}>
        + Add a rule
      </button>
    </div>
  );
}

function OfferForm(props: {
  draft: Offer;
  isNew: boolean;
  signals: SignalInfo[];
  problems: string[];
  saving: boolean;
  onChange: (o: Offer) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { draft: o, isNew, signals, problems, saving, onChange, onCancel, onSave } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);
  const set = (patch: Partial<Offer>) => onChange({ ...o, ...patch });
  const setCost = (patch: Offer['cost']) => onChange({ ...o, cost: { ...o.cost, ...patch } });
  const n = (v: string) => (v === '' ? (undefined as unknown as number) : Number(v));
  const fees = Object.entries(o.cost.feeByCardType ?? {});
  const setFees = (rows: [string, number][]) => setCost({ feeByCardType: Object.fromEntries(rows) });

  return (
    <div ref={ref} className="kl-form of-form">
      <div className="kl-grid">
        <label>
          Name
          <input value={o.label} placeholder="₹100 cashback on first spend" onChange={(e) => set({ label: e.target.value })} />
        </label>
        <label>
          Reference
          <input value={o.id} disabled={!isNew} placeholder="cashback_first_spend_100" onChange={(e) => set({ id: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
          <span className="kl-hint">{isNew ? 'Lower-case, set once. Campaigns refer to the offer by this.' : 'Set when the offer was created; it never changes.'}</span>
        </label>
        <label className="wide">
          What the customer gets
          <input value={o.mechanic} placeholder="₹100 cashback on a first spend after a gap." onChange={(e) => set({ mechanic: e.target.value })} />
        </label>
        <label className="wide">
          The line the customer reads
          <input value={o.offerLine} placeholder="Get ₹100 cashback on your first spend of ₹1,000+ within 14 days. T&Cs apply." onChange={(e) => set({ offerLine: e.target.value })} />
          <span className="kl-hint">Added to every message that carries this offer, word for word. {o.offerLine.length}/160 characters.</span>
        </label>
        <label className="wide">
          Full terms
          <textarea rows={3} value={o.terms} onChange={(e) => set({ terms: e.target.value })} />
        </label>

        <div className="of-group wide">To earn it</div>
        <label>
          The customer must
          <select value={o.trigger.action} onChange={(e) => set({ trigger: { ...o.trigger, action: e.target.value as Action } })}>
            {(Object.keys(ACTION) as Action[]).map((a) => (
              <option key={a} value={a}>
                {ACTION[a]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Within (days)
          <input type="number" min={1} max={365} value={o.trigger.withinDays ?? ''} onChange={(e) => set({ trigger: { ...o.trigger, withinDays: n(e.target.value) } })} />
        </label>
        <label>
          Minimum amount (₹, optional)
          <input type="number" min={0} value={o.trigger.minAmount ?? ''} onChange={(e) => set({ trigger: { ...o.trigger, minAmount: n(e.target.value) } })} />
        </label>
        <label>
          Category (optional)
          <input value={o.trigger.category ?? ''} placeholder="electronics" onChange={(e) => set({ trigger: { ...o.trigger, category: e.target.value } })} />
        </label>

        <div className="of-group wide">Cost to the bank</div>
        <label>
          Size
          <select value={o.size} onChange={(e) => set({ size: e.target.value as Offer['size'] })}>
            <option value="small">Small offer</option>
            <option value="big">Big offer</option>
          </select>
          <span className="kl-hint">The designer tries small offers before big ones.</span>
        </label>
        <label>
          How it costs the bank
          <select value={o.costType} onChange={(e) => set({ costType: e.target.value as CostType, cost: {} })}>
            {(Object.keys(COST) as CostType[]).map((c) => (
              <option key={c} value={c}>
                {COST[c]}
              </option>
            ))}
          </select>
        </label>
        {o.costType === 'flat' && (
          <label>
            Cost per customer who earns it (₹)
            <input type="number" min={0} value={o.cost.perRedemption ?? ''} onChange={(e) => setCost({ perRedemption: n(e.target.value) })} />
          </label>
        )}
        {o.costType === 'pctOfSpend' && (
          <>
            <label>
              Cost as % of spend
              <input type="number" min={0} step="0.01" value={o.cost.ratePct ?? ''} onChange={(e) => setCost({ ratePct: n(e.target.value) })} />
            </label>
            <label>
              Cap per customer (₹)
              <input type="number" min={0} value={o.cost.capPerCustomer ?? ''} onChange={(e) => setCost({ capPerCustomer: n(e.target.value) })} />
            </label>
          </>
        )}
        {o.costType === 'interest' && (
          <>
            <label>
              Interest given up (points a year)
              <input type="number" min={0} step="0.5" value={o.cost.interestDiscountPctPa ?? ''} onChange={(e) => setCost({ interestDiscountPctPa: n(e.target.value) })} />
            </label>
            <label>
              Most it can cost per customer (₹)
              <input type="number" min={0} value={o.maxCostPerCustomer || ''} onChange={(e) => set({ maxCostPerCustomer: n(e.target.value) })} />
            </label>
          </>
        )}
        {o.costType === 'cardFee' && (
          <div className="of-conds wide">
            <span className="of-label">Annual fee by card type (₹)</span>
            {fees.map(([k, v], i) => (
              <div key={i} className="of-cond-row two">
                <input aria-label="Card type" value={k} placeholder="Card type" onChange={(e) => setFees(fees.map((f, j) => (j === i ? [e.target.value, f[1]] : f)))} />
                <input aria-label="Fee" type="number" min={0} value={Number.isFinite(v) ? v : ''} onChange={(e) => setFees(fees.map((f, j) => (j === i ? [f[0], n(e.target.value)] : f)))} />
                <button className="of-x" aria-label="Remove" onClick={() => setFees(fees.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            ))}
            <button className="of-add" onClick={() => setFees([...fees, ['', 0]])}>
              + Add a card type
            </button>
          </div>
        )}

        <div className="of-group wide">Dates</div>
        <label>
          Valid from
          <input type="date" value={o.validFrom} onChange={(e) => set({ validFrom: e.target.value })} />
        </label>
        <label>
          Valid to
          <input type="date" value={o.validTo} onChange={(e) => set({ validTo: e.target.value })} />
        </label>

        <div className="of-group wide">Who can get it</div>
        <CondRows title="Must have" hint="Set by the bank's product rules, e.g. EMI eligible. A campaign never grants these." rows={o.requires} signals={signals} onChange={(requires) => set({ requires })} />
        <CondRows title="Meant for" hint="Who the offer is aimed at, beyond the product rules." rows={o.eligibility} signals={signals} onChange={(eligibility) => set({ eligibility })} />
        <label className="wide">
          Checked when the offer is issued (one per line)
          <textarea
            rows={2}
            value={o.unmatchedCriteria.join('\n')}
            placeholder="Not given a fee waiver in the last 12 months"
            onChange={(e) => set({ unmatchedCriteria: e.target.value.split('\n') })}
          />
          <span className="kl-hint">Rules no signal can express. They only narrow who qualifies.</span>
        </label>
        <label>
          Status
          <select value={o.status} onChange={(e) => set({ status: e.target.value as Offer['status'] })}>
            <option value="live">Live: the designer can use it</option>
            <option value="draft">Draft: not offered yet</option>
            <option value="paused">Paused: not offered</option>
          </select>
        </label>
      </div>
      {problems.length > 0 && (
        <ul className="kl-error of-problems">
          {problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      )}
      <div className="kl-actions">
        <button className="cd-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="cd-btn primary" disabled={saving} onClick={onSave}>
          {saving ? 'Saving…' : 'Save offer'}
        </button>
      </div>
    </div>
  );
}

interface Turn {
  role: 'ops' | 'designer';
  text: string;
}

/**
 * Add an offer by describing it. The designer drafts the fields and asks for
 * whatever is missing until the draft passes the same checks as a save; then
 * the filled form opens for review. Ops can switch to the form at any point.
 */
function DescribeOffer({ tenantId, onCancel, onForm }: { tenantId: string; onCancel: () => void; onForm: (draft: Partial<Offer> | null) => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState<Partial<Offer> | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);

  const send = async () => {
    const said = text.trim();
    if (!said || busy) return;
    const next = [...turns, { role: 'ops' as const, text: said }];
    setTurns(next);
    setText('');
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/incentives/draft'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId, turns: next, current: draft }) });
      const r = (await res.json().catch(() => ({}))) as { draft?: Partial<Offer>; question?: string | null; done?: boolean; error?: string };
      if (!res.ok || !r.draft) throw new Error(r.error ?? 'Could not draft the offer. Try again.');
      setDraft(r.draft);
      if (r.done) return onForm(r.draft);
      setTurns([...next, { role: 'designer', text: r.question ?? 'Tell me a little more about the offer.' }]);
    } catch (e) {
      setError((e as Error).message);
      setTurns(turns);
      setText(said);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={ref} className="kl-form of-describe">
      <div className="of-label">Describe the offer</div>
      <span className="kl-hint">
        In your own words: what the customer gets, what they must do and by when, what it costs the bank, and the dates. The designer fills
        in the form and asks for anything missing.
      </span>
      {turns.length > 0 && (
        <div className="of-convo">
          {turns.map((t, i) => (
            <div key={i} className={`of-msg ${t.role}`}>
              {t.text}
            </div>
          ))}
        </div>
      )}
      {busy && <div className="of-msg designer busy">Drafting the offer…</div>}
      <textarea
        aria-label={turns.length ? 'Your answer' : 'Describe the offer'}
        rows={turns.length ? 2 : 4}
        value={text}
        disabled={busy}
        placeholder={turns.length ? 'Your answer' : 'e.g. ₹250 cashback when a customer spends ₹5,000 on dining within 21 days. Costs us ₹250 each. Runs December to February.'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
        }}
      />
      {error && <div className="kl-error">{error}</div>}
      <div className="kl-actions">
        <button className="cd-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="cd-btn" onClick={() => onForm(draft)} disabled={busy}>
          {draft ? 'Fill the rest in the form' : 'Use the form instead'}
        </button>
        <button className="cd-btn primary" onClick={send} disabled={busy || !text.trim()}>
          {busy ? 'Drafting…' : turns.length ? 'Send' : 'Draft the offer'}
        </button>
      </div>
    </div>
  );
}
