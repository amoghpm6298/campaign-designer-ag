// Step 4 of 4 — new, added alongside the vertical rail (Phase 3
// refinement). A plain read-back of what's about to be submitted, not a
// new data-entry surface — every field here is already set on an
// earlier step; this just confirms it before Save as Draft / Submit for
// Approval, which moved here from the Builder step's old top bar.
import { dcGoalLabel } from '../reducer/labelMeta';
import { DC_NODE_META } from '../data/nodeMeta';
import type { DripGoal, DripGraph } from '../data/graphTypes';

export function ReviewStep({
  name,
  description,
  issuer,
  applyToAllPrograms,
  programs,
  controlPct,
  startDate,
  endDate,
  allowReEntry,
  reEntryCooloffDuration,
  reEntryCooloffUnit,
  dnc,
  npa,
  goal,
  graph,
  validationMessage,
  onSaveDraft,
  onSubmit,
}: {
  name: string;
  description: string;
  issuer: string;
  applyToAllPrograms: boolean;
  programs: string[];
  controlPct: number;
  startDate: string;
  endDate: string;
  allowReEntry: boolean;
  reEntryCooloffDuration: number;
  reEntryCooloffUnit: 'days' | 'hours';
  dnc: boolean;
  npa: boolean;
  goal: DripGoal | null;
  graph: DripGraph;
  validationMessage: string | null;
  onSaveDraft: () => void;
  onSubmit: () => void;
}) {
  const entryNode = graph.rootId ? graph.nodes[graph.rootId] : null;
  const stepCount = Object.keys(graph.nodes).length;

  return (
    <div className="dcb-mid-inner">
      <h1 className="wiz-heading">Nice work! Let's do a final check</h1>
      <p className="wiz-sub">{name || 'Untitled campaign'}</p>

      {validationMessage && <div className="dcb-validation-banner">⚠ {validationMessage}</div>}

      <div className="wiz-section">
        <div className="wiz-group-label">Campaign</div>
        <div className="review-row-main">{name || <span className="dl-row-sub">Untitled campaign</span>}</div>
        {description && <div className="dl-row-sub">{description}</div>}
      </div>

      <div className="wiz-section">
        <div className="wiz-group-label">Scope</div>
        <div className="review-row-main">{issuer || <span className="dl-row-sub">No issuer set</span>}</div>
        {issuer && <div className="dl-row-sub">{applyToAllPrograms ? 'All current and future programs' : programs.length ? programs.join(', ') : 'No programs selected'}</div>}
      </div>

      <div className="wiz-section">
        <div className="wiz-group-label">Experimentation</div>
        <div className="review-row-main">{controlPct}% held back as control</div>
      </div>

      <div className="wiz-section">
        <div className="wiz-group-label">Re-entry</div>
        <div className="review-row-main">
          {allowReEntry
            ? reEntryCooloffDuration > 0
              ? `Allowed, ${reEntryCooloffDuration} ${reEntryCooloffUnit} after exit`
              : 'Allowed, immediately after exit'
            : 'Not allowed'}
        </div>
      </div>

      <div className="wiz-section">
        <div className="wiz-group-label">Schedule</div>
        <div className="review-row-main">{startDate ? `Starts ${startDate.replace('T', ' ')}` : 'Starts immediately once approved'}</div>
        {endDate && <div className="dl-row-sub">Ends {endDate.replace('T', ' ')}</div>}
      </div>

      <div className="wiz-section">
        <div className="wiz-group-label">Goal</div>
        <div className="review-row-main">{dcGoalLabel(goal) || <span className="dl-row-sub">No goal defined — independent checkpoints</span>}</div>
      </div>

      <div className="wiz-section">
        <div className="wiz-group-label">Journey</div>
        {entryNode ? (
          <>
            <div className="review-row-main">
              {DC_NODE_META[entryNode.type].type} · {entryNode.label}
            </div>
            <div className="dl-row-sub">
              {stepCount} step{stepCount === 1 ? '' : 's'} total
            </div>
          </>
        ) : (
          <div className="review-row-main">
            <span className="dl-row-sub">No entry step added yet</span>
          </div>
        )}
      </div>

      <div className="wiz-section">
        <div className="wiz-group-label">Guardrails</div>
        <div className="review-row-main">
          {dnc || npa ? [dnc && 'DNC', npa && 'NPA'].filter(Boolean).join(', ') : <span className="dl-row-sub">No exclusion lists applied</span>}
        </div>
      </div>

      <div className="dcb-step-footer">
        <button className="btn secondary" onClick={onSaveDraft}>
          Save as Draft
        </button>
        <button className="btn primary" onClick={onSubmit}>
          Submit for Approval
        </button>
      </div>
    </div>
  );
}
