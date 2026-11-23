// Knowledge Base → Delivery: what happens when a message is not delivered, and
// how many messages reach customers on each channel. Bank-wide settings: the
// sending system uses the first; every campaign's funnel and cost use the
// delivery rates (server/costModel.ts). The agent decides neither.
import { useEffect, useState } from 'react';
import { apiUrl } from './api';
import type { Tenant } from './types';
import './links.css';

const CHANNELS: [string, string][] = [
  ['WHATSAPP', 'WhatsApp'],
  ['SMS', 'SMS'],
  ['EMAIL', 'Email'],
  ['RCS', 'RCS'],
  ['PUSH', 'Push'],
];

export function DeliverySetting({ tenant }: { tenant: Tenant | null }) {
  const [smsFallback, setSmsFallback] = useState<boolean | null>(null);
  const [saved, setSaved] = useState(false);
  const [rates, setRates] = useState<Record<string, string>>({});
  const [ratesSaved, setRatesSaved] = useState<'idle' | 'saved' | 'bad'>('idle');
  const tenantId = tenant?.tenantId ?? '';
  useEffect(() => {
    if (!tenantId) return;
    fetch(apiUrl(`/api/bank-settings?tenantId=${encodeURIComponent(tenantId)}`))
      .then((r) => r.json())
      .then((d: { settings?: { smsFallback?: boolean; deliveryRates?: Record<string, number> } }) => {
        setSmsFallback(d.settings?.smsFallback !== false);
        setRates(Object.fromEntries(Object.entries(d.settings?.deliveryRates ?? {}).map(([k, v]) => [k, String(Math.round(v * 1000) / 10)])));
      })
      .catch(() => setSmsFallback(true));
  }, [tenantId]);
  if (!tenant || smsFallback === null) return null;
  const save = async (v: boolean) => {
    setSmsFallback(v);
    setSaved(false);
    await fetch(apiUrl('/api/bank-settings'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId, settings: { smsFallback: v } }) });
    setSaved(true);
  };
  const saveRates = async () => {
    const parsed = Object.fromEntries(Object.entries(rates).map(([k, v]) => [k, Number(v) / 100]));
    if (Object.values(parsed).some((v) => !(v >= 0 && v <= 1))) return setRatesSaved('bad');
    await fetch(apiUrl('/api/bank-settings'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId, settings: { deliveryRates: parsed } }) });
    setRatesSaved('saved');
  };
  return (
    <section className="hf-section">
      <div className="cd-section-head">
        <div>
          <h2 className="hf-h2">Delivery</h2>
          <p className="cd-lede">How {tenant.displayName}'s messages are delivered. Applies to every campaign; the agent doesn't decide it per message.</p>
        </div>
      </div>
      <div className="kl-delivery">
        <div>
          <b>If a WhatsApp message isn't delivered</b>
          <span>Campaigns can still ask for a different rule on a single message.</span>
        </div>
        <div className="kl-seg">
          <button className={smsFallback ? 'on' : ''} onClick={() => save(true)}>
            Send it by SMS
          </button>
          <button className={!smsFallback ? 'on' : ''} onClick={() => save(false)}>
            Don't retry
          </button>
        </div>
        {saved && <span className="kl-saved">Saved</span>}
      </div>
      <div className="kl-delivery kl-rates">
        <div>
          <b>Delivery rates</b>
          <span>The share of messages that reach the customer on each channel. Every campaign's funnel and cost start from these. Typical rates to begin with: set your own.</span>
        </div>
        <div className="kl-rate-row">
          {CHANNELS.map(([k, label]) => (
            <label key={k} className="kl-rate">
              {label}
              <span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="0.5"
                  value={rates[k] ?? ''}
                  onChange={(e) => {
                    setRates((r) => ({ ...r, [k]: e.target.value }));
                    setRatesSaved('idle');
                  }}
                />
                %
              </span>
            </label>
          ))}
          <button className="cd-btn" onClick={saveRates}>
            Save rates
          </button>
          {ratesSaved === 'saved' && <span className="kl-saved">Saved</span>}
          {ratesSaved === 'bad' && <span className="kl-error">Use percentages from 0 to 100.</span>}
        </div>
      </div>
    </section>
  );
}
