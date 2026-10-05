// Shared step indicator across all 3 create/edit steps — replaces the
// previous per-step "Step X of 3" text plus the Builder step's separate
// "Edit Setup"/"Edit Goal" text links with one consistent, always-visible,
// clickable stepper. All 3 steps are always navigable: Basic Details only
// gates the *forward* Continue button on having a name, same as before —
// jumping backward/forward via the stepper itself was never unsafe (Save
// as Draft already works from any step regardless of completeness).
const STEPS: { key: 'basicDetails' | 'goalDefinition' | 'builder'; label: string }[] = [
  { key: 'basicDetails', label: 'Basic Details' },
  { key: 'goalDefinition', label: 'Goal Definition' },
  { key: 'builder', label: 'Builder' },
];

export function WizardStepper({ current, onNavigate }: { current: 'basicDetails' | 'goalDefinition' | 'builder'; onNavigate: (step: 'basicDetails' | 'goalDefinition' | 'builder') => void }) {
  const currentIdx = STEPS.findIndex((s) => s.key === current);
  return (
    <div className="dcb-stepper">
      {STEPS.map((s, i) => (
        <div key={s.key} className="dcb-stepper-item-wrap">
          <div className={`dcb-stepper-item${s.key === current ? ' current' : ''}${i < currentIdx ? ' done' : ''}`} onClick={() => onNavigate(s.key)}>
            <span className="dcb-stepper-num">{i + 1}</span>
            {s.label}
          </div>
          {i < STEPS.length - 1 && <span className="dcb-stepper-sep" />}
        </div>
      ))}
    </div>
  );
}
