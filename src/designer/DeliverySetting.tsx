// Knowledge Base → Delivery: what happens when a message is not delivered.
// A bank-wide setting used by the system that sends campaigns; the agent does
// not decide it per message.
import { useEffect, useState } from 'react';
import { apiUrl } from './api';
import type { Tenant } from './types';
import './links.css';

export function DeliverySetting({ tenant }: { tenant: Tenant | null }) {
  const [smsFallback, setSmsFallback] = useState<boolean | null>(null);
  const [saved, setSaved] = useState(false);
  const tenantId = tenant?.tenantId ?? '';
  useEffect(() => {
    if (!tenantId) return;
    fetch(apiUrl(`/api/bank-settings?tenantId=${encodeURIComponent(tenantId)}`))
      .then((r) => r.json())
      .then((d: { settings?: { smsFallback?: boolean } }) => setSmsFallback(d.settings?.smsFallback !== false))
      .catch(() => setSmsFallback(true));
  }, [tenantId]);
  if (!tenant || smsFallback === null) return null;
  const save = async (v: boolean) => {
    setSmsFallback(v);
    setSaved(false);
    await fetch(apiUrl('/api/bank-settings'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId, settings: { smsFallback: v } }) });
    setSaved(true);
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
    </section>
  );
}
