// Step 3 of 3 — the canvas itself, full-width. The header (back link,
// stepper, Undo/Redo/Save/Submit) now lives entirely in the shared
// WizardStepper row in DripBuilder.tsx — this component is just the
// on-demand validation banner plus the canvas, nothing else.
import { DripCanvas } from '../canvas/DripCanvas';
import type { DripGraph } from '../data/graphTypes';

export function BuilderStep({
  graph,
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
  graph: DripGraph;
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
