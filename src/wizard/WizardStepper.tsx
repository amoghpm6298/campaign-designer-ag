// Persistent left rail, shared by all 4 create/edit steps — replaces
// the earlier single-row horizontal breadcrumb (Phase 2 refinement)
// per direct user request, modeled EXACTLY on this product's own
// Nudges/Batch/Incentive/AB creation flows (journeysnudgesemi's
// .wiz-step/.wiz-step-dot rail): same done/current/upcoming state
// names, same checkmark-on-done behavior, same dot+connecting-line
// structure (verified directly against that file's CSS/render
// functions, not approximated). Applied uniformly including the
// Builder step — a deliberate choice (flagged the canvas-width
// tradeoff from the earlier full-width-canvas decision, user chose to
// take it) rather than special-casing Builder.
const STEPS: { key: 'basicDetails' | 'goalDefinition' | 'builder' | 'guardrails' | 'review'; label: string }[] = [
  { key: 'basicDetails', label: 'Basic Details' },
  { key: 'goalDefinition', label: 'Goal' },
  { key: 'builder', label: 'Builder' },
  { key: 'guardrails', label: 'Guardrails' },
  { key: 'review', label: 'Review' },
];

export type DcBuilderStepKind = (typeof STEPS)[number]['key'];

export function WizardStepper({
  current,
  onNavigate,
  onBack,
  isStepComplete,
  isEditing,
}: {
  current: DcBuilderStepKind;
  onNavigate: (step: DcBuilderStepKind) => void;
  onBack: () => void;
  isStepComplete: (step: DcBuilderStepKind) => boolean;
  isEditing: boolean;
}) {
  const currentIdx = STEPS.findIndex((s) => s.key === current);
  return (
    <div className="dcb-rail">
      <div className="add-link" onClick={onBack}>
        ← Back to Drip Campaigns
      </div>
      <div className="wiz-group-label">{isEditing ? 'Edit Campaign' : 'New Campaign'}</div>
      <div className="dcb-vsteps">
        {STEPS.map((s, i) => {
          // Index-based, same as the reference rail: every step behind
          // the current one reads as done regardless of whether its own
          // data actually validates — that's what the amber dot below is
          // for, a second independent signal, not a replacement for it.
          const state = i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'upcoming';
          const incomplete = i < currentIdx && !isStepComplete(s.key);
          return (
            <div key={s.key} className="dcb-vstep" onClick={() => onNavigate(s.key)}>
              <div className="dcb-vstep-dotcol">
                <div className={`dcb-vstep-circle ${state}`}>{state === 'done' ? '✓' : i + 1}</div>
                {i < STEPS.length - 1 && <div className={`dcb-vstep-line ${state === 'done' ? 'done' : ''}`} />}
              </div>
              <div className="dcb-vstep-body">
                <div className={`dcb-vstep-label ${state}`}>
                  {s.label}
                  {incomplete && <span className="dcb-stepper-dot" title="Incomplete" />}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
