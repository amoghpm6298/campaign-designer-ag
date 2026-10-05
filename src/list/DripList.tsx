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
      <div className="page-header">
        <div>
          <h1 className="page-title">Drip Campaigns</h1>
          <p className="page-sub">{campaigns.length} campaigns</p>
        </div>
        <button className="btn primary" onClick={onCreate} id="newCampaignBtn">
          + Create Drip Campaign
        </button>
      </div>
      <div className="card" style={{ paddingBottom: 12 }}>
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
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Issuer</th>
                <th>Goal</th>
                <th>Entry</th>
                <th>Sends</th>
                <th>Control</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const sm = DRIP_STATUS_META[c.status];
                const entryMeta = c.root?.rootId ? DC_NODE_META[c.root.nodes[c.root.rootId].type] : null;
                return (
                  <tr key={c.id} onClick={() => onOpen(c)}>
                    <td>
                      <b>{c.name}</b>
                    </td>
                    <td>{c.issuer || '—'}</td>
                    <td>{dcGoalLabel(c.goal) || 'None — independent checkpoints'}</td>
                    <td>{entryMeta ? entryMeta.type : '— no entry set —'}</td>
                    <td>{c.root ? dcCountSends(c.root) : '—'}</td>
                    <td>{c.controlPct ? c.controlPct + '%' : '—'}</td>
                    <td>
                      <span className={`badge ${sm.badge}`}>{sm.label}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
