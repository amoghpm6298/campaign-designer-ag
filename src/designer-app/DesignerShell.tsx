// The standalone application shell: its own header, navigation and global
// tenant selector. Nothing here comes from the ib-face-mock chrome.
import { useCallback, useEffect, useState } from 'react';
import { CampaignDesigner } from '../designer/CampaignDesigner';
import { KnowledgeBaseView } from '../designer/KnowledgeBaseView';
import { RunLogsView } from '../designer/RunLogsView';
import { listTenants, seedKnowledge } from '../designer/api';
import {
  clearKnowledge,
  clearSession,
  loadKnowledge,
  loadRunLogs,
  loadSession,
  loadTenantId,
  saveKnowledge,
  saveTenantId,
} from '../designer/storage';
import type { Capabilities, KnowledgeBase, RunLog, Tenant } from '../designer/types';

type Page = 'designer' | 'knowledge' | 'logs';

export function DesignerShell() {
  const [page, setPage] = useState<Page>('designer');
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantId, setTenantId] = useState<string>(loadTenantId() ?? '');
  const [knowledge, setKnowledge] = useState<KnowledgeBase | null>(loadKnowledge());
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [logs, setLogs] = useState<RunLog[]>(loadRunLogs());
  const [bootError, setBootError] = useState<string | null>(null);
  /** Set when the chosen tenant differs from the one the open session began with. */
  const [tenantMismatch, setTenantMismatch] = useState<string | null>(null);

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
        setKnowledge((current) => {
          if (current) return current;
          saveKnowledge(seeded);
          return seeded;
        });
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

  const resetKnowledge = useCallback(() => {
    clearKnowledge();
    seedKnowledge().then(({ knowledge: seeded }) => {
      saveKnowledge(seeded);
      setKnowledge(seeded);
    });
  }, []);

  return (
    <>
      <header className="ds-header">
        <div className="ds-brand">
          <span className="ds-brand-name">Campaign Designer</span>
          <span className="ds-brand-sub">Hyperface · AI campaign design</span>
        </div>
        <nav className="ds-nav">
          {(
            [
              ['designer', 'Design'],
              ['knowledge', 'Knowledge Base'],
              ['logs', 'Run Logs'],
            ] as [Page, string][]
          ).map(([k, label]) => (
            <button key={k} className={`ds-navitem ${page === k ? 'on' : ''}`} onClick={() => setPage(k)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="ds-tenant">
          <span className="ds-tenant-label">Tenant</span>
          <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} aria-label="Tenant">
            {!tenants.length && <option value="">Loading…</option>}
            {tenants.map((t) => (
              <option key={t.tenantId} value={t.tenantId}>
                {t.displayName}
              </option>
            ))}
          </select>
          {tenant?.synthetic && <span className="ds-synth">Synthetic</span>}
        </div>
      </header>

      {tenantMismatch && (
        <div className="ds-switch-warn">
          <span>
            The open session was designed for <b>{tenantMismatch}</b>, not the selected tenant. It is kept as it is —
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
            knowledge={knowledge}
            tenant={tenant}
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
            onChange={setKnowledge}
            onReset={resetKnowledge}
            tenant={tenant}
          />
        )}
        {!bootError && page === 'logs' && (
          <RunLogsView
            logs={logs}
            onCleared={() => setLogs(loadRunLogs())}
            onStartDesigning={() => setPage('designer')}
          />
        )}
      </div>
    </>
  );
}
