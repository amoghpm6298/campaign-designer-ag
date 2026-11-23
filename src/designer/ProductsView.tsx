// Products: what the bank wants to sell (Smart Engage 2.0), next to Offers.
// An offer is a reward on the current card; a product is a different thing to
// sell: a card upgrade, a loan on the card, insurance. Product campaigns
// (intent "Drive product sign-ups") and cross-sells pitch them, with the
// product page from Links. Every save is checked by the server
// (server/products.ts checkProduct).
import { useEffect, useMemo, useRef, useState } from 'react';
import { apiUrl } from './api';
import { fmtDate } from './time';
import { fetchLinks, type BankLink } from './LinksSection';
import type { Tenant } from './types';
import './links.css';
import './offers.css';

type ProductType = 'card' | 'loan' | 'fd' | 'insurance' | 'other';
interface Cond {
  attribute?: string;
  operator?: string;
  value?: string;
}
export interface Product {
  product_id: string;
  product_name: string;
  product_type: ProductType;
  description: string;
  target_audience_description: string;
  eligibility_rules: { include: string[]; exclude: string[] };
  eligibility: Cond[];
  link: string;
  status: 'live' | 'paused';
  updatedAt?: string;
}
interface SignalInfo {
  key: string;
  label: string;
  type: string;
  values?: string[];
  operators: string[];
}

const TYPE: Record<ProductType, string> = { card: 'Card', loan: 'Loan', fd: 'Fixed deposit', insurance: 'Insurance', other: 'Other' };
const blank = (): Product => ({ product_id: '', product_name: '', product_type: 'card', description: '', target_audience_description: '', eligibility_rules: { include: [], exclude: [] }, eligibility: [], link: '', status: 'live' });

async function post(path: string, body: unknown): Promise<{ ok: boolean; error?: string; problems?: string[] }> {
  const res = await fetch(apiUrl(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json().catch(() => ({ ok: false, error: `Request failed (${res.status})` }))) as { ok: boolean; error?: string; problems?: string[] };
}

export function ProductsView({ tenant }: { tenant: Tenant | null }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [links, setLinks] = useState<BankLink[]>([]);
  const [signals, setSignals] = useState<SignalInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<{ product: Product; isNew: boolean } | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const tenantId = tenant?.tenantId ?? '';

  const reload = async () => {
    if (!tenantId) return;
    const r = await fetch(apiUrl(`/api/products?tenantId=${encodeURIComponent(tenantId)}`)).then((x) => x.json()).catch(() => null);
    setProducts((r as { products?: Product[] } | null)?.products ?? []);
    setLoading(false);
  };
  useEffect(() => {
    setLoading(true);
    setEditing(null);
    reload();
    fetchLinks(tenantId).then(setLinks).catch(() => setLinks([]));
    fetch(apiUrl(`/api/signals?tenantId=${encodeURIComponent(tenantId)}`))
      .then((x) => x.json())
      .then((r: { signals?: SignalInfo[] }) => setSignals(r.signals ?? []))
      .catch(() => setSignals([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const sigLabel = useMemo(() => new Map(signals.map((s) => [s.key, s.label])), [signals]);
  const linkLabel = useMemo(() => new Map(links.map((l) => [l.ref, l])), [links]);
  const condText = (c: Cond) => (c.operator === 'Is' ? `${sigLabel.get(c.attribute ?? '') ?? c.attribute}: ${c.value === 'true' ? 'yes' : 'no'}` : `${sigLabel.get(c.attribute ?? '') ?? c.attribute} ${String(c.operator ?? '').toLowerCase()} ${c.value}`);

  if (!tenant) return null;
  const sorted = [...products].sort((a, b) => (a.status === b.status ? 0 : a.status === 'live' ? -1 : 1));
  const open = (product: Product, isNew: boolean) => {
    setProblems([]);
    setEditing({ product: structuredClone(product), isNew });
  };
  const save = async () => {
    if (!editing) return;
    setSaving(true);
    const r = await post('/api/products', { tenantId, product: editing.product });
    setSaving(false);
    if (!r.ok) return setProblems(r.problems ?? [r.error ?? 'Not saved.']);
    setEditing(null);
    reload();
  };
  const setStatus = async (id: string, status: Product['status']) => {
    const r = await post('/api/products/status', { tenantId, id, status });
    if (r.ok) reload();
  };

  return (
    <div className="cd-page">
      <div className="cd-page-head">
        <div>
          <h1>Products</h1>
          <p className="cd-lede">
            What {tenant.displayName} wants to sell beyond the card in hand: upgrades, add-on cards, loans on the card, insurance. Product campaigns pitch
            them, and other campaigns can cross-sell them when you ask. Each one links to its product page from Links.
          </p>
        </div>
        <button className="of-create" onClick={() => open(blank(), true)}>
          Add product
        </button>
      </div>

      {editing && (
        <ProductForm
          key={editing.isNew ? 'new' : editing.product.product_id}
          draft={editing.product}
          isNew={editing.isNew}
          signals={signals}
          links={links.filter((l) => l.status === 'active')}
          problems={problems}
          saving={saving}
          onChange={(product) => setEditing((e) => (e ? { ...e, product } : e))}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      )}

      {loading && <div className="of-empty">Loading products…</div>}
      {!loading && !products.length && <div className="of-empty">No products yet. Add the first one the bank wants to sell.</div>}

      <div className="of-list">
        {sorted.map((p) => {
          const l = linkLabel.get(p.link);
          return (
            <article key={p.product_id} className={`of-card ${p.status}`}>
              <header className="of-head">
                <div className="of-title">
                  <b>{p.product_name}</b>
                  <code>{p.product_id}</code>
                  <span className="of-state pr-type">{TYPE[p.product_type]}</span>
                  {p.status === 'paused' && <span className="of-state">Paused</span>}
                </div>
                <div className="of-act">
                  <button onClick={() => open(p, false)}>Edit</button>
                  {p.status === 'paused' ? <button onClick={() => setStatus(p.product_id, 'live')}>Resume</button> : <button className="warn" onClick={() => setStatus(p.product_id, 'paused')}>Pause</button>}
                </div>
              </header>
              <p className="of-line pr-desc">{p.description}</p>
              <dl className="of-facts">
                <div>
                  <dt>Who it’s for</dt>
                  <dd>{p.target_audience_description || '—'}</dd>
                </div>
                <div>
                  <dt>Product page</dt>
                  <dd>{l ? `${l.label}${l.shortUrl ? '' : ' (no SMS link yet)'}` : <span className="kl-missing">No link “{p.link}” in Links</span>}</dd>
                </div>
                <div>
                  <dt>Who can get it</dt>
                  <dd>
                    {p.eligibility_rules.include.map((t, i) => (
                      <span key={`i${i}`} className="of-cond">
                        Includes: {t}
                      </span>
                    ))}
                    {p.eligibility_rules.exclude.map((t, i) => (
                      <span key={`x${i}`} className="of-cond">
                        Leaves out: {t}
                      </span>
                    ))}
                    {p.eligibility.map((c, i) => (
                      <span key={`c${i}`} className="of-cond">
                        Checked: {condText(c)}
                      </span>
                    ))}
                    {!p.eligibility.length && !p.eligibility_rules.include.length && 'Any cardholder'}
                  </dd>
                </div>
              </dl>
              {p.updatedAt && <div className="of-when">Changed {fmtDate(p.updatedAt)}</div>}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function ProductForm(props: {
  draft: Product;
  isNew: boolean;
  signals: SignalInfo[];
  links: BankLink[];
  problems: string[];
  saving: boolean;
  onChange: (p: Product) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { draft: p, isNew, signals, links, problems, saving, onChange, onCancel, onSave } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);
  const set = (patch: Partial<Product>) => onChange({ ...p, ...patch });
  const setCond = (i: number, patch: Cond) => set({ eligibility: p.eligibility.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  return (
    <div ref={ref} className="kl-form of-form">
      <div className="kl-grid">
        <label>
          Name
          <input value={p.product_name} placeholder="Travel credit card" onChange={(e) => set({ product_name: e.target.value })} />
        </label>
        <label>
          Reference
          <input value={p.product_id} disabled={!isNew} placeholder="travel_card" onChange={(e) => set({ product_id: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
          <span className="kl-hint">{isNew ? 'Lower-case, set once. Campaigns refer to the product by this.' : 'Set when the product was created; it never changes.'}</span>
        </label>
        <label>
          Type
          <select value={p.product_type} onChange={(e) => set({ product_type: e.target.value as ProductType })}>
            {(Object.keys(TYPE) as ProductType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE[t]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Product page
          <select value={p.link} onChange={(e) => set({ link: e.target.value })}>
            <option value="">Choose a link</option>
            {links.map((l) => (
              <option key={l.ref} value={l.ref}>
                {l.label}
              </option>
            ))}
          </select>
          <span className="kl-hint">From Links. Add the page there first if it’s missing.</span>
        </label>
        <label className="wide">
          What it is
          <textarea rows={2} value={p.description} onChange={(e) => set({ description: e.target.value })} />
        </label>
        <label className="wide">
          Who it’s for
          <input value={p.target_audience_description} placeholder="Customers whose top spend is travel." onChange={(e) => set({ target_audience_description: e.target.value })} />
        </label>
        <label>
          Includes (one per line)
          <textarea rows={2} value={p.eligibility_rules.include.join('\n')} onChange={(e) => set({ eligibility_rules: { ...p.eligibility_rules, include: e.target.value.split('\n') } })} />
        </label>
        <label>
          Leaves out (one per line)
          <textarea rows={2} value={p.eligibility_rules.exclude.join('\n')} onChange={(e) => set({ eligibility_rules: { ...p.eligibility_rules, exclude: e.target.value.split('\n') } })} />
        </label>
        <div className="of-conds wide">
          <span className="of-label">Checked on the bank’s data</span>
          <span className="kl-hint">The same eligibility as rules on signals, so campaigns can count who qualifies. All must hold.</span>
          {p.eligibility.map((c, i) => {
            const s = signals.find((x) => x.key === c.attribute);
            return (
              <div key={i} className="of-cond-row">
                <select aria-label="Signal" value={c.attribute ?? ''} onChange={(e) => setCond(i, { attribute: e.target.value, operator: signals.find((x) => x.key === e.target.value)?.operators[0], value: '' })}>
                  <option value="">Choose a signal</option>
                  {signals.map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.label}
                    </option>
                  ))}
                </select>
                <select aria-label="Operator" value={c.operator ?? ''} onChange={(e) => setCond(i, { operator: e.target.value })}>
                  {(s?.operators ?? []).map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
                <input aria-label="Value" value={c.value ?? ''} list={s?.values?.length ? `pr-v-${s.key}` : undefined} onChange={(e) => setCond(i, { value: e.target.value })} />
                {s?.values?.length ? (
                  <datalist id={`pr-v-${s.key}`}>
                    {s.values.map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                ) : null}
                <button className="of-x" aria-label="Remove" onClick={() => set({ eligibility: p.eligibility.filter((_, j) => j !== i) })}>
                  ✕
                </button>
              </div>
            );
          })}
          <button className="of-add" onClick={() => set({ eligibility: [...p.eligibility, { attribute: '', operator: '', value: '' }] })}>
            + Add a rule
          </button>
        </div>
      </div>
      {problems.length > 0 && (
        <ul className="kl-error of-problems">
          {problems.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
      <div className="kl-actions">
        <button className="cd-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="cd-btn primary" disabled={saving} onClick={onSave}>
          {saving ? 'Saving…' : 'Save product'}
        </button>
      </div>
    </div>
  );
}
