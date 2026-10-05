// Phase 3 — temporary verification harness: a campaign switcher (view
// mode) plus a "+ New Campaign" entry into the real builder. Phase 4
// replaces this with the real list page wiring persistence.
import { useState } from 'react';
import { DRIP_CAMPAIGNS } from './data/seedCampaigns';
import { DripCanvas } from './canvas/DripCanvas';
import { DripBuilder, type DripBuilderPayload } from './wizard/DripBuilder';

function App() {
  const [mode, setMode] = useState<'view' | 'create'>('view');
  const [selectedId, setSelectedId] = useState(DRIP_CAMPAIGNS[0].id);
  const [lastSaved, setLastSaved] = useState<DripBuilderPayload | null>(null);
  const campaign = DRIP_CAMPAIGNS.find((c) => c.id === selectedId)!;

  if (mode === 'create') {
    return (
      <DripBuilder
        onBack={() => setMode('view')}
        onSaveDraft={(payload) => {
          setLastSaved(payload);
          setMode('view');
        }}
        onSubmit={(payload) => {
          setLastSaved(payload);
          setMode('view');
        }}
      />
    );
  }

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
        <button className="btn primary" onClick={() => setMode('create')} id="newCampaignBtn">
          + New Campaign
        </button>
        {lastSaved && <span id="lastSavedIndicator" style={{ fontSize: 12, color: 'var(--gray-500)' }}>Last saved: {lastSaved.name} ({lastSaved.status})</span>}
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <DripCanvas graph={campaign.root!} editable={false} />
      </div>
    </div>
  );
}

export default App;
