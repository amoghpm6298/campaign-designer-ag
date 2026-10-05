// Ported from dcRenderGoalDrawer/dcOpenGoalDrawer/dcConfirmGoal — defined
// once, here, every auto-inserted goal-check Split and the "Goal reached"
// basis both check against this same event.
import { SideDrawer, SideDrawerHead, SideDrawerFoot } from '../components/SideDrawer';
import { ConditionsSection } from './ConditionRows';
import { EVENT_CATEGORIES, DC_EVENT_ENTITY } from '../data/sharedConstants';
import type { DripGoal } from '../data/graphTypes';

export function GoalDrawer({ open, draft, onChange, onCancel, onSave }: { open: boolean; draft: DripGoal; onChange: (patch: Partial<DripGoal>) => void; onCancel: () => void; onSave: () => void }) {
  return (
    <SideDrawer open={open} widthPx={520} onClose={onCancel}>
      <SideDrawerHead title="Define Goal" onClose={onCancel} />
      <div className="sd-body">
        <p className="f-hint" style={{ marginTop: 0 }}>
          Defined once, here — every auto-inserted goal-check after a Send, and any Split using "Goal reached," checks against this same event. Change it here, not per-step.
        </p>
        <div className="f-group">
          <label className="f-label">Event Category</label>
          <select className="f-input" value={draft.eventCategory} onChange={(e) => onChange({ eventCategory: e.target.value, eventType: '' })}>
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
          <select className="f-input" value={draft.eventType} onChange={(e) => onChange({ eventType: e.target.value })}>
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
        <ConditionsSection conditions={draft.conditions} entity={DC_EVENT_ENTITY[draft.eventCategory] || null} onChange={(conditions) => onChange({ conditions })} />
      </div>
      <SideDrawerFoot onCancel={onCancel} onPrimary={onSave} primaryLabel="Save Goal" primaryDisabled={!draft.eventType} />
    </SideDrawer>
  );
}
