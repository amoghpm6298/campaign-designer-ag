// The real fix for the two bugs that started this migration: node/slot
// layout and branch-label positioning are now owned by React Flow +
// dagre, not hand-computed. Two-pass render — an initial layout using a
// fallback card height, then a real relayout once React Flow has actually
// measured every node's true rendered height (via useNodesInitialized,
// which becomes true only after every node's ResizeObserver has reported
// in) — is the structural fix for the original's "floating connector"
// bug, which came from feeding dagre a height estimate that didn't match
// real content.
import { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Controls,
  MiniMap,
  Background,
  useNodesState,
  useEdgesState,
  useNodesInitialized,
  useReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { DripGraph } from '../data/graphTypes';
import { dripNodeTypes } from './nodeTypes';
import { dripEdgeTypes } from './DripEdge';
import { graphToFlowElements, type ToFlowOptions } from './toFlowElements';
import './dripCanvas.css';

interface DripCanvasInnerProps {
  graph: DripGraph;
  editable: boolean;
  onRemoveNode?: (nodeId: string) => void;
  onRemoveEdge?: (edgeId: string) => void;
  onAddAtEdge?: (edgeId: string) => void;
}

function DripCanvasInner({ graph, editable, onRemoveNode, onRemoveEdge, onAddAtEdge }: DripCanvasInnerProps) {
  const opts: ToFlowOptions = useMemo(
    () => ({ editable, onRemoveNode, onRemoveEdge, onAddAtEdge }),
    [editable, onRemoveNode, onRemoveEdge, onAddAtEdge],
  );
  const initial = useMemo(() => graphToFlowElements(graph, opts), [graph, opts]);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const [laidOut, setLaidOut] = useState(false);
  const nodesInitialized = useNodesInitialized();
  const { getNodes, fitView } = useReactFlow();

  // Re-seed React Flow's own state whenever the underlying graph changes
  // (a different campaign selected, or — in the builder — a real edit).
  useEffect(() => {
    const next = graphToFlowElements(graph, opts);
    setNodes(next.nodes);
    setEdges(next.edges);
    setLaidOut(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  useEffect(() => {
    if (!nodesInitialized || laidOut) return;
    const measuredHeights: Record<string, number> = {};
    getNodes().forEach((n) => {
      if (n.type === 'dcCard' && n.measured?.height) measuredHeights[n.id] = n.measured.height;
    });
    const relaid = graphToFlowElements(graph, { ...opts, measuredHeights });
    setNodes(relaid.nodes);
    setEdges(relaid.edges);
    setLaidOut(true);
    requestAnimationFrame(() => fitView({ padding: 0.15, duration: 200 }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodesInitialized, laidOut, graph]);

  return (
    <div className="dc-graph-wrap" style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={dripNodeTypes}
        edgeTypes={dripEdgeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={editable}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={16} size={1} />
        <Controls showInteractive={false} />
        <MiniMap pannable zoomable />
      </ReactFlow>
    </div>
  );
}

export function DripCanvas(props: DripCanvasInnerProps) {
  if (!props.graph.rootId) {
    return <div style={{ padding: 40, color: 'var(--gray-500)', fontSize: 13 }}>No steps yet — still a draft.</div>;
  }
  return (
    <ReactFlowProvider>
      <DripCanvasInner {...props} />
    </ReactFlowProvider>
  );
}
