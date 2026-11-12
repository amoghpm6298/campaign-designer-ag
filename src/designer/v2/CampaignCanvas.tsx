// The campaign on a canvas: the entry on top, one column per bucket (checked
// left to right, first match wins), each bucket's own flow below its card.
// Pan, zoom, a minimap and fit-to-view come from React Flow.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Background, Controls, MiniMap, ReactFlow, ReactFlowProvider, useNodesInitialized, useNodesState, useReactFlow, useStore, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '../../canvas/dripCanvas.css';
import { dripEdgeTypes } from '../../canvas/DripEdge';
import { buildCanvasModel, type CNodeKind } from './canvasModel';
import { cdNodeTypes, type CdNodeData } from './canvasNodes';
import type { PlanFile } from './types';

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

interface Props {
  planFile: PlanFile | null | undefined;
  changed: Set<string>;
  /** Centre on this node; `n` changes on every request so the same node can be asked for twice. */
  focus?: { id: string; n: number } | null;
  onOpenNode?: (id: string) => void;
}

function Inner({ planFile, changed, focus, onOpenNode }: Props) {
  const measured = useRef<Record<string, number>>({});
  const [tick, setTick] = useState(0);
  const model = useMemo(() => buildCanvasModel(planFile, changed, measured.current),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [planFile, changed, tick]);
  const goalText = planFile?.campaign?.goal ? `${planFile.campaign.goal.eventType}?` : undefined;

  const modelNodes: Node[] = useMemo(
    () =>
      model.nodes.map((n) => ({
        id: n.id,
        type: 'cd',
        position: { x: n.x, y: n.y },
        data: { ...n.data, width: n.width, goalText } satisfies CdNodeData,
        draggable: false,
        connectable: false,
        selectable: n.data.kind === 'send',
      })),
    [model, goalText],
  );
  const edges: Edge[] = useMemo(
    () =>
      model.edges.map((e) => ({
        id: e.id,
        source: e.source,
        target: e.target,
        type: 'dcEdge',
        ...(e.sideways ? { sourceHandle: 'r', targetHandle: 'l' } : {}),
        data: { branchLabel: e.label ?? '', editable: false },
        className: e.sideways ? 'cd-edge-side' : undefined,
      })),
    [model],
  );

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
      edgeTypes={dripEdgeTypes}
      nodesDraggable={false}
      nodesConnectable={false}
      minZoom={0.15}
      maxZoom={1.6}
      onNodeClick={(_, n) => (n.data as CdNodeData).kind === 'send' && onOpenNode?.(n.id)}
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
    <div className="cv-canvas dc-graph-wrap">
      <ReactFlowProvider>
        <Inner {...props} />
      </ReactFlowProvider>
    </div>
  );
}
