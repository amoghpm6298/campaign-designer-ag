// Comm approvals: every message a customer would read is approved by the bank
// before a campaign can be submitted. An inbox of messages, grouped by
// campaign: Approve, Edit & approve, or Reject with a reason. A rejected
// message shows on the campaign's canvas with "Rewrite with designer".
import { useEffect, useMemo, useState } from 'react';
import { Check, ExternalLink, Pencil, ShieldCheck, X } from 'lucide-react';
import { apiUrl } from './api';
import { fmtDate } from './time';
import { fetchLinks, type BankLink } from './LinksSection';
import { ChannelPreview } from './v2/canvasNodes';
import type { Tenant } from './types';
import './links.css';
import './offers.css';
import './v2/v2.css';

export interface ApprovalRecordView {
  fp: string;
  content: { channel: string; copy: string; cta: string; link: string; offerLine: string };
  status: 'pending' | 'approved' | 'rejected';
  uses: { bucketId: string; bucketName: string; stepId: string; name: string }[];
  queuedAt: string;
  decidedBy?: string;
  decidedAt?: string;
  reason?: string;
}

interface CampaignQueue {
  sessionId: string;
  name: string;
  state: string;
  records: ApprovalRecordView[];
}

type Filter = 'pending' | 'rejected' | 'approved' | 'all';
const FILTERS: [Filter, string][] = [
  ['pending', 'Pending'],
  ['rejected', 'Rejected'],
  ['approved', 'Approved'],
  ['all', 'All'],
];
const STATUS_LABEL = { pending: 'Pending approval', approved: 'Approved', rejected: 'Rejected' } as const;

async function post(body: object): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(apiUrl('/api/approvals/decide'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return (await r.json()) as { ok: boolean; error?: string };
  } catch {
    return { ok: false, error: 'Could not reach the server. Try again.' };
  }
}

export function CommApprovalsView({ tenant, focusId }: { tenant: Tenant | null; focusId?: string | null }) {
  const [queues, setQueues] = useState<CampaignQueue[] | null>(null);
  const [links, setLinks] = useState<BankLink[]>([]);
  const [filter, setFilter] = useState<Filter>('pending');
  const [openId, setOpenId] = useState<string | null>(focusId ?? null);
  const [error, setError] = useState('');
  const tenantId = tenant?.tenantId ?? '';

  const reload = () =>
    fetch(apiUrl(`/api/approvals?tenantId=${encodeURIComponent(tenantId)}`))
      .then((r) => r.json())
      .then((d: { campaigns?: CampaignQueue[] }) => {
        setQueues(d.campaigns ?? []);
        window.dispatchEvent(new Event('cv:approvals-changed'));
      })
      .catch(() => setError('Could not load the approval queue. Refresh to try again.'));
  useEffect(() => {
    if (!tenantId) return;
    reload();
    fetchLinks(tenantId).then(setLinks).catch(() => setLinks([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const count = (q: CampaignQueue, s: Filter) => (s === 'all' ? q.records.length : q.records.filter((r) => r.status === s).length);
  const shown = useMemo(() => (queues ?? []).filter((q) => count(q, filter) > 0).sort((a, b) => count(b, 'pending') - count(a, 'pending')), [queues, filter]);
  const open = shown.find((q) => q.sessionId === openId) ?? shown[0];

  if (!tenant) return null;
  return (
    <div className="cd-page ca-page">
      <div className="cd-page-head">
        <div>
          <h1>Comm approvals</h1>
          <p className="cd-lede">Every message a customer reads is approved here first. A campaign can be submitted only when all its messages are approved.</p>
        </div>
      </div>
      <div className="cv-states ca-filters" role="tablist" aria-label="Show">
        {FILTERS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
            {label} <span>{(queues ?? []).reduce((n, q) => n + count(q, k), 0)}</span>
          </button>
        ))}
      </div>
      {error && <div className="of-empty">{error}</div>}
      {!error && queues === null && <div className="of-empty">Loading the approval queue…</div>}
      {!error && queues && !shown.length && (
        <div className="of-empty">{filter === 'pending' ? 'Nothing waiting. New messages appear here as soon as the designer writes them.' : `No ${filter === 'all' ? '' : `${filter} `}messages.`}</div>
      )}
      {!!shown.length && open && (
        <div className="ca-inbox">
          <nav className="ca-list" aria-label="Campaigns">
            {shown.map((q) => (
              <button key={q.sessionId} className={`ca-camp${q.sessionId === open.sessionId ? ' on' : ''}`} onClick={() => setOpenId(q.sessionId)}>
                <b>{q.name || 'Untitled campaign'}</b>
                <span className="ca-counts">
                  {count(q, 'pending') > 0 && <span className="ca-n pending">{count(q, 'pending')} pending</span>}
                  {count(q, 'rejected') > 0 && <span className="ca-n rejected">{count(q, 'rejected')} rejected</span>}

                </span>
              </button>
            ))}
          </nav>
          <CampaignMessages key={open.sessionId} q={open} filter={filter} tenant={tenant} links={links} onChanged={reload} />
        </div>
      )}
    </div>
  );
}

function CampaignMessages({ q, filter, tenant, links, onChanged }: { q: CampaignQueue; filter: Filter; tenant: Tenant; links: BankLink[]; onChanged: () => void }) {
  const list = q.records.filter((r) => filter === 'all' || r.status === filter);
  const pending = q.records.filter((r) => r.status === 'pending');
  const [confirmAll, setConfirmAll] = useState(false);
  const [err, setErr] = useState('');
  const approveAll = async () => {
    for (const r of pending) {
      const out = await post({ sessionId: q.sessionId, tenantId: tenant.tenantId, fp: r.fp, action: 'approve' });
      if (!out.ok) {
        setErr(out.error ?? 'Could not approve.');
        break;
      }
    }
    setConfirmAll(false);
    onChanged();
  };
  return (
    <section className="ca-msgs" aria-label={q.name}>
      <header className="ca-msgs-head">
        <div>
          <h2>{q.name || 'Untitled campaign'}</h2>
          <span className="cv-muted">
            {q.records.length} message{q.records.length === 1 ? '' : 's'} · {q.records.filter((r) => r.status === 'approved').length} approved
          </span>
        </div>
        {pending.length > 1 &&
          (confirmAll ? (
            <span className="ca-confirm">
              Approve all {pending.length} pending messages?
              <button className="cv-btn" onClick={() => setConfirmAll(false)}>
                Cancel
              </button>
              <button className="cv-btn primary" onClick={approveAll}>
                Approve all
              </button>
            </span>
          ) : (
            <button className="cv-btn" onClick={() => setConfirmAll(true)}>
              <Check size={14} /> Approve all pending
            </button>
          ))}
      </header>
      {err && <p className="cv-del-err">{err}</p>}
      {list.map((r) => (
        <MessageRow key={r.fp} r={r} sessionId={q.sessionId} tenant={tenant} links={links} onChanged={onChanged} />
      ))}
    </section>
  );
}

function MessageRow({ r, sessionId, tenant, links, onChanged }: { r: ApprovalRecordView; sessionId: string; tenant: Tenant; links: BankLink[]; onChanged: () => void }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'reject'>('view');
  const [copy, setCopy] = useState(r.content.copy);
  const [cta, setCta] = useState(r.content.cta);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const link = links.find((l) => l.ref === r.content.link);
  const act = async (body: object) => {
    setBusy(true);
    setErr('');
    const out = await post({ sessionId, tenantId: tenant.tenantId, fp: r.fp, ...body });
    setBusy(false);
    if (!out.ok) return setErr(out.error ?? 'Could not save.');
    setMode('view');
    onChanged();
  };
  // Each place it is used, as a link that opens the campaign in a new tab, zoomed to this message.
  const where = r.uses.filter((u, i) => r.uses.findIndex((x) => x.bucketName === u.bucketName && x.name === u.name) === i);
  const linkTo = (u: ApprovalRecordView['uses'][number]) => {
    const url = new URL(location.href);
    url.search = '';
    const bank = new URLSearchParams(location.search).get('bank');
    if (bank) url.searchParams.set('bank', bank);
    url.searchParams.set('c', sessionId);
    url.searchParams.set('b', u.bucketId);
    url.searchParams.set('step', u.stepId);
    return url.toString();
  };
  return (
    <article className={`ca-msg ${r.status}`}>
      <div className="ca-preview">
        <ChannelPreview
          channel={r.content.channel}
          text={mode === 'edit' ? copy : r.content.copy}
          cta={mode === 'edit' ? cta : r.content.cta}
          bank={(tenant.issuer || tenant.displayName).replace(/\s*\(.*?\)\s*/g, '').trim()}
          link={link}
          offerLine={r.content.offerLine || undefined}
        />
      </div>
      <div className="ca-side">
        <span className={`cv-appr ${r.status}`}>
          <span className="cv-appr-tag">
            <i aria-hidden="true" />
            {STATUS_LABEL[r.status]}
          </span>
        </span>
        <div className="ca-where">
          <span className="ca-k">Used in</span>
          {where.slice(0, 3).map((u) => (
            <a key={`${u.bucketId}:${u.stepId}`} className="ca-uselink" href={linkTo(u)} target="_blank" rel="noreferrer" title="Open the campaign in a new tab, at this message">
              {u.bucketName} · {u.name} <ExternalLink size={12} aria-hidden="true" />
            </a>
          ))}
          {where.length > 3 && <span className="cv-muted">and {where.length - 3} more</span>}
        </div>
        {r.status !== 'pending' && r.decidedAt && (
          <div className="ca-decided">
            {r.status === 'approved' ? 'Approved' : 'Rejected'} by {r.decidedBy ?? 'someone'} · {fmtDate(r.decidedAt)}
            {r.status === 'rejected' && r.reason && <div className="ca-reason">“{r.reason}”</div>}
          </div>
        )}
        {mode === 'edit' && (
          <div className="ca-form">
            <label>
              <span className="ca-k">Message</span>
              <textarea rows={5} value={copy} onChange={(e) => setCopy(e.target.value)} />
            </label>
            {r.content.channel !== 'SMS' && (
              <label>
                <span className="ca-k">Button</span>
                <input value={cta} onChange={(e) => setCta(e.target.value)} />
              </label>
            )}
            <p className="kl-hint">The offer line and the link are added by the system and can't be edited here.</p>
          </div>
        )}
        {mode === 'reject' && (
          <div className="ca-form">
            <label>
              <span className="ca-k">Why is it rejected?</span>
              <textarea rows={3} value={reason} autoFocus placeholder="For example: don't promise 'guaranteed' rewards." onChange={(e) => setReason(e.target.value)} />
            </label>
            <p className="kl-hint">The designer rewrites the message from this reason.</p>
          </div>
        )}
        {err && <p className="cv-del-err">{err}</p>}
        <div className="ca-actions">
          {mode === 'view' && (
            <>
              {r.status !== 'approved' && (
                <button className="cv-btn primary" disabled={busy} onClick={() => act({ action: 'approve' })}>
                  <Check size={14} /> Approve
                </button>
              )}
              <button className="cv-btn" disabled={busy} onClick={() => setMode('edit')}>
                <Pencil size={13} /> Edit &amp; approve
              </button>
              {r.status !== 'rejected' && (
                <button className="cv-btn ca-reject" disabled={busy} onClick={() => setMode('reject')}>
                  <X size={14} /> Reject
                </button>
              )}
            </>
          )}
          {mode === 'edit' && (
            <>
              <button className="cv-btn" onClick={() => { setMode('view'); setCopy(r.content.copy); setCta(r.content.cta); }}>
                Cancel
              </button>
              <button className="cv-btn primary" disabled={busy || !copy.trim()} onClick={() => act({ action: 'edit', copy, cta })}>
                <ShieldCheck size={14} /> {busy ? 'Saving…' : 'Save and approve'}
              </button>
            </>
          )}
          {mode === 'reject' && (
            <>
              <button className="cv-btn" onClick={() => setMode('view')}>
                Cancel
              </button>
              <button className="cv-btn ca-reject solid" disabled={busy || !reason.trim()} onClick={() => act({ action: 'reject', reason })}>
                {busy ? 'Saving…' : 'Reject'}
              </button>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
