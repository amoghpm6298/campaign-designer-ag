// Custom edge component rendering a branch-label chip at the edge's
// midpoint via React Flow's own <EdgeLabelRenderer> — the React-idiomatic
// equivalent of the original's manually-centered <foreignObject>. React
// Flow computes the midpoint itself (getSmoothStepPath), so the chip-
// overlap and chip-centering bugs this migration exists to fix can't
// recur here by construction, not by a hand-tuned fix.
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath, type EdgeProps } from '@xyflow/react';

export interface DripEdgeData {
  branchLabel: string;
  editable: boolean;
  onRemove?: () => void;
  // Mid-insert — only ever set for an edge that already connects two real
  // nodes (see toFlowElements.ts).
  onInsert?: () => void;
  // Present only on the read-only Analytics view.
  statLabel?: string;
  [key: string]: unknown;
}

export function DripEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps & { data?: DripEdgeData }) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 8 });
  const branchLabel = data?.branchLabel || '';
  const hasLabel = !!branchLabel;
  const editable = !!data?.editable;
  const statLabel = data?.statLabel;
  const onInsert = data?.onInsert;
  if (!hasLabel && !editable && !statLabel) {
    return <BaseEdge id={id} path={edgePath} style={{ stroke: 'var(--gray-300)', strokeWidth: 2 }} />;
  }
  return (
    <>
      <BaseEdge id={id} path={edgePath} style={{ stroke: 'var(--gray-300)', strokeWidth: 2 }} />
      <EdgeLabelRenderer>
        <div
          className={`dc-branch-label${!hasLabel && editable ? ' dc-branch-label-bare' : ''}`}
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: editable || onInsert ? 'auto' : 'none',
            cursor: 'default',
          }}
        >
          {hasLabel ? branchLabel : ''}
          {statLabel && <span className="stat">{statLabel}</span>}
          {onInsert && (
            <span className="dc-edge-insert" onClick={onInsert} title="Insert a step here">
              +
            </span>
          )}
          {editable && (
            <span style={{ opacity: 0.55, marginLeft: hasLabel || onInsert ? 2 : 0, cursor: 'pointer' }} onClick={data?.onRemove} title="Remove this connection">
              ✕
            </span>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const dripEdgeTypes = { dcEdge: DripEdge };
