// Ported from dcConnectExistingHtml — "Connect to an Existing Step":
// points a branch at a step already built elsewhere, instead of
// duplicating it.
import { useState } from 'react';
import { DC_NODE_META } from '../data/nodeMeta';
import type { DripNode } from '../data/graphTypes';

export function ConnectExisting({ targets, selectedId, onSelect }: { targets: DripNode[]; selectedId: string | null; onSelect: (id: string) => void }) {
  const [search, setSearch] = useState('');
  const q = search.toLowerCase();
  const filtered = targets.filter((nd) => !q || nd.label.toLowerCase().includes(q) || DC_NODE_META[nd.type].type.toLowerCase().includes(q));
  return (
    <>
      <p className="f-hint" style={{ marginTop: 0 }}>
        Pick a step already built elsewhere in this campaign. Nothing gets duplicated — this branch will lead into that exact step, and editing it from anywhere updates it everywhere.
      </p>
      <div className="f-group">
        <label className="f-label">Search steps</label>
        <input className="f-input" type="text" placeholder="Type a step name..." value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid var(--gray-200)', borderRadius: 8 }}>
        {filtered.length ? (
          filtered.map((nd) => (
            <div
              key={nd.id}
              onClick={() => onSelect(nd.id)}
              style={{ padding: '9px 12px', cursor: 'pointer', borderBottom: '1px solid var(--gray-100)', background: selectedId === nd.id ? 'var(--info-bg)' : undefined }}
            >
              <div style={{ fontSize: 9.5, fontWeight: 700, textTransform: 'uppercase', color: 'var(--gray-500)' }}>{DC_NODE_META[nd.type].type}</div>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>{nd.label}</div>
            </div>
          ))
        ) : (
          <div style={{ padding: 14, color: 'var(--gray-500)', fontSize: 12.5 }}>No matching steps{search ? ` for "${search}"` : ''}.</div>
        )}
      </div>
    </>
  );
}
