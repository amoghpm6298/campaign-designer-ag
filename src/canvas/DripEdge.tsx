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
  [key: string]: unknown;
}

export function DripEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps & { data?: DripEdgeData }) {
  const [edgePath, labelX, labelY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 8 });
  const branchLabel = data?.branchLabel || '';
  const hasLabel = !!branchLabel;
  const editable = !!data?.editable;
  if (!hasLabel && !editable) {
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
            pointerEvents: editable ? 'auto' : 'none',
            cursor: editable ? 'pointer' : 'default',
          }}
          onClick={editable ? data?.onRemove : undefined}
          title={editable ? 'Remove this connection' : undefined}
        >
          {hasLabel ? branchLabel : ''}
          {editable && <span style={{ opacity: 0.55, marginLeft: hasLabel ? 2 : 0 }}>✕</span>}
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const dripEdgeTypes = { dcEdge: DripEdge };
