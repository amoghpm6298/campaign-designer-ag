// "What do you want this campaign to do?": the first step of a new campaign.
// The choice points the designer at the right goal, data and levers. For
// product sign-ups, the product is picked from the bank's Products list.
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Banknote, Sparkles, Building2, CreditCard, Landmark, Package, PiggyBank, ShieldCheck, ShoppingBag, Smartphone, TrendingUp, UserCheck, Wallet, Wrench, X, Zap, type LucideIcon } from 'lucide-react';
import { apiUrl } from '../api';
import { BRIEF_SUGGESTIONS, INTENTS, intentLabel, type CampaignIntent, type IntentChoice } from './intent';
import type { CampaignKind } from './kind';

interface ProductLite {
  product_id: string;
  product_name: string;
  product_type: string;
  description: string;
  status: string;
}

/** One icon and colour per intent, so the tiles read at a glance. */
export const LOOK: Record<CampaignIntent, { Icon: LucideIcon; tone: string }> = {
  usage: { Icon: TrendingUp, tone: 'blue' },
  activation: { Icon: Zap, tone: 'blue' },
  adoption: { Icon: ShoppingBag, tone: 'blue' },
  churn: { Icon: UserCheck, tone: 'blue' },
  other: { Icon: Wrench, tone: 'blue' },
};

/** Where Smart Engage goes next: savings and current accounts (CASA). Shown for perspective, not selectable yet. */
const COMING_SOON: { label: string; hint: string; Icon: LucideIcon }[] = [
  { label: 'Increase savings deposits', hint: 'Grow balances in savings accounts.', Icon: PiggyBank },
  { label: 'Increase debit card usage', hint: 'Get account holders paying with their debit card.', Icon: Wallet },
  { label: 'Grow fixed deposits', hint: 'Get customers to open or renew FDs.', Icon: Landmark },
  { label: 'Drive UPI payments', hint: 'Get customers paying by UPI from their account.', Icon: Smartphone },
];

/** The working intents, by what they're about. */
const SECTIONS: { title: string; Icon: LucideIcon; keys: CampaignIntent[] }[] = [
  { title: 'Credit cards', Icon: CreditCard, keys: ['usage', 'activation', 'churn', 'other'] },
  { title: 'Across the bank', Icon: Building2, keys: ['adoption'] },
];

/** One icon and colour per product type. */
const PRODUCT_LOOK: Record<string, { Icon: LucideIcon; tone: string }> = {
  card: { Icon: CreditCard, tone: 'blue' },
  loan: { Icon: Banknote, tone: 'blue' },
  fd: { Icon: Landmark, tone: 'blue' },
  insurance: { Icon: ShieldCheck, tone: 'blue' },
  other: { Icon: Package, tone: 'blue' },
};

export function IntentModal({ tenantId, kind = 'campaign', onPick, onClose }: { tenantId: string; kind?: CampaignKind; onPick: (c: IntentChoice) => void; onClose: () => void }) {
  const noun = kind === 'flow' ? 'flow' : 'campaign';
  const [intent, setIntent] = useState<CampaignIntent | null>(null);
  const [products, setProducts] = useState<ProductLite[] | null>(null);
  const [productId, setProductId] = useState('');
  // What the campaign is for, then (for product sign-ups) which product, then the brief.
  const [step, setStep] = useState<'intent' | 'product' | 'brief'>('intent');
  const [brief, setBrief] = useState('');
  const productName = products?.find((p) => p.product_id === productId)?.product_name ?? 'the product';
  const steps = intent === 'adoption' ? 3 : 2;
  const stepNo = step === 'intent' ? 1 : step === 'product' ? 2 : steps;
  const intentText = intent ? intentLabel(intent, kind) : '';
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (intent !== 'adoption' || products) return;
    fetch(apiUrl(`/api/products?tenantId=${encodeURIComponent(tenantId)}`))
      .then((r) => r.json())
      .then((d: { products?: ProductLite[] }) => setProducts((d.products ?? []).filter((p) => p.status === 'live')))
      .catch(() => setProducts([]));
  }, [intent, products, tenantId]);
  const finish = () => intent && brief.trim() && onPick({ intent, kind, ...(intent === 'adoption' ? { productId } : {}), brief: brief.trim() });
  const next = () => {
    if (step === 'intent') return setStep(intent === 'adoption' ? 'product' : 'brief');
    if (step === 'product') return setStep('brief');
    finish();
  };
  // A brief written for one intent doesn't carry over to another.
  useEffect(() => setBrief(''), [intent]);
  const back = () => setStep(step === 'brief' && intent === 'adoption' ? 'product' : 'intent');
  return (
    <div className="im-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="im" role="dialog" aria-modal="true" aria-labelledby="im-title" tabIndex={-1}>
        <header className="im-head">
          <div>
            {step !== 'intent' && (
              <div className="im-step">
                Step {stepNo} of {steps} · {intentText}
                {step === 'brief' && intent === 'adoption' ? ` · ${productName}` : ''}
              </div>
            )}
            <h2 id="im-title">{step === 'intent' ? `What do you want this ${noun} to do?` : step === 'product' ? 'Which product do you want to sell?' : `Describe your ${noun}`}</h2>
          </div>
          <button className="fpm-x" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="im-body">
        {step === 'intent' ? (
          <>
          {SECTIONS.map((sec, n) => (
            <div key={sec.title} className="im-section">
              <div className={`im-group${n ? ' divided' : ''}`}>
                <sec.Icon size={16} aria-hidden="true" /> {sec.title}
              </div>
              <div className="im-grid" role="radiogroup" aria-label={sec.title}>
                {sec.keys.map((k, idx) => {
                  const i = INTENTS.find((x) => x.key === k)!;
                  const { Icon, tone } = LOOK[k];
                  const wide = sec.keys.length % 2 === 1 && idx === sec.keys.length - 1;
                  return (
                    <button key={k} role="radio" aria-checked={intent === k} className={`im-tile${intent === k ? ' on' : ''}${wide ? ' wide' : ''}`} onClick={() => setIntent(k)}>
                      <span className={`im-icon ${tone}`} aria-hidden="true">
                        <Icon size={20} />
                      </span>
                      <b>{intentLabel(k, kind)}</b>
                      <span>{kind === 'flow' && k === 'other' ? 'Any other always-on credit card flow. Describe it in your own words.' : i.hint}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          <div className="im-group divided">
            <PiggyBank size={16} aria-hidden="true" /> CASA · Savings &amp; current accounts <span className="im-soon">Coming soon</span>
          </div>
          <div className="im-grid">
            {COMING_SOON.map(({ label, hint, Icon }) => (
              <div key={label} className="im-tile soon" aria-disabled="true" title="Coming soon">
                <span className="im-icon grey" aria-hidden="true">
                  <Icon size={20} />
                </span>
                <b>{label}</b>
                <span>{hint}</span>
              </div>
            ))}
          </div>
          </>
        ) : step === 'brief' ? (
          <div className="im-brief">
            <label className="im-brief-label" htmlFor="im-brief-text">
              {kind === 'flow'
                ? 'Who should join as they become eligible, what they should do within how many days of joining, channels and any offer or monthly budget. A sentence is enough; more detail helps.'
                : 'Who it is for, the dates and any occasion, what counts as success by the end, channels and any offer or budget. A sentence is enough; more detail helps.'}
            </label>
            <textarea
              id="im-brief-text"
              className="im-brief-text"
              rows={5}
              autoFocus
              value={brief}
              placeholder={
                kind === 'flow'
                  ? 'For example: every new cardholder joins on the day the card is issued; success is a first transaction within 30 days.'
                  : 'For example: a 3-week festive push to get light users spending more; success is total extra spend by the end date.'
              }
              onChange={(e) => setBrief(e.target.value)}
            />
            <div className="im-sugg-h">
              <Sparkles size={14} aria-hidden="true" /> Start from a suggestion
            </div>
            <div className="im-sugg">
              {(intent ? BRIEF_SUGGESTIONS[kind][intent] : []).map((x) => {
                const text = x.brief.replace(/\{product\}/g, productName);
                return (
                  <button key={x.title} className={`im-sugg-card${brief === text ? ' on' : ''}`} onClick={() => setBrief(text)}>
                    <b>{x.title}</b>
                    <span>{text}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : products === null ? (
          <div className="cv-muted">Loading products…</div>
        ) : products.length === 0 ? (
          <div className="cv-muted">No products yet. Add them on the Products page first.</div>
        ) : (
          <div className="im-grid" role="radiogroup" aria-label="Product">
            {products.map((p) => {
              const { Icon, tone } = PRODUCT_LOOK[p.product_type] ?? PRODUCT_LOOK.other;
              return (
                <button key={p.product_id} role="radio" aria-checked={productId === p.product_id} className={`im-tile${productId === p.product_id ? ' on' : ''}`} onClick={() => setProductId(p.product_id)}>
                  <span className={`im-icon ${tone}`} aria-hidden="true">
                    <Icon size={20} />
                  </span>
                  <b>{p.product_name}</b>
                  <span>{p.description}</span>
                </button>
              );
            })}
          </div>
        )}
        </div>
        <div className="im-actions">
          {step !== 'intent' ? (
            <button className="cv-btn im-back-btn" onClick={back}>
              <ArrowLeft size={15} /> Back
            </button>
          ) : (
            <button className="cv-btn" onClick={onClose}>
              Cancel
            </button>
          )}
          <button
            className="cv-btn primary"
            disabled={step === 'intent' ? !intent : step === 'product' ? !productId : !brief.trim()}
            onClick={next}
          >
            {step === 'brief' ? `Create ${noun}` : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
