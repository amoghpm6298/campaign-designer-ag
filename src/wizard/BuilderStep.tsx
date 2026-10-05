// Step 3 of 3 — the canvas itself, now full-width: the old `.dcb-rail`
// (campaign summary, Goal button, guidance text, open-branch warning,
// "steps so far" outline, Save/Submit — 320px, permanently visible) is
// gone. Replaced with a slim top header bar (name, goal summary,
// Undo/Redo, Save/Submit) and an on-demand validation banner that only
// appears after a blocked Submit attempt — checked directly against how
// Braze/MoEngage/CleverTap's own canvas-builder screens work: where they
// have a sidebar at all, it's a node palette or an on-demand errors
// panel, never a permanent summary column. Navigating back to Basic
// Details/Goal Definition is the shared WizardStepper's job now, not a
// pair of text links living here.
import { dcGoalLabel } from '../reducer/labelMeta';
import { DripCanvas } from '../canvas/DripCanvas';
import type { DripGoal, DripGraph } from '../data/graphTypes';

export function BuilderStep({
  name,
  issuer,
  goal,
  graph,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onBack,
  onSaveDraft,
  onSubmitClick,
  validationMessage,
  onAddEntry,
  onEditNode,
  onRemoveRoot,
  onReplaceAuto,
  onRemoveEdge,
  onAddAtEdge,
  onAddAtGrowLeaf,
  onAddAtMidEdge,
}: {
  name: string;
  issuer: string;
  goal: DripGoal | null;
  graph: DripGraph;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onBack: () => void;
  onSaveDraft: () => void;
  onSubmitClick: () => void;
  validationMessage: string | null;
  onAddEntry: () => void;
  onEditNode: (nodeId: string) => void;
  onRemoveRoot: () => void;
  onReplaceAuto: (edgeId: string) => void;
  onRemoveEdge: (edgeId: string) => void;
  onAddAtEdge: (edgeId: string) => void;
  onAddAtGrowLeaf: (nodeId: string) => void;
  onAddAtMidEdge: (edgeId: string) => void;
}) {
  return (
    <>
      <div className="dcb-header">
        <div className="add-link" onClick={onBack}>
          ← Back to Drip Campaigns
        </div>
        <div className="dcb-header-name">{name || 'Untitled Campaign'}</div>
        {issuer && <span className="badge gray">{issuer}</span>}
        {goal && goal.eventType ? (
          <span className="badge success">
            Goal: {dcGoalLabel(goal)} <span style={{ opacity: 0.75, fontWeight: 400 }}>({goal.eventCategory})</span>
          </span>
        ) : (
          <span className="f-hint" style={{ margin: 0 }}>
            No goal set
          </span>
        )}

        <div className="dcb-header-spacer" />

        <button className="btn secondary small" disabled={!canUndo} onClick={onUndo} title="Undo">
          ↶ Undo
        </button>
        <button className="btn secondary small" disabled={!canRedo} onClick={onRedo} title="Redo">
          ↷ Redo
        </button>
        <button className="btn secondary" onClick={onSaveDraft}>
          Save as Draft
        </button>
        <button className="btn primary" onClick={onSubmitClick}>
          Submit for Approval
        </button>
      </div>

      {validationMessage && <div className="dcb-validation-banner">⚠ {validationMessage}</div>}

      <div className="dcb-canvas">
        <DripCanvas
          graph={graph}
          editable
          onAddEntry={onAddEntry}
          onEditNode={onEditNode}
          onRemoveRoot={onRemoveRoot}
          onReplaceAuto={onReplaceAuto}
          onRemoveEdge={onRemoveEdge}
          onAddAtEdge={onAddAtEdge}
          onAddAtGrowLeaf={onAddAtGrowLeaf}
          onAddAtMidEdge={onAddAtMidEdge}
        />
      </div>
    </>
  );
}
