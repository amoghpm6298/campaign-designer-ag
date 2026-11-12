// The standalone application shell: its own header, navigation and global
// tenant selector. Nothing here comes from the ib-face-mock chrome.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, Library, MessagesSquare, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import logo from '../assets/hfLogo.svg';
import {
  applyOverrides,
  loadOverrides,
  resetAll,
  type KnowledgeOverrides,
} from '../designer/knowledgeStore';
import { CampaignDesigner } from '../designer/CampaignDesigner';
import { DesignerV2 } from '../designer/v2/DesignerV2';
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
  // Which agent the Design page runs. v2 (one agent, one prompt) is the default;
  // v1 stays available for comparison while v2 is being tested.
  const [agentVersion, setAgentVersion] = useState<'v1' | 'v2'>(() => {
    try {
      return localStorage.getItem('cd-agent') === 'v1' ? 'v1' : 'v2';
    } catch {
      return 'v2';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('cd-agent', agentVersion);
    } catch {
      /* preference only */
    }
  }, [agentVersion]);
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
      {/* THE RAIL \u2014 agent360's `Sidebar`, ported.
          White, 60px collapsed, 256px expanded, with the preference kept.
          It used to be navy, argued for as "the one dark surface, product
          chrome rather than a theme". That argument held while this app was
          judged on its own; it does not hold next to the company console,
          whose rail is white. Matching the house style and keeping our own
          chrome were never both available. */}
      <aside
        className={`shrink-0 bg-white border-r border-border flex flex-col h-screen transition-[width] duration-200 ease-out ${
          railOpen ? 'w-64' : 'w-[60px]'
        }`}
      >
        {/* h-16, the height every pane header in this product now uses, so the
            rail's foot and the headers beside it sit on one line. */}
        <div className={`h-16 flex items-center shrink-0 ${railOpen ? 'px-4 gap-2.5' : 'justify-center'}`}>
          {railOpen && (
            <>
              {/* The mark keeps its own navy on a tinted chip rather than
                  being knocked out white on a blue one: at 18px the swoosh
                  inside it closes up and reads as a plain ring. */}
              <span className="flex flex-1 items-center gap-2.5 min-w-0">
                <span className="w-8 h-8 rounded-[10px] bg-primary-light grid place-items-center shrink-0">
                  <img src={logo} alt="" aria-hidden="true" width={19} height={19} />
                </span>
                <span className="leading-tight min-w-0">
                  {/* 12.5px semibold, not 14px bold: "Campaign Designer" is
                      six characters longer than the name this rail was sized
                      for, and at 14px it truncates inside a 256px drawer. */}
                  <span className="block text-text-primary font-semibold text-[12.5px] truncate">Campaign Designer</span>
                  <span className="block text-text-tertiary text-[11px]">Hyperface</span>
                </span>
              </span>
            </>
          )}
          <button
            onClick={() => setRailOpen((v) => !v)}
            title={railOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            aria-label={railOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            aria-expanded={railOpen}
            className="grid place-items-center w-8 h-8 rounded-lg text-text-tertiary hover:bg-surface-subtle hover:text-text-secondary shrink-0"
          >
            {railOpen ? <PanelLeftClose className="w-[18px] h-[18px]" /> : <PanelLeftOpen className="w-[18px] h-[18px]" />}
          </button>
        </div>

        <nav
          aria-label="Sections"
          className={`mt-2 flex-1 min-h-0 overflow-y-auto hf-scroll flex flex-col gap-1 ${
            railOpen ? 'px-3' : 'px-0 items-center'
          }`}
        >
          {(
            [
              ['designer', 'Design', Activity],
              ['knowledge', 'Knowledge Base', Library],
              ['logs', 'Chats', MessagesSquare],
            ] as [Page, string, typeof Activity][]
          ).map(([k, label, Icon]) => {
            const on = page === k;
            return (
              <button
                key={k}
                onClick={() => setPage(k)}
                title={label}
                aria-label={label}
                aria-current={on ? 'page' : undefined}
                className={`relative flex items-center rounded-lg transition-colors ${
                  railOpen ? 'gap-2.5 px-3 h-9 text-sm w-full' : 'justify-center w-9 h-9'
                } ${
                  on
                    ? 'bg-primary-light text-primary font-medium'
                    : 'text-[#667085] hover:bg-surface-subtle hover:text-text-secondary'
                }`}
              >
                {/* A 3px bar at the edge, not a filled row: at rail width a
                    solid fill on white reads as a button, not a selection. */}
                {on && <span className="absolute left-0 top-1.5 bottom-1.5 w-[3px] rounded-r bg-primary" />}
                <Icon className="w-[18px] h-[18px] shrink-0" />
                {railOpen && <span className="truncate">{label}</span>}
              </button>
            );
          })}
        </nav>

        {/* The tenant belongs down here, not in a top bar. It is set once and
            then read, so it is reference rather than navigation \u2014 the slot
            agent360 gives to identity. */}
        <div className={`border-t border-border shrink-0 ${railOpen ? 'px-3 py-3' : 'py-3'}`}>
          {railOpen ? (
            <div className="px-1">
              <label
                className="block mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary"
                htmlFor="hf-agent"
              >
                Agent
              </label>
              <select
                id="hf-agent"
                value={agentVersion}
                onChange={(e) => setAgentVersion(e.target.value === 'v1' ? 'v1' : 'v2')}
                className="w-full h-9 mb-3 px-2.5 text-[13px] rounded-[var(--radius-input)] border border-border bg-white text-text-primary focus:outline-none focus:border-[#8FB9F8] focus:shadow-[var(--shadow-focus-ring)]"
              >
                <option value="v2">v2 · one agent (new)</option>
                <option value="v1">v1 · staged (old)</option>
              </select>
              <label
                className="block mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary"
                htmlFor="hf-tenant"
              >
                Tenant
              </label>
              <select
                id="hf-tenant"
                value={tenantId}
                onChange={(e) => setTenantId(e.target.value)}
                className="w-full h-9 px-2.5 text-[13px] rounded-[var(--radius-input)] border border-border bg-white text-text-primary focus:outline-none focus:border-[#8FB9F8] focus:shadow-[var(--shadow-focus-ring)]"
              >
                {!tenants.length && <option value="">Loading\u2026</option>}
                {tenants.map((t) => (
                  <option key={t.tenantId} value={t.tenantId}>
                    {t.displayName}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <span
              className="mx-auto grid w-8 h-8 place-items-center rounded-full bg-primary-light text-primary text-[11.5px] font-bold"
              title={tenant?.displayName ?? tenantId}
            >
              {(tenant?.displayName ?? tenantId ?? '?').slice(0, 2).toUpperCase()}
            </span>
          )}
        </div>
      </aside>

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
        {!bootError && page === 'designer' && knowledge && tenant && agentVersion === 'v2' && (
          <DesignerV2 key={tenant.tenantId} knowledge={knowledge} tenant={tenant} />
        )}
        {!bootError && page === 'designer' && knowledge && tenant && agentVersion === 'v1' && (
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
