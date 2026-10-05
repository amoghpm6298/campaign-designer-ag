// Top-level routing + campaign persistence (in-memory, matching the
// original's own no-backend prototype convention). Ported from
// openDripCreate/openDripEditDraft/openDripEdit/dripCampaignAction/
// saveDripCampaign.
import { useState } from 'react';
import { DRIP_CAMPAIGNS as SEED_CAMPAIGNS } from './data/seedCampaigns';
import type { DripCampaign } from './data/graphTypes';
import { dcResetIdCounters, dcSeedIdCountersFrom } from './reducer/idGen';
import { DripList } from './list/DripList';
import { DripView } from './list/DripView';
import { DripBuilder, type DripBuilderPayload } from './wizard/DripBuilder';
import { Toast, type ToastState } from './components/Toast';
import { Sidebar } from './components/Sidebar';

type ViewState =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'editDraft'; id: string }
  | { kind: 'editNewVersion'; original: DripCampaign }
  | { kind: 'view'; id: string };

function nextId(campaigns: DripCampaign[]): string {
  const max = Math.max(0, ...campaigns.map((c) => parseInt(c.id.split('-')[1], 10) || 0));
  return 'DRIP-' + String(max + 1).padStart(3, '0');
}

export function DripCampaignsApp() {
  const [campaigns, setCampaigns] = useState<DripCampaign[]>(SEED_CAMPAIGNS);
  const [view, setView] = useState<ViewState>({ kind: 'list' });
  const [toast, setToast] = useState<ToastState | null>(null);

  function openCreate() {
    dcResetIdCounters();
    setView({ kind: 'create' });
  }
  function openRow(c: DripCampaign) {
    if (c.status === 'DRAFT') {
      if (c.root) dcSeedIdCountersFrom(c.root);
      setView({ kind: 'editDraft', id: c.id });
    } else {
      setView({ kind: 'view', id: c.id });
    }
  }
  function openEditNewVersion(c: DripCampaign) {
    if (c.root) dcSeedIdCountersFrom(c.root);
    setView({ kind: 'editNewVersion', original: c });
  }

  function handleSaveDraft(payload: DripBuilderPayload) {
    if (view.kind === 'editDraft') {
      setCampaigns((cs) => cs.map((c) => (c.id === view.id ? { ...c, ...payload, id: c.id } : c)));
      setToast({ message: `"${payload.name}" saved as draft.` });
    } else {
      const id = nextId(campaigns);
      setCampaigns((cs) => [...cs, { id, ...payload, versionOf: null }]);
      setToast({ message: `"${payload.name}" saved as draft.` });
    }
    setView({ kind: 'list' });
  }

  function handleSubmit(payload: DripBuilderPayload) {
    if (view.kind === 'editDraft') {
      // Never went live — edited in place, no versioning needed.
      setCampaigns((cs) => cs.map((c) => (c.id === view.id ? { ...c, ...payload, id: c.id } : c)));
      setToast({ message: `"${payload.name}" submitted for approval.` });
    } else if (view.kind === 'editNewVersion') {
      const id = nextId(campaigns);
      setCampaigns((cs) => [...cs, { id, ...payload, versionOf: view.original.id }]);
      setToast({ message: `"${payload.name}" submitted for approval as a new version.` });
    } else {
      const id = nextId(campaigns);
      setCampaigns((cs) => [...cs, { id, ...payload, versionOf: null }]);
      setToast({ message: `"${payload.name}" submitted for approval.` });
    }
    setView({ kind: 'list' });
  }

  function handleAction(id: string, action: 'approve' | 'pause' | 'kill-confirmed') {
    setCampaigns((cs) =>
      cs.map((c) => {
        if (c.id !== id) return c;
        if (action === 'pause') {
          const status = c.status === 'PAUSED' ? (c.startDate ? 'SCHEDULED' : 'ACTIVE') : 'PAUSED';
          setToast({ message: status === 'PAUSED' ? `"${c.name}" paused — new entries stop, in-flight customers freeze at their current step.` : `"${c.name}" resumed.` });
          return { ...c, status };
        }
        if (action === 'kill-confirmed') {
          setToast({ message: `"${c.name}" killed — every enrolled customer has been exited.`, type: 'error' });
          return { ...c, status: 'KILLED' };
        }
        if (action === 'approve') {
          const status = c.startDate ? 'SCHEDULED' : 'ACTIVE';
          setToast({ message: status === 'SCHEDULED' ? `"${c.name}" approved — scheduled to start ${(c.startDate || '').replace('T', ' ')}.` : `"${c.name}" approved and active.` });
          return { ...c, status };
        }
        return c;
      }),
    );
  }

  let body: React.ReactNode;
  if (view.kind === 'list') {
    body = <DripList campaigns={campaigns} onOpen={openRow} onCreate={openCreate} />;
  } else if (view.kind === 'create') {
    body = <DripBuilder onBack={() => setView({ kind: 'list' })} onSaveDraft={handleSaveDraft} onSubmit={handleSubmit} />;
  } else if (view.kind === 'editDraft') {
    const c = campaigns.find((x) => x.id === view.id)!;
    body = <DripBuilder initial={c} onBack={() => setView({ kind: 'list' })} onSaveDraft={handleSaveDraft} onSubmit={handleSubmit} />;
  } else if (view.kind === 'editNewVersion') {
    // Start/End Date deliberately reset, not inherited — a new version's
    // activation timing is its own fresh decision, not a copy-forward.
    const { startDate: _startDate, endDate: _endDate, ...rest } = view.original;
    void _startDate;
    void _endDate;
    body = <DripBuilder initial={{ ...rest, startDate: '', endDate: '' }} onBack={() => setView({ kind: 'list' })} onSaveDraft={handleSaveDraft} onSubmit={handleSubmit} />;
  } else {
    const c = campaigns.find((x) => x.id === view.id)!;
    body = (
      <DripView
        campaign={c}
        allCampaigns={campaigns}
        onBack={() => setView({ kind: 'list' })}
        onAction={handleAction}
        onEditNewVersion={openEditNewVersion}
        onOpenVersion={(id) => setView({ kind: 'view', id })}
      />
    );
  }

  return (
    <>
      <Sidebar />
      <div id="dc-main">{body}</div>
      <Toast toast={toast} onDismiss={() => setToast(null)} />
    </>
  );
}
