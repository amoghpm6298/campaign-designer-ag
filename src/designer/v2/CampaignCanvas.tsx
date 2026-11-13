// The campaign on a canvas: the entry on top, one column per bucket (checked
// left to right, first match wins), each bucket's own flow below its card.
// Pan, zoom, a minimap and fit-to-view come from React Flow.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, BaseEdge, Controls, EdgeLabelRenderer, getSmoothStepPath, MiniMap, ReactFlow, ReactFlowProvider, useNodesInitialized, useNodesState, useReactFlow, useStore, type Edge, type EdgeProps, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '../../canvas/dripCanvas.css';
import { buildCanvasModel, FIXED_SHAPES, NODE_H, type CNodeKind } from './canvasModel';
import { cdNodeTypes, EditContext, type CdNodeData, type EditApi } from './canvasNodes';
import type { ChangeMap } from './canvasModel';
import type { CampaignContext, CampaignObject } from './types';

const MINI: Partial<Record<CNodeKind, string>> = {
  entry: '#0a66ef',
  bucket: '#fcb022',
  everyone: '#98a2b3',
  send: '#0a66ef',
  holdout: '#6941c6',
  experiment: '#6941c6',
  branch: '#fcb022',
  condition: '#fcb022',
  goalcheck: '#9aa3e6',
};

/**
 * A path. Its label sits just above the card it leads to, not at the line's
 * midpoint: after a branch the lines run sideways, and a midpoint label lands
 * somewhere unrelated (or on top of another one).
 */
function CvEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps) {
  const tx = Math.abs(targetX - sourceX) < 3 ? sourceX : targetX;
  const [path] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX: tx, targetY, targetPosition, borderRadius: 10 });
  const label = (data as { label?: string } | undefined)?.label;
  return (
    <>
      <BaseEdge id={id} path={path} style={{ stroke: '#c3c9d3', strokeWidth: 1.5 }} />
      {label && (
        <EdgeLabelRenderer>
          <div className="cv-edge-label" style={{ transform: `translate(-50%, -100%) translate(${tx}px, ${targetY - 6}px)` }}>
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const cvEdgeTypes = { cv: CvEdge };

interface Props {
  campaign: CampaignObject | null | undefined;
  context: CampaignContext | null | undefined;
  changed: Set<string> | ChangeMap;
  /** Centre on this node; `n` changes on every request so the same node can be asked for twice. */
  focus?: { id: string; n: number } | null;
  onOpenNode?: (id: string) => void;
  /** Point-and-edit: which box is being edited, and the hooks every box uses. */
  edit?: EditApi;
  onPaneClick?: () => void;
  /** The issuer's name, shown as the sender in message previews. */
  bankName?: string;
}

function Inner({ campaign, context, changed, focus, onOpenNode, edit, onPaneClick, bankName }: Props) {
  const measured = useRef<Record<string, number>>({});
  const [tick, setTick] = useState(0);
  const model = useMemo(() => buildCanvasModel(campaign, context, changed, measured.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [campaign, context, changed, tick]);
  const goalText = campaign?.goal ? `${campaign.goal.eventType}?` : undefined;

  const modelNodes: Node[] = useMemo(
    () =>
      model.nodes.map((n) => ({
        id: n.id,
        type: 'cd',
        position: { x: n.x, y: n.y },
        data: { ...n.data, width: n.width, ...(FIXED_SHAPES.includes(n.data.kind) ? { height: NODE_H[n.data.kind] } : {}), goalText, bankName } satisfies CdNodeData,
        draggable: false,
        connectable: false,
        selectable: n.data.kind === 'send',
      })),
    [model, goalText, bankName],
  );
  const edges: Edge[] = useMemo(() => {
    // A step with several routes sends each one out of its own side: the
    // leftmost from the left corner, the rightmost from the right corner, the
    // rest from the bottom — so a third route (e.g. "Anything else") is
    // clearly its own line, not a split off another.
    const x = new Map(model.nodes.map((n) => [n.id, n.x + n.width / 2]));
    const out = new Map<string, typeof model.edges>();
    for (const e of model.edges) out.set(e.source, [...(out.get(e.source) ?? []), e]);
    const handle = new Map<string, string | undefined>();
    for (const [, list] of out) {
      if (list.length < 2 || list[0].source === 'entry') continue;
      const sorted = [...list].sort((a, b) => (x.get(a.target) ?? 0) - (x.get(b.target) ?? 0));
      handle.set(sorted[0].id, 'sl');
      handle.set(sorted[sorted.length - 1].id, 'sr');
    }
    return model.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(handle.get(e.id) ? { sourceHandle: handle.get(e.id) } : {}),
      type: 'cv',
      data: { label: e.label ?? '' },
    }));
  }, [model]);

  // React Flow keeps the nodes so it can measure them; positions come from the model.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(modelNodes);
  useEffect(() => {
    setNodes((prev) => {
      const old = new Map(prev.map((n) => [n.id, n]));
      return modelNodes.map((n) => {
        const o = old.get(n.id);
        return o?.measured ? { ...n, measured: o.measured } : n;
      });
    });
  }, [modelNodes, setNodes]);

  const rf = useReactFlow();
  const paneW = useStore((st) => st.width);
  // Open on the top of the campaign at a size you can read: the entry and the
  // bucket cards across, the flows running down. ⤢ still fits everything.
  const openTop = () => {
    const b = rf.getNodesBounds(rf.getNodes());
    if (!b.width || !paneW) return;
    const zoom = Math.max(0.6, Math.min(0.85, (paneW - 40) / b.width));
    const fits = b.width * zoom <= paneW - 40;
    rf.setViewport({ x: fits ? paneW / 2 - (b.x + b.width / 2) * zoom : 28 - b.x * zoom, y: 24 - b.y * zoom, zoom }, { duration: 250 });
  };
  const ready = useNodesInitialized();
  // Fit the whole campaign when its shape changes (a bucket added or removed),
  // not on every small edit, so the manager's own zoom is kept. Waits for the
  // layout to settle on real card heights first.
  const shape = model.nodes.filter((n) => n.data.kind === 'bucket' || n.data.kind === 'entry' || n.data.kind === 'everyone').map((n) => n.id).join('|');
  const lastShape = useRef('');

  // Cards are drawn at estimated heights first; once the browser has measured
  // them, lay out again with the real heights. Stable after a pass or two.
  useEffect(() => {
    if (!ready) return;
    let moved = false;
    for (const n of nodes) {
      const h = n.measured?.height;
      if (h && Math.abs((measured.current[n.id] ?? 0) - h) > 2) {
        measured.current[n.id] = h;
        moved = true;
      }
    }
    if (moved) {
      setTick((t) => t + 1);
      return;
    }
    if (shape && shape !== lastShape.current) {
      lastShape.current = shape;
      requestAnimationFrame(openTop);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, nodes, shape, rf]);

  const editingId = edit?.editingId ?? null;
  useEffect(() => {
    if (!editingId) return;
    const n = rf.getNode(editingId);
    if (!n) return;
    const w = n.measured?.width ?? 300;
    const h = n.measured?.height ?? 120;
    rf.setCenter(n.position.x + w / 2 + 200, n.position.y + h / 2, { zoom: 1, duration: 450 });
  }, [editingId, rf]);

  useEffect(() => {
    if (!focus) return;
    if (focus.id === '__fit__') {
      rf.fitView({ padding: 0.08, duration: 350, maxZoom: 0.9 });
      return;
    }
    const n = rf.getNode(focus.id);
    if (!n) return;
    const w = n.measured?.width ?? 300;
    const h = n.measured?.height ?? 120;
    rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom: 1, duration: 450 });
  }, [focus, rf]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      nodeTypes={cdNodeTypes}
      edgeTypes={cvEdgeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      minZoom={0.15}
      maxZoom={1.6}
      onNodeClick={(_, n) => !edit?.editingId && (n.data as CdNodeData).kind === 'send' && onOpenNode?.(n.id)}
      onPaneClick={onPaneClick}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={16} size={1} />
      <Controls showInteractive={false} position="bottom-left" />
      <MiniMap
        pannable
        zoomable
        position="bottom-right"
        className="cv-minimap"
        nodeColor={(n) => ((n.data as CdNodeData).changed ? '#027a48' : (MINI[(n.data as CdNodeData).kind] ?? '#d0d5dd'))}
        nodeStrokeWidth={0}
        maskColor="rgba(228, 231, 236, 0.55)"
      />
    </ReactFlow>
  );
}

export function CampaignCanvas(props: Props) {
  return (
    <div className={`cv-canvas dc-graph-wrap${props.edit?.editingId ? ' cv-focus-mode' : ''}`}>
      <EditContext.Provider value={props.edit ?? null}>
      <ReactFlowProvider>
        <Inner {...props} />
      </ReactFlowProvider>
      </EditContext.Provider>
    </div>
  );
}
