// How many messages does ONE customer actually receive?
//
// Not the same question as "how many Send nodes are in the graph", which is
// what the planner's original trace note measured. A customer takes exactly
// one arm of a routing node (Condition / Branch / Experiment / Goal Check /
// Wait for Event), so a graph with three Sends across three arms still only
// ever sends one message to any given customer. Counting nodes globally
// over-reports on every branching campaign.
//
// The honest measure is the maximum number of Sends on any single
// root-to-terminal path. That is what a per-customer message cap applies to.
//
// Shared by validate.ts (the check) and planner.ts (the trace note) so the
// verdict and the trace can never disagree about the number.
import type { DripGraph } from '../src/data/graphTypes';

export interface MaxSendsResult {
  /** Most Sends any one customer can receive. */
  max: number;
  /** Distinct root-to-terminal paths examined. */
  pathCount: number;
  /** One path that achieves `max`, as node ids — so a failure can be shown, not just asserted. */
  witnessPath: string[];
  /**
   * True if the graph contains a cycle. Reported rather than ignored: the
   * app builds DAGs (its "connect to an existing step" affordance was
   * removed during the React port), so a cycle means the measure below is a
   * lower bound and the caller should not treat it as proven.
   */
  cycleDetected: boolean;
}

/**
 * Computed bottom-up with memoisation rather than by enumerating paths —
 * O(V+E) instead of exponential, which matters because fan-out campaigns
 * (four parallel milestone checkpoints, each forking) multiply paths fast.
 */
export function maxSendsOnAnyPath(graph: DripGraph): MaxSendsResult {
  const best = new Map<string, number>();
  const witness = new Map<string, string[]>();
  const paths = new Map<string, number>();
  const visiting = new Set<string>();
  let cycleDetected = false;

  // An edge with to === null is an open slot, not a connection — the path
  // ends there, same as at a terminal node.
  const children = (id: string) =>
    graph.edges.filter((e) => e.from === id && e.to !== null).map((e) => e.to as string);

  const walk = (id: string): void => {
    if (best.has(id)) return;
    if (visiting.has(id)) {
      cycleDetected = true;
      return;
    }
    visiting.add(id);

    const self = graph.nodes[id]?.type === 'SEND' ? 1 : 0;
    let bestChild = 0;
    let bestWitness: string[] = [];
    let pathTotal = 0;

    for (const childId of children(id)) {
      walk(childId);
      const childBest = best.get(childId);
      if (childBest === undefined) continue; // cycle back-edge; already flagged
      pathTotal += paths.get(childId) ?? 1;
      if (childBest >= bestChild) {
        bestChild = childBest;
        bestWitness = witness.get(childId) ?? [];
      }
    }

    visiting.delete(id);
    best.set(id, self + bestChild);
    witness.set(id, [id, ...bestWitness]);
    paths.set(id, pathTotal === 0 ? 1 : pathTotal); // no children = one path, ending here
  };

  if (!graph.rootId || !graph.nodes[graph.rootId]) {
    return { max: 0, pathCount: 0, witnessPath: [], cycleDetected: false };
  }

  walk(graph.rootId);
  return {
    max: best.get(graph.rootId) ?? 0,
    pathCount: paths.get(graph.rootId) ?? 0,
    witnessPath: witness.get(graph.rootId) ?? [],
    cycleDetected,
  };
}
