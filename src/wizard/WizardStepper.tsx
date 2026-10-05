// Shared step indicator + back link, one single row across all 3
// create/edit steps — previously a separate stepper bar stacked on top
// of a second header bar (with its own back link, campaign name, and a
// "No goal set" text label), which read as two redundant headers. Now
// one row, and a step's own completion is shown ON the stepper itself
// (a thin amber ring around a visited-but-empty step's number) instead
// of restating it in text elsewhere — "Basic Details" with no amber
// ring IS "name is set," there's no need to also print the name.
const STEPS: { key: 'basicDetails' | 'goalDefinition' | 'builder'; label: string }[] = [
  { key: 'basicDetails', label: 'Basic Details' },
  { key: 'goalDefinition', label: 'Goal Definition' },
  { key: 'builder', label: 'Builder' },
];

export function WizardStepper({
  current,
  onNavigate,
  onBack,
  isStepComplete,
  children,
}: {
  current: 'basicDetails' | 'goalDefinition' | 'builder';
  onNavigate: (step: 'basicDetails' | 'goalDefinition' | 'builder') => void;
  onBack: () => void;
  isStepComplete: (step: 'basicDetails' | 'goalDefinition' | 'builder') => boolean;
  // Builder-only action buttons (Undo/Redo/Save/Submit) — rendered on
  // the right of this same row only when the caller passes them, so
  // Basic Details/Goal Definition don't show empty space for buttons
  // that don't apply yet.
  children?: React.ReactNode;
}) {
  const currentIdx = STEPS.findIndex((s) => s.key === current);
  return (
    <div className="dcb-header">
      <div className="add-link" onClick={onBack}>
        ← Back to Drip Campaigns
      </div>
      <div className="dcb-stepper">
        {STEPS.map((s, i) => {
          const visited = i < currentIdx;
          const complete = isStepComplete(s.key);
          return (
            <div key={s.key} className="dcb-stepper-item-wrap">
              <div className={`dcb-stepper-item${s.key === current ? ' current' : ''}${visited && complete ? ' done' : ''}`} onClick={() => onNavigate(s.key)}>
                <span className={`dcb-stepper-num${visited && !complete ? ' incomplete' : ''}`}>{i + 1}</span>
                {s.label}
              </div>
              {i < STEPS.length - 1 && <span className="dcb-stepper-sep" />}
            </div>
          );
        })}
      </div>
      <div className="dcb-header-spacer" />
      {children}
    </div>
  );
}
