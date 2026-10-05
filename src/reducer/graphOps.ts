// Ported from journeysnudgesemi/emi-conversions-prototype.html's Drip
// Campaigns graph helpers. The original versions read/wrote a single
// global `dripWiz` object directly; every function here instead takes a
// `graph: DripGraph` it mutates in place — callers (the reducer) are
// responsible for passing a fresh clone per action so the reducer itself
// stays pure at its own boundary, while these inner functions keep the
// exact same mutate-style logic as the original (same algorithms, new
// mutation target, per the migration plan's risk-mitigation approach).
import type { DripGraph, DripNode } from '../data/graphTypes';
import { dcNewBranchId, dcNewEdgeId } from './idGen';

export function dcOutgoingEdges(graph: DripGraph, nodeId: string) {
  return graph.edges.filter((e) => e.from === nodeId);
}
export function dcIncomingEdges(graph: DripGraph, nodeId: string) {
  return graph.edges.filter((e) => e.to === nodeId);
}
export function dcCountSends(graph: DripGraph): number {
  return Object.values(graph.nodes).filter((nd) => nd.type === 'SEND').length;
}
export function dcRootNode(graph: DripGraph): DripNode | null {
  return graph.rootId ? graph.nodes[graph.rootId] ?? null : null;
}

// Can targetId be reached FROM startId by following outgoing edges
// forward? Used to block a merge that would close a loop — connecting
// fromNodeId's open branch to some target T is only safe when T can't
// already reach back to fromNodeId.
export function dcCanReach(graph: DripGraph, startId: string, targetId: string): boolean {
  if (startId === targetId) return true;
  const seen = new Set([startId]);
  const stack = [startId];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of graph.edges) {
      if (e.from === cur && e.to && !seen.has(e.to)) {
        if (e.to === targetId) return true;
        seen.add(e.to);
        stack.push(e.to);
      }
    }
  }
  return false;
}

// Every existing node EXCEPT fromNodeId itself and anything that could
// already reach back to it — connecting fromNodeId's open branch to one of
// those would create a cycle, which a campaign sequence (strictly
// forward-moving) can never legitimately have.
export function dcValidMergeTargets(graph: DripGraph, fromNodeId: string): DripNode[] {
  return Object.values(graph.nodes).filter((nd) => nd.id !== fromNodeId && !dcCanReach(graph, nd.id, fromNodeId));
}

// Only actually deletes a node once NOTHING still points to it — a step
// reached from more than one branch (a real, deliberate merge) is never
// lost just because one of its connections was removed elsewhere.
// Recurses into whatever THIS node's own outgoing edges pointed at, since
// each of those just lost one more incoming edge too.
export function dcGarbageCollect(graph: DripGraph, nodeId: string | null): void {
  if (!nodeId || graph.rootId === nodeId || !graph.nodes[nodeId]) return;
  if (graph.edges.some((e) => e.to === nodeId)) return;
  const childTargets = graph.edges.filter((e) => e.from === nodeId).map((e) => e.to).filter(Boolean) as string[];
  graph.edges = graph.edges.filter((e) => e.from !== nodeId);
  delete graph.nodes[nodeId];
  childTargets.forEach((id) => dcGarbageCollect(graph, id));
}

// Detaches one specific connection, addressed by the edge itself. A branch
// under Split/Random Split/Wait Until can't just vanish — it reverts to an
// open, re-fillable slot so the node stays structurally valid; a plain
// linear leaf's own next-step edge is fully removed instead, since a
// linear leaf has no permanent "slot" concept to revert to.
export function dcRemoveEdge(graph: DripGraph, edgeId: string): void {
  const edge = graph.edges.find((e) => e.id === edgeId);
  if (!edge) return;
  const parent = graph.nodes[edge.from];
  const targetId = edge.to;
  if (parent && ['SPLIT', 'RANDOM_SPLIT', 'WAIT_UNTIL'].includes(parent.type)) {
    edge.to = null;
  } else {
    graph.edges = graph.edges.filter((e) => e.id !== edgeId);
  }
  if (targetId) dcGarbageCollect(graph, targetId);
}

export function dcRemoveRoot(graph: DripGraph): void {
  graph.nodes = {};
  graph.edges = [];
  graph.rootId = null;
}

export interface BranchLike {
  id?: string;
  [key: string]: unknown;
}

// Reconciles a Random Split / Decision Split node's real outgoing edges
// against its edited branch list, by branch IDENTITY (branch.id / edge
// .branchId) rather than array position or count. A pure "does the count
// still match" check silently does nothing at all once a branch is added
// or removed mid-edit — the config would claim N branches while the graph
// still only has N-1 real edges, with the new branch configured but
// completely unreachable. Matching by identity instead means an insert in
// the middle only ever affects the ONE new branch (gets a fresh open
// edge) and never touches any other branch's existing edge/subtree,
// regardless of where in the list it landed.
//
// catchAllLabel identifies Decision Split's fixed, always-last "Anything
// else" edge (a real edge, but not one of the real branches) — matched by
// its own fixed label, not by branchId==null, since legacy branches built
// before this identity system existed also have a null branchId and would
// otherwise be indistinguishable from the catch-all.
export function dcReconcileBranchEdges(
  graph: DripGraph,
  nodeId: string,
  branches: BranchLike[],
  labelFn: (b: BranchLike) => string,
  catchAllLabel: string | null,
): void {
  const allOuts = graph.edges.filter((e) => e.from === nodeId);
  const catchAllEdge = catchAllLabel ? allOuts.find((e) => e.branchLabel === catchAllLabel) : undefined;
  const branchEdges = allOuts.filter((e) => e !== catchAllEdge);
  const claimed = new Set<(typeof branchEdges)[number]>();

  // Pass 1: match by stable branch id.
  branches.forEach((b) => {
    if (!b.id) return;
    const e = branchEdges.find((e2) => e2.branchId === b.id && !claimed.has(e2));
    if (e) claimed.add(e);
  });

  // Pass 2: positional backfill for legacy branches (no id yet). Paired up
  // to whichever is shorter — NOT gated on the two counts matching
  // exactly, since a same-edit add/remove alongside legacy data is exactly
  // the real scenario this exists for: pairing only the still-aligned
  // prefix keeps every legacy branch attached to its real original
  // edge/subtree, while anything genuinely extra falls through to be
  // handled below as a real add or real removal.
  const legacyBranches = branches.filter((b) => !b.id);
  const legacyEdges = branchEdges.filter((e) => !claimed.has(e));
  const pairCount = Math.min(legacyBranches.length, legacyEdges.length);
  for (let i = 0; i < pairCount; i++) {
    legacyBranches[i].id = dcNewBranchId();
    legacyEdges[i].branchId = legacyBranches[i].id as string;
    claimed.add(legacyEdges[i]);
  }

  // Now every branch either has a matching edge (relabel in place, never
  // touch .to) or genuinely doesn't (a real insert/append — fresh open slot).
  branches.forEach((b) => {
    if (!b.id) b.id = dcNewBranchId();
    const e = branchEdges.find((e2) => e2.branchId === b.id);
    if (e) {
      e.branchLabel = labelFn(b);
    } else {
      graph.edges.push({ id: dcNewEdgeId(), from: nodeId, to: null, branchLabel: labelFn(b), branchId: b.id, autoGenerated: false });
    }
  });

  // Anything left over — an edge whose branch is no longer in the list —
  // was a real removal. Splice it out and cascade-GC whatever was built
  // under it.
  const keepIds = new Set(branches.map((b) => b.id));
  branchEdges
    .filter((e) => !keepIds.has(e.branchId))
    .forEach((e) => {
      const idx = graph.edges.indexOf(e);
      if (idx > -1) graph.edges.splice(idx, 1);
      if (e.to) dcGarbageCollect(graph, e.to);
    });

  // Reorder this node's own branch edges (+ catch-all last) to match the
  // real branches array order — without this, a branch inserted in the
  // middle would carry the right label but still render AFTER every
  // sibling branch, since a brand-new edge is simply appended to the
  // shared, whole-graph edges array. Only this node's own edges are
  // touched; every other node's edges keep their existing relative order.
  const orderedForThisNode = branches
    .map((b) => graph.edges.find((e) => e.from === nodeId && e.branchId === b.id))
    .filter(Boolean) as DripGraph['edges'];
  if (catchAllEdge) orderedForThisNode.push(catchAllEdge);
  orderedForThisNode.forEach((e) => {
    const idx = graph.edges.indexOf(e);
    if (idx > -1) graph.edges.splice(idx, 1);
  });
  graph.edges.push(...orderedForThisNode);
}

// A leaf with no children that isn't a terminal type, or any unfilled open
// slot, blocks Submit (not Save — a draft can always be incomplete).
export function dcGraphHasOpenBranches(graph: DripGraph): boolean {
  if (!graph.rootId) return true;
  const leafOpen = Object.values(graph.nodes).some(
    (nd) => !graph.edges.some((e) => e.from === nd.id) && nd.type !== 'GOAL_EXIT' && nd.type !== 'EXIT',
  );
  const slotOpen = graph.edges.some((e) => e.to === null);
  return leafOpen || slotOpen;
}
