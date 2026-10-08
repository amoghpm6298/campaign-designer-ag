// Phase 3 (creation-flow refinement): the campaign list becomes the
// operational home for Drip Campaigns rather than a raw CRUD table —
// "how many do I have / which need attention / how do I find one
// quickly." Everything here is derived from the existing campaign
// collection already passed in; no new backend data, no invented
// fields. One real limitation worth flagging: there's no "last
// updated" timestamp anywhere in the current DripCampaign model (only
// startDate/endDate, which mean something else — when it's scheduled
// to run, not when it was last edited) — so that column from the brief
// is intentionally left out rather than faked with a fabricated date.
import { useMemo, useState } from 'react';
import { DRIP_STATUS_META } from '../data/statusMeta';
import { DC_NODE_META, type DcNodeType } from '../data/nodeMeta';
import { dcGoalLabel } from '../reducer/labelMeta';
import type { DripCampaign, DripCampaignStatus } from '../data/graphTypes';

type KpiKey = 'total' | 'ACTIVE' | 'PENDING_REVIEW' | 'DRAFT' | 'PAUSED';

export function DripList({ campaigns, onOpen, onCreate }: { campaigns: DripCampaign[]; onOpen: (c: DripCampaign) => void; onCreate: () => void }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<DripCampaignStatus | ''>('');
  const [issuerFilter, setIssuerFilter] = useState('');
  const [programFilter, setProgramFilter] = useState('');
  const [entryFilter, setEntryFilter] = useState<DcNodeType | ''>('');
  const [goalFilter, setGoalFilter] = useState<'' | 'has' | 'none'>('');

  const issuers = useMemo(() => [...new Set(campaigns.map((c) => c.issuer).filter(Boolean))].sort(), [campaigns]);
  const programs = useMemo(() => [...new Set(campaigns.flatMap((c) => c.programs || []))].sort(), [campaigns]);

  const entryTypeOf = (c: DripCampaign): DcNodeType | null => (c.root?.rootId ? c.root.nodes[c.root.rootId].type : null);

  const kpis: Record<KpiKey, number> = useMemo(
    () => ({
      total: campaigns.length,
      ACTIVE: campaigns.filter((c) => c.status === 'ACTIVE').length,
      PENDING_REVIEW: campaigns.filter((c) => c.status === 'PENDING_REVIEW').length,
      DRAFT: campaigns.filter((c) => c.status === 'DRAFT').length,
      PAUSED: campaigns.filter((c) => c.status === 'PAUSED').length,
    }),
    [campaigns],
  );

  const filtered = campaigns.filter((c) => {
    if (search && !c.name.toLowerCase().includes(search.toLowerCase())) return false;
    if (statusFilter && c.status !== statusFilter) return false;
    if (issuerFilter && c.issuer !== issuerFilter) return false;
    if (programFilter && !(c.programs || []).includes(programFilter)) return false;
    if (entryFilter && entryTypeOf(c) !== entryFilter) return false;
    if (goalFilter === 'has' && !c.goal) return false;
    if (goalFilter === 'none' && c.goal) return false;
    return true;
  });

  const hasActiveFilters = !!(search || statusFilter || issuerFilter || programFilter || entryFilter || goalFilter);
  function clearFilters() {
    setSearch('');
    setStatusFilter('');
    setIssuerFilter('');
    setProgramFilter('');
    setEntryFilter('');
    setGoalFilter('');
  }

  return (
    <div style={{ padding: 24 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Drip Campaigns</h1>
          <p className="page-sub">
            {hasActiveFilters ? `${filtered.length} of ${campaigns.length} campaigns` : `${campaigns.length} campaigns`}
          </p>
        </div>
        <button className="btn primary" onClick={onCreate} id="newCampaignBtn">
          + Create Drip Campaign
        </button>
      </div>

      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Total</div>
          <div className="kpi-value">{kpis.total}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Active</div>
          <div className="kpi-value">{kpis.ACTIVE}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Pending Approval</div>
          <div className="kpi-value">{kpis.PENDING_REVIEW}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Draft</div>
          <div className="kpi-value">{kpis.DRAFT}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Paused</div>
          <div className="kpi-value">{kpis.PAUSED}</div>
        </div>
      </div>

      <div className="filters">
        <input type="text" placeholder="Search campaigns" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as DripCampaignStatus | '')}>
          <option value="">Status: Any</option>
          {Object.entries(DRIP_STATUS_META).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
        <select value={issuerFilter} onChange={(e) => setIssuerFilter(e.target.value)}>
          <option value="">Issuer: Any</option>
          {issuers.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
        <select value={programFilter} onChange={(e) => setProgramFilter(e.target.value)}>
          <option value="">Program: Any</option>
          {programs.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <select value={entryFilter} onChange={(e) => setEntryFilter(e.target.value as DcNodeType | '')}>
          <option value="">Entry: Any</option>
          <option value="ENTRY_EVENT">{DC_NODE_META.ENTRY_EVENT.type}</option>
          <option value="ENTRY_SEGMENT">{DC_NODE_META.ENTRY_SEGMENT.type}</option>
        </select>
        <select value={goalFilter} onChange={(e) => setGoalFilter(e.target.value as '' | 'has' | 'none')}>
          <option value="">Goal: Any</option>
          <option value="has">Has a goal</option>
          <option value="none">No goal</option>
        </select>
        {hasActiveFilters && (
          <div className="add-link quiet" onClick={clearFilters}>
            Clear filters
          </div>
        )}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Issuer / Program</th>
              <th>Goal</th>
              <th>Entry</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const sm = DRIP_STATUS_META[c.status];
              const entryType = entryTypeOf(c);
              const entryMeta = entryType ? DC_NODE_META[entryType] : null;
              const entryLabel = c.root?.rootId ? c.root.nodes[c.root.rootId].label : null;
              return (
                <tr key={c.id} onClick={() => onOpen(c)}>
                  <td>
                    <b>{c.name}</b>
                    {c.description && <div className="dl-row-sub">{c.description}</div>}
                  </td>
                  <td>
                    {c.issuer || '—'}
                    {c.programs?.length ? <div className="dl-row-sub">{c.programs.join(', ')}</div> : null}
                  </td>
                  <td>{dcGoalLabel(c.goal) || <span className="dl-row-sub">None — independent checkpoints</span>}</td>
                  <td>
                    {entryMeta ? entryMeta.type : <span className="dl-row-sub">— no entry set —</span>}
                    {entryLabel && <div className="dl-row-sub">{entryLabel}</div>}
                  </td>
                  <td>
                    <span className={`badge ${sm.badge}`}>{sm.label}</span>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: '32px 12px', color: 'var(--gray-500)', cursor: 'default' }}>
                  No campaigns match your filters.{' '}
                  <span className="add-link" style={{ display: 'inline', marginLeft: 4 }} onClick={clearFilters}>
                    Clear filters
                  </span>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
