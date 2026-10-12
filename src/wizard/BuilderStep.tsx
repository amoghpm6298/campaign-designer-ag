// Step 3 of 4 — the canvas, beside the persistent left rail. Its own
// top bar (Undo/Redo + Continue to Review) lives in DripBuilder.tsx;
// Save as Draft/Submit for Approval and the on-demand validation banner
// both moved to the new Review step, so this component is just the
// canvas, nothing else.
import { DripCanvas } from '../canvas/DripCanvas';
import type { DripGraph, DripGoal } from '../data/graphTypes';

export function BuilderStep({
  graph,
  goal,
  onAddEntry,
  onEditNode,
  onRemoveRoot,
  onReplaceAuto,
  onRemoveEdge,
  onAddAtEdge,
  onAddAtGrowLeaf,
  onAddAtMidEdge,
  onAddParallel,
  onRenameEdge,
  onRemoveGoalCheck,
}: {
  graph: DripGraph;
  goal: DripGoal | null;
  onAddEntry: () => void;
  onEditNode: (nodeId: string) => void;
  onRemoveRoot: () => void;
  onReplaceAuto: (edgeId: string) => void;
  onRemoveEdge: (edgeId: string) => void;
  onAddAtEdge: (edgeId: string) => void;
  onAddAtGrowLeaf: (nodeId: string) => void;
  onAddAtMidEdge: (edgeId: string) => void;
  onAddParallel: (nodeId: string) => void;
  onRenameEdge: (edgeId: string, label: string) => void;
  onRemoveGoalCheck: (nodeId: string) => void;
}) {
  return (
    <>
      <div className="dcb-canvas">
        <DripCanvas
          graph={graph}
          goal={goal}
          editable
          onAddEntry={onAddEntry}
          onEditNode={onEditNode}
          onRemoveRoot={onRemoveRoot}
          onReplaceAuto={onReplaceAuto}
          onRemoveEdge={onRemoveEdge}
          onAddAtEdge={onAddAtEdge}
          onAddAtGrowLeaf={onAddAtGrowLeaf}
          onAddAtMidEdge={onAddAtMidEdge}
          onAddParallel={onAddParallel}
          onRenameEdge={onRenameEdge}
          onRemoveGoalCheck={onRemoveGoalCheck}
        />
      </div>
    </>
  );
}
