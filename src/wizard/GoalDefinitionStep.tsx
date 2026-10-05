// Step 2 of 3 — lifted out of the old GoalDrawer (opened from inside the
// canvas) into its own full-width step page, same plain-form treatment
// as Basic Details. Always optional — "a milestone-style campaign can
// legitimately have none" — so Continue is never blocked here. The form
// renders directly, no "+ Define Goal" click needed first: Basic Details
// doesn't gate its own fields behind an extra click, and neither should
// this — the only thing that makes a goal "real" is a non-empty event
// type, which is already how every other consumer (buildPayload, the
// header badge) decides whether a goal is actually set.
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
      <h1 className="wiz-heading">Define the Goal</h1>
      <p className="wiz-sub">
        Defined once, here — every auto-inserted goal-check after a Send, and any Split using "Goal reached," checks against this same event. Optional: a milestone-style campaign can legitimately have none.
      </p>

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
      <div className="f-group">
        <label className="f-label">Event Type</label>
        <select className="f-input" value={draft.eventType} onChange={(e) => onGoalChange({ ...draft, eventType: e.target.value })}>
          <option value="">Select event</option>
          {(EVENT_CATEGORIES[draft.eventCategory]?.events || []).map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </div>
      <p className="f-hint" style={{ margin: '0 0 4px' }}>
        The event firing at all usually isn't the real goal — e.g. EMI_STATUS_CHANGED fires on Failed too. Narrow it to the actual outcome.
      </p>
      <ConditionsSection conditions={draft.conditions} entity={DC_EVENT_ENTITY[draft.eventCategory] || null} onChange={(conditions) => onGoalChange({ ...draft, conditions })} />
      {goal && goal.eventType && (
        <div className="add-link" style={{ marginTop: 10 }} onClick={() => onGoalChange(null)}>
          Clear Goal
        </div>
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
