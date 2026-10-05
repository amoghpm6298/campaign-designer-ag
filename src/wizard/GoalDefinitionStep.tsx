// Step 2 of 3 — lifted out of the old GoalDrawer (opened from inside the
// canvas) into its own full-width step page, same plain-form treatment
// as Basic Details. Always optional — "a milestone-style campaign can
// legitimately have none" — so Continue is never blocked here.
import { ConditionsSection } from './ConditionRows';
import { EVENT_CATEGORIES, DC_EVENT_ENTITY } from '../data/sharedConstants';
import type { DripGoal } from '../data/graphTypes';

export function GoalDefinitionStep({
  goal,
  onGoalChange,
  onBack,
  onSaveDraft,
  onContinue,
}: {
  goal: DripGoal | null;
  onGoalChange: (goal: DripGoal | null) => void;
  onBack: () => void;
  onSaveDraft: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="dcb-mid-inner">
      <div className="dcb-step-indicator">
        Step 2 of 3 — Goal Definition · <span className="add-link" style={{ display: 'inline', fontSize: 'inherit' }} onClick={onBack}>← Basic Details</span>
      </div>
      <h1 className="wiz-heading">Define the Goal</h1>
      <p className="wiz-sub">
        Defined once, here — every auto-inserted goal-check after a Send, and any Split using "Goal reached," checks against this same event. Optional: a milestone-style campaign can legitimately have none.
      </p>

      {!goal ? (
        <button
          className="btn secondary"
          onClick={() => onGoalChange({ eventCategory: Object.keys(EVENT_CATEGORIES)[0], eventType: '', conditions: [] })}
        >
          + Define Goal
        </button>
      ) : (
        <>
          <div className="f-group">
            <label className="f-label">Event Category</label>
            <select className="f-input" value={goal.eventCategory} onChange={(e) => onGoalChange({ ...goal, eventCategory: e.target.value, eventType: '' })}>
              {Object.keys(EVENT_CATEGORIES).map((k) => (
                <option key={k} value={k}>
                  {k}
                  {EVENT_CATEGORIES[k].isNew ? ' (New)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="f-group">
            <label className="f-label">Event Type</label>
            <select className="f-input" value={goal.eventType} onChange={(e) => onGoalChange({ ...goal, eventType: e.target.value })}>
              <option value="">Select event</option>
              {(EVENT_CATEGORIES[goal.eventCategory]?.events || []).map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </div>
          <p className="f-hint" style={{ margin: '0 0 4px' }}>
            The event firing at all usually isn't the real goal — e.g. EMI_STATUS_CHANGED fires on Failed too. Narrow it to the actual outcome.
          </p>
          <ConditionsSection conditions={goal.conditions} entity={DC_EVENT_ENTITY[goal.eventCategory] || null} onChange={(conditions) => onGoalChange({ ...goal, conditions })} />
          <div className="add-link" style={{ marginTop: 10 }} onClick={() => onGoalChange(null)}>
            Remove Goal
          </div>
        </>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 32 }}>
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
