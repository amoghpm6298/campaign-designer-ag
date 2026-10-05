// Phase 2 — read-only canvas, rendering all 6 ported seed campaigns via
// React Flow + dagre. Replaces the Phase 0 pipeline-spike placeholder.
// A real list/view-page UI is Phase 4 work — this is intentionally a
// minimal campaign switcher for visual verification.
import { useState } from 'react';
import { DRIP_CAMPAIGNS } from './data/seedCampaigns';
import { DripCanvas } from './canvas/DripCanvas';

function App() {
  const [selectedId, setSelectedId] = useState(DRIP_CAMPAIGNS[0].id);
  const campaign = DRIP_CAMPAIGNS.find((c) => c.id === selectedId)!;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', fontFamily: '-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif' }}>
      <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--gray-200)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <strong>Drip Campaigns</strong>
        <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} style={{ padding: '4px 8px' }}>
          {DRIP_CAMPAIGNS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.id} — {c.name} ({c.status})
            </option>
          ))}
        </select>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <DripCanvas graph={campaign.root!} editable={false} />
      </div>
    </div>
  );
}

export default App;
