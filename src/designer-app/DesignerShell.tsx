// The standalone application shell: its own header, navigation and global
// tenant selector. Nothing here comes from the ib-face-mock chrome.
import { useCallback, useEffect, useMemo, useState } from 'react';
import logo from '../assets/hfLogo.svg';
import {
  applyOverrides,
  loadOverrides,
  resetAll,
  type KnowledgeOverrides,
} from '../designer/knowledgeStore';
import { CampaignDesigner } from '../designer/CampaignDesigner';
import { KnowledgeBaseView } from '../designer/KnowledgeBaseView';
import { RunLogsView } from '../designer/RunLogsView';
import { listTenants, seedKnowledge } from '../designer/api';
import {
  clearSession,
  loadRunLogs,
  loadSession,
  loadTenantId,
  saveTenantId,
} from '../designer/storage';
import type { Capabilities, KnowledgeBase, RunLog, Tenant } from '../designer/types';

type Page = 'designer' | 'knowledge' | 'logs';

export function DesignerShell() {
  const [page, setPage] = useState<Page>('designer');
  /**
   * Which chat the designer is showing.
   *
   * Held here rather than inside `CampaignDesigner` because the Chats page is
   * what changes it: resuming is a navigation, and navigation belongs to the
   * shell. The designer reads it as a prop and keys off it, so the same one
   * component serves both the live chat and a resumed one.
   */
  const [openChat, setOpenChat] = useState<string | undefined>(undefined);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantId, setTenantId] = useState<string>(loadTenantId() ?? '');
  // THE SEED IS RECOMPUTED EVERY LOAD, and the user's changes are applied on
  // top. It used to be read wholesale from localStorage and returned early if
  // present, which froze all 35 entries the first time anyone edited one —
  // every later seed improvement became invisible to that user and to their
  // agent, with nothing on screen to say so.
  const [seed, setSeed] = useState<KnowledgeBase | null>(null);
  const [overrides, setOverrides] = useState<KnowledgeOverrides>(() => loadOverrides());
  const knowledge = useMemo(() => (seed ? applyOverrides(seed, overrides) : null), [seed, overrides]);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [logs, setLogs] = useState<RunLog[]>(loadRunLogs());
  const [bootError, setBootError] = useState<string | null>(null);
  /** Set when the chosen tenant differs from the one the open session began with. */
  const [tenantMismatch, setTenantMismatch] = useState<string | null>(null);
  // Persisted, because a collapsed rail that springs back open on every
  // reload is a preference the product keeps overruling.
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem('hf-rail') !== 'collapsed');
  useEffect(() => {
    localStorage.setItem('hf-rail', railOpen ? 'open' : 'collapsed');
  }, [railOpen]);

  useEffect(() => {
    let cancelled = false;
    listTenants()
      .then(({ tenants: list }) => {
        if (cancelled) return;
        setTenants(list);
        setTenantId((current) => (current && list.some((t) => t.tenantId === current) ? current : list[0]?.tenantId ?? ''));
      })
      .catch((e) => !cancelled && setBootError((e as Error).message));
    seedKnowledge()
      .then(({ knowledge: seeded, capabilities: caps }) => {
        if (cancelled) return;
        setCapabilities(caps);
        setSeed(seeded);
      })
      .catch((e) => !cancelled && setBootError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (tenantId) saveTenantId(tenantId);
  }, [tenantId]);

  // A session belongs to the tenant it was designed for. Switching tenants
  // must not silently reinterpret an existing campaign as the new tenant's —
  // the user is told, and chooses.
  useEffect(() => {
    const session = loadSession();
    if (!session?.tenantId || !tenantId) return setTenantMismatch(null);
    setTenantMismatch(session.tenantId !== tenantId ? session.tenantId : null);
  }, [tenantId, page]);

  const tenant = tenants.find((t) => t.tenantId === tenantId) ?? null;

  // Drops the user's CHANGES, not the knowledge. The seed is recomputed on
  // every load, so this can no longer lose anything that was ours to give.
  const resetKnowledge = useCallback(() => setOverrides(resetAll()), []);

  return (
    <>
      {/* THE RAIL. The one dark surface in the product, and a deliberate
          exception rather than a theme: content stays light throughout. Same
          choice the propensity agent makes, where the sidebar is the only
          dark region in an otherwise entirely light app, so it reads as
          product chrome instead of a mode. */}
      <nav className={`hf-rail ${railOpen ? '' : 'collapsed'}`} aria-label="Sections">
        <div className="hf-rail-top">
          <img className="hf-rail-logo" src={logo} alt="Hyperface" width={26} height={26} />
          {railOpen && (
            <span className="hf-rail-wordmark">
              Campaign Designer
              <small>Hyperface</small>
            </span>
          )}
          <button
            className="hf-rail-toggle"
            onClick={() => setRailOpen((v) => !v)}
            aria-label={railOpen ? 'Collapse navigation' : 'Expand navigation'}
            aria-expanded={railOpen}
          >
            {railOpen ? '\u00AB' : '\u00BB'}
          </button>
        </div>

        <div className="hf-rail-items hf-scroll-rail">
          {(
            [
              ['designer', 'Design', 'M3 12h4l3 7 4-14 3 7h4'],
              ['knowledge', 'Knowledge Base', 'M4 5h16M4 12h16M4 19h10'],
              ['logs', 'Chats', 'M5 4h14v16H5zM8 9h8M8 13h8M8 17h5'],
            ] as [Page, string, string][]
          ).map(([k, label, d]) => (
            <button
              key={k}
              className={`hf-railitem ${page === k ? 'on' : ''}`}
              onClick={() => setPage(k)}
              title={railOpen ? undefined : label}
              aria-current={page === k ? 'page' : undefined}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d={d} />
              </svg>
              {railOpen && <span>{label}</span>}
            </button>
          ))}
        </div>

        {/* The tenant belongs down here, not in a top bar. It is set once and
            then read, so it is reference rather than navigation. */}
        <div className="hf-rail-foot">
          {railOpen ? (
            <>
              <label className="hf-rail-cap" htmlFor="hf-tenant">
                Tenant
              </label>
              <select id="hf-tenant" value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
                {!tenants.length && <option value="">Loading\u2026</option>}
                {tenants.map((t) => (
                  <option key={t.tenantId} value={t.tenantId}>
                    {t.displayName}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <span className="hf-rail-initial" title={tenant?.displayName ?? tenantId}>
              {(tenant?.displayName ?? tenantId ?? '?').slice(0, 2).toUpperCase()}
            </span>
          )}
        </div>
      </nav>

      <div className="hf-main">
        {tenantMismatch && (
          <div className="ds-switch-warn">
            <span>
              The open session was designed for <b>{tenantMismatch}</b>, not the selected tenant. It is kept as it is \u2014
              new runs will use <b>{tenant?.displayName ?? tenantId}</b>.
            </span>
            <button
              onClick={() => {
                clearSession();
                setTenantMismatch(null);
                window.location.reload();
              }}
            >
              Start a new campaign for this tenant
            </button>
          </div>
        )}

      <div className="ds-body">
        {bootError && (
          <div className="cd-configerr">
            <b>The local API is not reachable.</b>
            <p style={{ margin: '8px 0 0' }}>{bootError}</p>
            <p style={{ margin: '8px 0 0' }}>
              Start it with <code>npm run dev:designer</code> from the <code>drip-campaigns</code> directory.
            </p>
          </div>
        )}
        {!bootError && page === 'designer' && knowledge && tenant && (
          <CampaignDesigner
            // Remounts when the open chat changes, so every piece of
            // conversation state is rebuilt from the stored session rather
            // than half-updated in place.
            key={openChat ?? 'current'}
            knowledge={knowledge}
            tenant={tenant}
            sessionId={openChat}
            onSessionChange={setOpenChat}
            onLogsChanged={() => setLogs(loadRunLogs())}
          />
        )}
        {!bootError && page === 'designer' && (!knowledge || !tenant) && (
          <div style={{ padding: 30, fontSize: 13, color: 'var(--gray-600)' }}>Loading tenant and knowledge base…</div>
        )}
        {!bootError && page === 'knowledge' && knowledge && (
          <KnowledgeBaseView
            knowledge={knowledge}
            capabilities={capabilities}
            seed={seed}
            overrides={overrides}
            onOverrides={setOverrides}
            onReset={resetKnowledge}
            tenant={tenant}
          />
        )}
        {!bootError && page === 'logs' && (
          <RunLogsView
            logs={logs}
            onCleared={() => setLogs(loadRunLogs())}
            onStartDesigning={() => setPage('designer')}
            onResume={(id) => {
              setOpenChat(id);
              setPage('designer');
            }}
          />
        )}
      </div>
      </div>
    </>
  );
}
