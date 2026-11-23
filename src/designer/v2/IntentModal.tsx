// "What do you want this campaign to do?": the first step of a new campaign.
// The choice points the designer at the right goal, data and levers. For
// product sign-ups, the product is picked from the bank's Products list.
import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Banknote, Building2, CreditCard, Landmark, Package, PiggyBank, ShieldCheck, ShoppingBag, Smartphone, TrendingUp, UserCheck, Wallet, Wrench, X, Zap, type LucideIcon } from 'lucide-react';
import { apiUrl } from '../api';
import { INTENTS, type CampaignIntent, type IntentChoice } from './intent';

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

export function IntentModal({ tenantId, onPick, onClose }: { tenantId: string; onPick: (c: IntentChoice) => void; onClose: () => void }) {
  const [intent, setIntent] = useState<CampaignIntent | null>(null);
  const [products, setProducts] = useState<ProductLite[] | null>(null);
  const [productId, setProductId] = useState('');
  // Two steps: what the campaign is for, then (for product sign-ups) which product.
  const [step, setStep] = useState<'intent' | 'product'>('intent');
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
  const finish = () => intent && onPick({ intent, ...(intent === 'adoption' ? { productId } : {}) });
  return (
    <div className="im-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className="im" role="dialog" aria-modal="true" aria-labelledby="im-title" tabIndex={-1}>
        <header className="im-head">
          <div>
            {step === 'product' && <div className="im-step">Step 2 of 2 · Drive product sign-ups</div>}
            <h2 id="im-title">{step === 'intent' ? 'What do you want this campaign to do?' : 'Which product do you want to sell?'}</h2>
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
                      <b>{i.label}</b>
                      <span>{i.hint}</span>
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
          {step === 'product' ? (
            <button className="cv-btn im-back-btn" onClick={() => setStep('intent')}>
              <ArrowLeft size={15} /> Back
            </button>
          ) : (
            <button className="cv-btn" onClick={onClose}>
              Cancel
            </button>
          )}
          <button
            className="cv-btn primary"
            disabled={step === 'intent' ? !intent : !productId}
            onClick={() => (step === 'intent' && intent === 'adoption' ? setStep('product') : finish())}
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
