// Step 1 of 3 — plain sequential form page, no rail. Checked directly
// against Braze/MoEngage/CleverTap's own setup screens: all three treat
// campaign/journey setup as a simple form, not a persistent rail+content
// layout (that pattern belongs to composing one message with a literal
// preview, e.g. this app's Nudges wizard — it doesn't transfer here).
import { PROGRAM_OPTIONS, computeMakerCheckerFlag } from '../data/sharedConstants';
import { ChipPicker } from '../components/ChipPicker';

export function BasicDetailsStep({
  isEditing,
  name,
  onNameChange,
  description,
  onDescriptionChange,
  issuer,
  onIssuerChange,
  programs,
  onProgramsChange,
  controlPct,
  onControlPctChange,
  startDate,
  onStartDateChange,
  endDate,
  onEndDateChange,
  onSaveDraft,
  onContinue,
  onSkipToBuilder,
}: {
  isEditing: boolean;
  name: string;
  onNameChange: (v: string) => void;
  description: string;
  onDescriptionChange: (v: string) => void;
  issuer: string;
  onIssuerChange: (v: string) => void;
  programs: string[];
  onProgramsChange: (v: string[]) => void;
  controlPct: number;
  onControlPctChange: (v: number) => void;
  startDate: string;
  onStartDateChange: (v: string) => void;
  endDate: string;
  onEndDateChange: (v: string) => void;
  onSaveDraft: () => void;
  onContinue: () => void;
  onSkipToBuilder: () => void;
}) {
  return (
    <div className="dcb-mid-inner">
      <div className="dcb-step-indicator">Step 1 of 3 — Basic Details</div>
      <h1 className="wiz-heading">{isEditing ? 'Edit Drip Campaign' : 'New Drip Campaign'}</h1>
      <p className="wiz-sub">Set identity, scope, and launch settings — you'll define the goal and build the flow next.</p>

      <div className="wiz-group-label">Identity</div>
      <div className="f-group">
        <label className="f-label">Campaign name</label>
        <input className="f-input" type="text" value={name} onChange={(e) => onNameChange(e.target.value)} />
      </div>
      <div className="f-group">
        <label className="f-label">
          Description <span style={{ fontWeight: 400, color: 'var(--gray-500)' }}>(optional)</span>
        </label>
        <textarea
          className="f-input"
          rows={3}
          value={description}
          onChange={(e) => onDescriptionChange(e.target.value)}
          placeholder="What this campaign is for, in a sentence or two"
        />
      </div>

      <div className="wiz-group-label">Scope</div>
      <div className="f-row2" style={{ alignItems: 'start' }}>
        <div className="f-group">
          <label className="f-label">Issuer</label>
          <select
            className="f-input"
            value={issuer}
            onChange={(e) => {
              onIssuerChange(e.target.value);
              onProgramsChange([]);
            }}
          >
            <option value="">Select Issuer</option>
            {Object.keys(PROGRAM_OPTIONS).map((i) => (
              <option key={i}>{i}</option>
            ))}
          </select>
        </div>
        <div className="f-group">
          <label className="f-label">Program(s)</label>
          {issuer ? (
            <ChipPicker options={PROGRAM_OPTIONS[issuer] || []} selected={programs} onToggle={(v) => onProgramsChange(programs.includes(v) ? programs.filter((x) => x !== v) : [...programs, v])} />
          ) : (
            <p className="f-hint" style={{ margin: '8px 0 0' }}>
              Select an issuer first
            </p>
          )}
        </div>
      </div>
      {issuer && computeMakerCheckerFlag(issuer, programs) && (
        <p className="f-hint" style={{ color: 'var(--warning-text)', marginTop: -8 }}>
          Maker-checker applies — this issuer/program requires a separate approver.
        </p>
      )}

      <div className="wiz-group-label">Launch Settings</div>
      <div className="f-group" style={{ maxWidth: 200 }}>
        <label className="f-label">Control Group %</label>
        <input className="f-input" type="number" min={0} max={50} value={controlPct} onChange={(e) => onControlPctChange(Number(e.target.value))} />
      </div>
      <div className="f-row2">
        <div className="f-group">
          <label className="f-label">Start</label>
          <input className="f-input" type="datetime-local" value={startDate} onChange={(e) => onStartDateChange(e.target.value)} />
        </div>
        <div className="f-group">
          <label className="f-label">End</label>
          <input className="f-input" type="datetime-local" value={endDate} onChange={(e) => onEndDateChange(e.target.value)} />
        </div>
      </div>
      <p className="f-hint" style={{ marginTop: -10 }}>
        Control Group is held back as a baseline for uplift. Leave Start blank to activate immediately once approved — a future Start holds it as Scheduled until then.
      </p>
      <p className="f-hint" style={{ background: 'var(--gray-50)', padding: '10px 12px', borderRadius: 6, marginTop: 14 }}>
        🛡 DNC and opt-outs are checked automatically before every send in this campaign — not something you configure per step, same as Nudges.
      </p>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 32 }}>
        <button className="btn secondary" disabled={!name} onClick={onSaveDraft}>
          Save as Draft
        </button>
        <button className="btn primary" disabled={!name} onClick={onContinue}>
          Continue to Goal →
        </button>
        <div className="add-link" style={{ marginLeft: 'auto' }} onClick={onSkipToBuilder}>
          Skip to Builder →
        </div>
      </div>
    </div>
  );
}
