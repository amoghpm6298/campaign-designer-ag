// Custom edge component rendering a branch-label chip at the edge's
// midpoint via React Flow's own <EdgeLabelRenderer> — the React-idiomatic
// equivalent of the original's manually-centered <foreignObject>. React
// Flow computes the midpoint itself (getSmoothStepPath), so the chip-
// overlap and chip-centering bugs this migration exists to fix can't
// recur here by construction, not by a hand-tuned fix.
import { useEffect, useRef, useState } from 'react';
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
  // Set only for a fan-out node's own edges, whose labels have no other
  // owner (see toFlowElements.ts) — a routing node's labels come from its
  // config and are never editable here.
  onRename?: (label: string) => void;
  [key: string]: unknown;
}

export function DripEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps & { data?: DripEdgeData }) {
  // dagre's barycenter layout can leave a straight single-parent chain
  // a couple px off-center from rank to rank (nudged by sibling
  // branches elsewhere in the same graph), which getSmoothStepPath then
  // renders as a visible little jog instead of a straight line even
  // though the nodes read as vertically aligned. Snapping a near-zero
  // dx to exactly zero forces the path straight — real branch offsets
  // (tens of px) are untouched.
  const alignedTargetX = Math.abs(targetX - sourceX) < 3 ? sourceX : targetX;
  const [edgePath, midX, midY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX: alignedTargetX, targetY, targetPosition, borderRadius: 8 });
  const branchLabel = data?.branchLabel || '';
  const hasLabel = !!branchLabel;
  const editable = !!data?.editable;
  const statLabel = data?.statLabel;
  const onInsert = data?.onInsert;
  const onRename = data?.onRename;
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(branchLabel);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (renaming) inputRef.current?.focus();
  }, [renaming]);
  // Re-sync whenever the committed label changes underneath (undo/redo,
  // or a reload of a saved campaign) — without this, reopening the input
  // would show a stale draft from a previous edit.
  useEffect(() => {
    setDraft(branchLabel);
  }, [branchLabel]);
  const commit = () => {
    setRenaming(false);
    if (draft.trim() !== branchLabel) onRename?.(draft);
  };
  // A parallel path's name sits just above the step it leads to, not at
  // the path's geometric midpoint like every other label. Fan-out
  // children are spread wide apart, so a smooth-step path between them
  // has a long horizontal run — and the midpoint lands right in it, where
  // the chip's opaque fill severs the connector and the whole thing reads
  // as a broken box rather than a labeled line. Anchoring to the target
  // also just says the true thing more directly: the name belongs to the
  // path arriving at THIS step. Routing labels (Yes/No, branch arms) keep
  // the midpoint — those are short, near-vertical drops where a chip
  // reads correctly as sitting on the line.
  const anchorToTarget = !!onRename;
  const labelX = anchorToTarget ? targetX : midX;
  const labelY = anchorToTarget ? targetY - 15 : midY;
  if (!hasLabel && !editable && !statLabel) {
    return <BaseEdge id={id} path={edgePath} style={{ stroke: 'var(--gray-300)', strokeWidth: 1.5 }} />;
  }
  return (
    <>
      <BaseEdge id={id} path={edgePath} style={{ stroke: 'var(--gray-300)', strokeWidth: 1.5 }} />
      <EdgeLabelRenderer>
        <div
          className={`dc-branch-label${!hasLabel && editable && !onRename ? ' dc-branch-label-bare' : ''}`}
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            pointerEvents: editable || onInsert || onRename ? 'auto' : 'none',
            cursor: 'default',
          }}
        >
          {onRename && renaming ? (
            <input
              ref={inputRef}
              className="dc-branch-label-input"
              value={draft}
              placeholder="Name this path"
              onChange={(ev) => setDraft(ev.target.value)}
              onBlur={commit}
              onKeyDown={(ev) => {
                if (ev.key === 'Enter') commit();
                if (ev.key === 'Escape') {
                  setDraft(branchLabel);
                  setRenaming(false);
                }
              }}
              onClick={(ev) => ev.stopPropagation()}
            />
          ) : onRename ? (
            // A fan-out path with no name yet still needs somewhere to
            // click — an empty chip would be invisible, so it reads as a
            // muted prompt until it's named.
            <span className={`dc-branch-label-text${hasLabel ? '' : ' placeholder'}`} onClick={() => setRenaming(true)} title="Click to name this path">
              {hasLabel ? branchLabel : '+ Name'}
            </span>
          ) : (
            hasLabel && branchLabel
          )}
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
