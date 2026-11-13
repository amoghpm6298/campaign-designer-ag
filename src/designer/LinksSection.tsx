// Knowledge Base → Links: the bank's link registry. Every destination a
// message may send a customer to. Messages carry a link's reference; the real
// URL is added when the message is sent, so fixing a URL here fixes every
// campaign. Short links come from the bank's own whitelisted shortener.
import { useEffect, useState } from 'react';
import { apiUrl } from './api';
import { fmtDate } from './time';
import type { Tenant } from './types';
import './links.css';

export interface BankLink {
  ref: string;
  label: string;
  purpose: string;
  url: string;
  shortUrl?: string;
  channels: string[];
  status: 'active' | 'retired';
  mock?: boolean;
  updatedAt: string;
}

const CHANNELS = ['SMS', 'WHATSAPP', 'EMAIL'];
const CH_LABEL: Record<string, string> = { SMS: 'SMS', WHATSAPP: 'WhatsApp', EMAIL: 'Email', RCS: 'RCS', PUSH: 'Push' };
const blank = (): BankLink => ({ ref: '', label: '', purpose: '', url: 'https://', shortUrl: '', channels: [...CHANNELS], status: 'active', updatedAt: '' });

export async function fetchLinks(tenantId: string): Promise<BankLink[]> {
  const res = await fetch(apiUrl(`/api/links?tenantId=${encodeURIComponent(tenantId)}`));
  if (!res.ok) return [];
  return ((await res.json()) as { links?: BankLink[] }).links ?? [];
}

async function post(path: string, body: unknown): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(apiUrl(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json().catch(() => ({ ok: false, error: `Request failed (${res.status})` }))) as { ok: boolean; error?: string };
}

export function LinksSection({ tenant }: { tenant: Tenant | null }) {
  const [links, setLinks] = useState<BankLink[]>([]);
  const [editing, setEditing] = useState<{ link: BankLink; isNew: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [showRetired, setShowRetired] = useState(false);
  const tenantId = tenant?.tenantId ?? '';
  const reload = () => tenantId && fetchLinks(tenantId).then(setLinks).catch(() => setLinks([]));
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  if (!tenant) return null;
  const active = links.filter((l) => l.status === 'active');
  const retired = links.filter((l) => l.status === 'retired');
  const shown = showRetired ? links : active;

  const save = async () => {
    if (!editing) return;
    setSaving(true);
    setError(null);
    const { link } = editing;
    const r = await post('/api/links', { tenantId, link: { ...link, shortUrl: link.shortUrl?.trim() || undefined } });
    setSaving(false);
    if (!r.ok) return setError(r.error ?? 'Not saved');
    setEditing(null);
    reload();
  };
  const retire = async (ref: string) => {
    const r = await post('/api/links/retire', { tenantId, ref });
    if (r.ok) reload();
  };
  const restore = async (l: BankLink) => {
    const r = await post('/api/links', { tenantId, link: { ...l, status: 'active' } });
    if (r.ok) reload();
  };

  const set = (patch: Partial<BankLink>) => setEditing((e) => (e ? { ...e, link: { ...e.link, ...patch } } : e));

  return (
    <section className="hf-section">
      <div className="cd-section-head">
        <div>
          <h2 className="hf-h2">Links</h2>
          <p className="cd-lede">
            Where {tenant.displayName}'s messages can send customers. Campaigns use a link's reference; the real URL is added when a message is sent, so a
            change here reaches every campaign. SMS needs a short link from the bank's own whitelisted shortener.
          </p>
        </div>
        <button className="cd-btn" onClick={() => { setError(null); setEditing({ link: blank(), isNew: true }); }}>
          Add link
        </button>
      </div>

      {editing && (
        <div className="kl-form">
          <div className="kl-grid">
            <label>
              Reference
              <input
                value={editing.link.ref}
                disabled={!editing.isNew}
                placeholder="activate_card"
                onChange={(e) => set({ ref: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })}
              />
              <span className="kl-hint">{editing.isNew ? 'Lower-case, set once. Campaigns refer to the link by this.' : 'Set when the link was created; it never changes.'}</span>
            </label>
            <label>
              Label
              <input value={editing.link.label} placeholder="Activate your card" onChange={(e) => set({ label: e.target.value })} />
            </label>
            <label className="wide">
              What the page does
              <input value={editing.link.purpose} placeholder="Opens card activation in the app; falls back to the web page." onChange={(e) => set({ purpose: e.target.value })} />
            </label>
            <label className="wide">
              Full URL
              <input value={editing.link.url} onChange={(e) => set({ url: e.target.value })} />
            </label>
            <label className="wide">
              Short URL (for SMS)
              <input value={editing.link.shortUrl ?? ''} placeholder="https://indus.in/Ac7k2" onChange={(e) => set({ shortUrl: e.target.value })} />
              <span className="kl-hint">From the bank's whitelisted shortener. Leave empty if there isn't one yet: the link then can't be used in SMS.</span>
            </label>
            <div className="kl-chs">
              Can be used on
              <div>
                {CHANNELS.map((c) => (
                  <label key={c} className="kl-ch">
                    <input
                      type="checkbox"
                      checked={editing.link.channels.includes(c)}
                      onChange={(e) => set({ channels: e.target.checked ? [...editing.link.channels, c] : editing.link.channels.filter((x) => x !== c) })}
                    />
                    {CH_LABEL[c]}
                  </label>
                ))}
              </div>
            </div>
          </div>
          {error && <div className="kl-error">{error}</div>}
          <div className="kl-actions">
            <button className="cd-btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button className="cd-btn primary" disabled={saving} onClick={save}>
              {saving ? 'Saving…' : 'Save link'}
            </button>
          </div>
        </div>
      )}

      <div className="kl-table" role="table">
        <div className="kl-row kl-head" role="row">
          <span>Link</span>
          <span>Full URL</span>
          <span>Short URL (SMS)</span>
          <span>Channels</span>
          <span />
        </div>
        {shown.map((l) => (
          <div key={l.ref} className={`kl-row${l.status === 'retired' ? ' retired' : ''}`} role="row">
            <span className="kl-name">
              <b>{l.label}</b>
              <code>{l.ref}</code>
              {l.mock && <span className="kl-tag mock" title="Example data, not the bank's real link">Example</span>}
              {l.status === 'retired' && <span className="kl-tag retired">Retired</span>}
              <span className="kl-purpose">{l.purpose}</span>
            </span>
            <a className="kl-url" href={l.url} target="_blank" rel="noreferrer" title={l.url}>
              {l.url.replace(/^https:\/\//, '')}
            </a>
            <span>{l.shortUrl ? <code className="kl-short">{l.shortUrl.replace(/^https:\/\//, '')}</code> : <span className="kl-missing">Not usable in SMS until a short link is added</span>}</span>
            <span className="kl-chans">{l.channels.map((c) => CH_LABEL[c] ?? c).join(', ')}</span>
            <span className="kl-act">
              {l.status === 'active' ? (
                <>
                  <button onClick={() => { setError(null); setEditing({ link: { ...l, shortUrl: l.shortUrl ?? '' }, isNew: false }); }}>Edit</button>
                  <button onClick={() => retire(l.ref)} title="Campaigns using it will be fixed automatically when opened">
                    Retire
                  </button>
                </>
              ) : (
                <button onClick={() => restore(l)}>Bring back</button>
              )}
              <span className="kl-when">{l.updatedAt ? fmtDate(l.updatedAt) : ''}</span>
            </span>
          </div>
        ))}
        {!shown.length && <div className="kl-empty">No links yet. Without links, messages can only inform.</div>}
      </div>
      {retired.length > 0 && (
        <button className="kl-toggle" onClick={() => setShowRetired((v) => !v)}>
          {showRetired ? 'Hide retired links' : `Show ${retired.length} retired link${retired.length === 1 ? '' : 's'}`}
        </button>
      )}
    </section>
  );
}
