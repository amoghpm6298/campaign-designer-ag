// Step 4 of 5 — exclusion lists, checked continuously at every node
// (unlike Re-entry on Basic Details, which is a one-time gate checked
// only at entry). Deliberately its own step, after Builder: these apply
// to a journey that already exists, and belong in what gets reviewed
// before submission. Kept to the two lists actually named — DNC and NPA
// — not a larger invented taxonomy (opt-outs stay always-on, mentioned
// on Basic Details, not configurable here).
import { ChipPicker } from '../components/ChipPicker';

const GUARDRAIL_OPTIONS = ['Do Not Contact (DNC)', 'Non-Performing Assets (NPA)'] as const;

export function GuardrailsStep({
  dnc,
  onDncChange,
  npa,
  onNpaChange,
  onSaveDraft,
  onContinue,
}: {
  dnc: boolean;
  onDncChange: (v: boolean) => void;
  npa: boolean;
  onNpaChange: (v: boolean) => void;
  onSaveDraft: () => void;
  onContinue: () => void;
}) {
  const selected = [...(dnc ? ['Do Not Contact (DNC)'] : []), ...(npa ? ['Non-Performing Assets (NPA)'] : [])];
  function onToggle(value: string) {
    if (value === 'Do Not Contact (DNC)') onDncChange(!dnc);
    if (value === 'Non-Performing Assets (NPA)') onNpaChange(!npa);
  }

  return (
    <div className="dcb-mid-inner">
      <h1 className="wiz-heading">Who should this campaign never reach?</h1>
      <p className="wiz-sub">This is checked at every step, not just entry. A match skips the rest of the journey.</p>

      <div className="wiz-section">
        <div className="wiz-group-label">Exclusion Lists</div>
        <ChipPicker options={[...GUARDRAIL_OPTIONS]} selected={selected} onToggle={onToggle} />
        <p className="f-hint" style={{ margin: '10px 0 0' }}>Both are on by default. Turn one off only if this campaign targets that group. For example, an NPA recovery campaign turns off NPA.</p>
      </div>

      <div className="dcb-step-footer">
        <button className="btn secondary" onClick={onSaveDraft}>
          Save as Draft
        </button>
        <button className="btn primary" onClick={onContinue}>
          Continue to Review →
        </button>
      </div>
    </div>
  );
}
