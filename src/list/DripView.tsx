// Ported from renderDripView/dripCampaignAction — read-only campaign
// view with status actions (approve/pause/resume/kill/edit-new-version).
import { useState } from 'react';
import { DRIP_STATUS_META } from '../data/statusMeta';
import { dcCountSends } from '../reducer/graphOps';
import { dcGoalLabel } from '../reducer/labelMeta';
import { DripCanvas } from '../canvas/DripCanvas';
import { Modal } from '../components/Modal';
import type { DripCampaign } from '../data/graphTypes';

export function DripView({
  campaign,
  allCampaigns,
  onBack,
  onAction,
  onEditNewVersion,
  onOpenVersion,
}: {
  campaign: DripCampaign;
  allCampaigns: DripCampaign[];
  onBack: () => void;
  onAction: (id: string, action: 'approve' | 'pause' | 'kill-confirmed') => void;
  onEditNewVersion: (c: DripCampaign) => void;
  onOpenVersion: (id: string) => void;
}) {
  const [killConfirmOpen, setKillConfirmOpen] = useState(false);
  const c = campaign;
  const sm = DRIP_STATUS_META[c.status];

  const priorVersion = c.versionOf ? allCampaigns.find((x) => x.id === c.versionOf) : null;
  const newerVersion = allCampaigns.find((x) => x.versionOf === c.id);
  const versionNote = priorVersion ? (
    <p className="f-hint" style={{ margin: '6px 0 0' }}>
      New version of{' '}
      <a href="#" onClick={(e) => { e.preventDefault(); onOpenVersion(priorVersion.id); }}>
        {priorVersion.name}
      </a>{' '}
      — pending approval, doesn't affect customers already enrolled on the live version.
    </p>
  ) : newerVersion ? (
    <p className="f-hint" style={{ margin: '6px 0 0' }}>
      A newer version of this campaign is pending approval — this version keeps running for everyone already enrolled until then.
    </p>
  ) : null;

  return (
    <div style={{ padding: 24 }}>
      <div className="page-header">
        <button className="btn secondary" style={{ marginBottom: 10 }} onClick={onBack}>
          ← Back to Drip Campaigns
        </button>
        <h1 className="page-title">
          {c.name} <span className={`badge ${sm.badge}`} style={{ marginLeft: 8, verticalAlign: 'middle' }}>{sm.label}</span>
        </h1>
        <p className="page-sub">
          {c.issuer || 'No issuer set'}
          {c.programs?.length ? ' · ' + c.programs.join(', ') : ''} · Goal: {dcGoalLabel(c.goal) ? `${dcGoalLabel(c.goal)} (${c.goal!.eventCategory})` : 'None — independent checkpoints'} · Control Group:{' '}
          {c.controlPct ? c.controlPct + '%' : 'None'} · {c.root ? dcCountSends(c.root) : 0} sends
        </p>
        {versionNote}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          {c.status === 'PENDING_REVIEW' && (
            <button className="btn primary" onClick={() => onAction(c.id, 'approve')}>
              {c.startDate ? `Approve (starts ${c.startDate.replace('T', ' ')})` : 'Approve & Activate'}
            </button>
          )}
          {['ACTIVE', 'PAUSED', 'SCHEDULED'].includes(c.status) && (
            <button className="btn secondary" onClick={() => onAction(c.id, 'pause')}>
              {c.status === 'PAUSED' ? 'Resume' : 'Pause'}
            </button>
          )}
          {['ACTIVE', 'PAUSED', 'SCHEDULED', 'PENDING_REVIEW'].includes(c.status) && (
            <button className="btn secondary" onClick={() => onEditNewVersion(c)}>
              Edit (new version)
            </button>
          )}
          {['ACTIVE', 'PAUSED', 'SCHEDULED'].includes(c.status) && (
            <button className="btn danger" onClick={() => setKillConfirmOpen(true)}>
              Kill Switch
            </button>
          )}
        </div>
      </div>
      <div className="card" style={{ padding: 0, marginTop: 16, height: '70vh', border: '1px solid var(--gray-200)', borderRadius: 10, overflow: 'hidden' }}>
        <DripCanvas graph={c.root!} editable={false} />
      </div>

      <Modal open={killConfirmOpen} onClose={() => setKillConfirmOpen(false)}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 10 }}>Kill switch — "{c.name}"</div>
        <p style={{ fontSize: 13, color: 'var(--gray-600)', lineHeight: 1.5 }}>
          This immediately exits <b>every customer currently enrolled</b>, regardless of where they are in the sequence. Not the same as Pause — there's no resuming from this. Use it only for a real
          incident (e.g. a template that shouldn't have gone out).
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10, marginTop: 16 }}>
          <button className="btn secondary" onClick={() => setKillConfirmOpen(false)}>
            Cancel
          </button>
          <button
            className="btn danger"
            onClick={() => {
              setKillConfirmOpen(false);
              onAction(c.id, 'kill-confirmed');
            }}
          >
            Kill this campaign
          </button>
        </div>
      </Modal>
    </div>
  );
}
