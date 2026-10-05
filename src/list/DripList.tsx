// Ported from renderDripList — status filter is deliberately disabled,
// matching the original ("Filtering wires up once the builder ships" —
// now that it has, this is left as-is rather than quietly expanding
// scope beyond what's being migrated).
import { DRIP_STATUS_META } from '../data/statusMeta';
import { DC_NODE_META } from '../data/nodeMeta';
import { dcCountSends } from '../reducer/graphOps';
import { dcGoalLabel } from '../reducer/labelMeta';
import type { DripCampaign } from '../data/graphTypes';

export function DripList({ campaigns, onOpen, onCreate }: { campaigns: DripCampaign[]; onOpen: (c: DripCampaign) => void; onCreate: () => void }) {
  return (
    <div style={{ padding: 24 }}>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
        <div>
          <h1 className="page-title" style={{ fontSize: 20, fontWeight: 700, margin: 0 }}>
            Drip Campaigns
          </h1>
          <p className="page-sub" style={{ fontSize: 13, color: 'var(--gray-500)', margin: '4px 0 0' }}>
            {campaigns.length} campaigns
          </p>
        </div>
        <button className="btn primary" onClick={onCreate} id="newCampaignBtn">
          + Create Drip Campaign
        </button>
      </div>
      <div style={{ marginBottom: 16 }}>
        <select disabled title="Filtering wires up once the builder ships">
          <option value="">Filter by status</option>
          {Object.entries(DRIP_STATUS_META).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </select>
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', fontSize: 11, textTransform: 'uppercase', color: 'var(--table-head, var(--gray-500))', borderBottom: '1px solid var(--gray-200)' }}>
            <th style={{ padding: '8px 10px' }}>Name</th>
            <th style={{ padding: '8px 10px' }}>Issuer</th>
            <th style={{ padding: '8px 10px' }}>Goal</th>
            <th style={{ padding: '8px 10px' }}>Entry</th>
            <th style={{ padding: '8px 10px' }}>Sends</th>
            <th style={{ padding: '8px 10px' }}>Control</th>
            <th style={{ padding: '8px 10px' }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c) => {
            const sm = DRIP_STATUS_META[c.status];
            const entryMeta = c.root?.rootId ? DC_NODE_META[c.root.nodes[c.root.rootId].type] : null;
            return (
              <tr key={c.id} onClick={() => onOpen(c)} style={{ cursor: 'pointer', borderBottom: '1px solid var(--gray-100)' }}>
                <td style={{ padding: '10px' }}>
                  <b>{c.name}</b>
                </td>
                <td style={{ padding: '10px' }}>{c.issuer || '—'}</td>
                <td style={{ padding: '10px' }}>{dcGoalLabel(c.goal) || 'None — independent checkpoints'}</td>
                <td style={{ padding: '10px' }}>{entryMeta ? entryMeta.type : '— no entry set —'}</td>
                <td style={{ padding: '10px' }}>{c.root ? dcCountSends(c.root) : '—'}</td>
                <td style={{ padding: '10px' }}>{c.controlPct ? c.controlPct + '%' : '—'}</td>
                <td style={{ padding: '10px' }}>
                  <span className={`badge ${sm.badge}`}>{sm.label}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
