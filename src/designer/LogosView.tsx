// The Card logos page: the bank's credit card products (MARQUEE, ACE, KLICK…),
// each with its fees, rewards and benefits, and how many cards are held and
// activated. Every flow and campaign is for one or more of these logos, or for
// all cards. Read-only: the catalogue is the bank's real lineup, researched from
// public sources, so fees and rewards are indicative.
import { useEffect, useState } from 'react';
import type { Tenant } from './types';
import { fetchLogos, type LogoView } from './v2/api';

const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;

export function LogosView({ tenant }: { tenant: Tenant | null }) {
  const [logos, setLogos] = useState<LogoView[] | null>(null);
  useEffect(() => {
    if (!tenant) return;
    setLogos(null);
    fetchLogos(tenant.tenantId).then(setLogos).catch(() => setLogos([]));
  }, [tenant]);
  if (!tenant) return null;
  const totalCards = (logos ?? []).reduce((n, l) => n + (l.cards ?? 0), 0);
  return (
    <div className="cd-page">
      <div className="cd-page-head">
        <div>
          <h1>Card logos</h1>
          <p className="cd-lede">
            {tenant.displayName}'s credit cards. Every flow and campaign is for one or more of them, or for all cards, and its numbers count only those
            cardholders. Fees and rewards are from public sources and indicative, not the bank's official terms.
          </p>
        </div>
      </div>
      {logos === null && <div className="of-empty">Loading card logos…</div>}
      {logos && !logos.length && <div className="of-empty">No card logos for this bank yet.</div>}
      <div className="lg-grid">
        {(logos ?? []).map((l) => (
          <article key={l.logo_id} className="lg-card">
            <header>
              <span className="lg-tier">{l.tier}</span>
              <b>{l.name}</b>
              <span className="lg-net">{l.network}</span>
            </header>
            {l.cards != null && (
              <div className="lg-counts">
                <span>
                  <b>{l.cards.toLocaleString('en-IN')}</b> cards{totalCards ? ` · ${Math.round((100 * l.cards) / totalCards)}%` : ''}
                </span>
                <span>
                  <b>{(l.activated ?? 0).toLocaleString('en-IN')}</b> activated
                </span>
              </div>
            )}
            <dl>
              <dt>Fees</dt>
              <dd>
                {l.joining_fee ? `${inr(l.joining_fee)} joining · ` : ''}
                {l.annual_fee ? `${inr(l.annual_fee)} a year` : 'No annual fee'}
                {l.fee_waiver ? <span className="lg-sub">{l.fee_waiver}</span> : null}
              </dd>
              <dt>Rewards</dt>
              <dd>{l.rewards_rule}</dd>
              <dt>Benefits</dt>
              <dd>
                <ul>
                  {l.key_benefits.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </dd>
            </dl>
          </article>
        ))}
      </div>
    </div>
  );
}
