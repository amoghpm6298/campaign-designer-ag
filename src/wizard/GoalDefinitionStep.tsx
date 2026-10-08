// Step 2 of 4 — lifted out of the old GoalDrawer (opened from inside the
// canvas) into its own full-width step page, same plain-form treatment
// as Basic Details.
//
// Phase 3 (creation-flow refinement): reframed around the user's actual
// question — "what counts as success for this campaign?" — rather than
// exposing Event Category/Event Type as if this were a generic event
// picker. The form is always open (an earlier pass gated it behind a
// "Define a goal" click on an intentional empty-state card — removed
// per direct user feedback: there's no reason to require an extra click
// before reaching a form that's reachable from a single rail click
// anyway). Leaving Event Type unset still means no goal, same as
// before — only the entry point changed, not the underlying semantics.
//
// Event Category / Event Type keep their existing (backend-shaped)
// labels deliberately — the brief that drove this pass asked for
// consistency with the Event picker inside the Journey Builder over a
// prettier-but-divergent vocabulary here, and the Builder's own Entry/
// Wait-for-Event forms still say "Event Category"/"Event Type" (out of
// scope for this pass), so changing just this screen's labels would
// create a second, inconsistent vocabulary rather than fix one.
import { ConditionsSection } from './ConditionRows';
import { EVENT_CATEGORIES, DC_EVENT_ENTITY } from '../data/sharedConstants';
import type { DripGoal } from '../data/graphTypes';

const BLANK_GOAL: DripGoal = { eventCategory: Object.keys(EVENT_CATEGORIES)[0], eventType: '', conditions: [] };

export function GoalDefinitionStep({
  goal,
  onGoalChange,
  onSaveDraft,
  onContinue,
}: {
  goal: DripGoal | null;
  onGoalChange: (goal: DripGoal | null) => void;
  onSaveDraft: () => void;
  onContinue: () => void;
}) {
  const draft = goal ?? BLANK_GOAL;

  return (
    <div className="dcb-mid-inner">
      <h1 className="wiz-heading">What outcome should count as success?</h1>
      <p className="wiz-sub">Choose the event that counts as success. Not every campaign needs one.</p>

      <div className="wiz-section">
        <div className="wiz-group-label">Goal Event</div>
        <div className="f-group">
          <label className="f-label">Event Category</label>
          <select className="f-input" value={draft.eventCategory} onChange={(e) => onGoalChange({ ...draft, eventCategory: e.target.value, eventType: '' })}>
            {Object.keys(EVENT_CATEGORIES).map((k) => (
              <option key={k} value={k}>
                {k}
                {EVENT_CATEGORIES[k].isNew ? ' (New)' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="f-group" style={{ marginBottom: 6 }}>
          <label className="f-label">Event Type</label>
          <select className="f-input" value={draft.eventType} onChange={(e) => onGoalChange({ ...draft, eventType: e.target.value })}>
            <option value="">No goal — leave unset</option>
            {(EVENT_CATEGORIES[draft.eventCategory]?.events || []).map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>
        <p className="f-hint" style={{ margin: 0 }}>Not every firing is success. For example, EMI_STATUS_CHANGED also fires on Failed. Narrow it below if needed.</p>
      </div>

      <div className="wiz-section">
        <div className="wiz-group-label">Goal Conditions</div>
        <ConditionsSection conditions={draft.conditions} entity={DC_EVENT_ENTITY[draft.eventCategory] || null} onChange={(conditions) => onGoalChange({ ...draft, conditions })} />
      </div>

      <p className="f-hint" style={{ margin: '0 0 8px' }}>Goal Check steps on the canvas use this same goal to branch the journey.</p>

      <div className="dcb-step-footer">
        <button className="btn secondary" onClick={onSaveDraft}>
          Save as Draft
        </button>
        <button className="btn primary" onClick={onContinue}>
          Continue to Builder →
        </button>
      </div>
    </div>
  );
}
