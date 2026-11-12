// Clicking a message on the canvas: what the customer sees, when, on which
// channel, and why the agent put it there.
import { X } from 'lucide-react';
import { CHANNEL_LABEL, sendTitle, sendWhen, type CStep } from './canvasModel';

export function NodeDrawer({ step, bucketName, onClose }: { step: CStep; bucketName: string; onClose: () => void }) {
  const ch = (step.channelPreference ?? [])[0] ?? 'SMS';
  const fb = step.fallbackChannel;
  return (
    <aside className="cv-drawer" aria-label="Message preview">
      <header>
        <div>
          <div className="cv-drawer-kicker">{bucketName}</div>
          <b>{sendTitle({ ...step, name: step.name || step.label })}</b>
        </div>
        <button className="cv-icon-btn" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </header>
      <div className="cv-phone">
        <div className="cv-phone-top">{CHANNEL_LABEL[ch] ?? ch}</div>
        <div className="cv-phone-msg">
          {step.copy || <span className="v2-muted">No customer copy written yet. Intent: {step.describe}</span>}
          {step.cta && <div className="cv-phone-cta">{step.cta}</div>}
        </div>
      </div>
      <dl className="cv-drawer-facts">
        <div>
          <dt>When</dt>
          <dd>{sendWhen(step)}</dd>
        </div>
        <div>
          <dt>Channel</dt>
          <dd>
            {CHANNEL_LABEL[ch] ?? ch}
            {fb ? `, then ${CHANNEL_LABEL[fb] ?? fb} if not delivered` : ''}
          </dd>
        </div>
        {step.describe && (
          <div>
            <dt>Why this message</dt>
            <dd>{step.describe}</dd>
          </div>
        )}
        <div>
          <dt>Template</dt>
          <dd>The bank's approved template id is still needed before this can send.</dd>
        </div>
      </dl>
      <p className="v2-muted cv-drawer-hint">To change this message, ask in the chat.</p>
    </aside>
  );
}
