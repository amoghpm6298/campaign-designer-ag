// Deterministic, illustrative per-campaign analytics — there's no real
// engagement data anywhere in this app's data model (seed campaigns are
// just the graph + metadata), so this generates plausible numbers from
// the campaign's own id + graph shape, same "seeded, not Math.random()"
// convention used throughout the original prototype's own mock data.
//
// The model: a fixed pool of customers matched the entry criteria, split
// into Control (held back, never enters the sequence — controlPct) and
// the treatment group that actually walks the graph. Counts propagate
// forward through the graph in topological order (a merge/"connect to
// existing" target only fans its own count out once every incoming edge
// has contributed), so a node reached from two branches correctly sums
// both paths before continuing. A Random/Decision Split's branches split
// by their own real encoded percentage (already in the branch label);
// a plain Yes/No goal-check split uses a seeded, modest "reached the
// goal at this checkpoint" rate; a single-outgoing linear hop applies a
// small flat attrition (opt-outs/delivery failures) rather than passing
// the count through unchanged.
import type { DripCampaign, DripEdge } from './graphTypes';

export interface DripAnalyticsMetrics {
  nodeCounts: Record<string, number>;
  edgeCounts: Record<string, { count: number; pct: number }>;
  // Per-channel engagement — only present for SEND/CHANNEL_FAILOVER nodes.
  // CleverTap's own analytics separate this ("Engagement Stats") from
  // raw per-node reach counts ("Node Stats") for exactly this reason: a
  // Send reaching 10,000 people and a Send that reached 10,000 people AND
  // got opened by half of them are different facts worth showing
  // separately, not folded into one number.
  engagementByNodeId: Record<string, { deliveredPct: number; openedPct: number; clickedPct: number }>;
}

export interface DripAnalyticsTotals {
  totalMatched: number;
  control: number;
  entered: number;
  reachedGoal: number;
  exitedWithoutGoal: number;
  stillActive: number;
  conversionRate: number;
}

export interface DripAnalyticsData {
  metrics: DripAnalyticsMetrics;
  totals: DripAnalyticsTotals;
}

function seedFromId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}

// mulberry32 — small, fast, deterministic PRNG from a single integer seed.
function mulberry32(seed: number): () => number {
  let s = seed;
  return function () {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function computeSplitPcts(edges: DripEdge[], rand: () => number): number[] {
  const explicit: (number | null)[] = edges.map((e) => {
    const m = e.branchLabel.match(/\((\d+)%\)/);
    return m ? parseInt(m[1], 10) / 100 : null;
  });
  const explicitSum = explicit.reduce((s: number, v) => s + (v || 0), 0);
  const unexplicitCount = explicit.filter((v) => v === null).length;

  if (unexplicitCount === 0) {
    const sum = explicitSum || 1;
    return explicit.map((v) => (v || 0) / sum);
  }
  if (explicitSum > 0) {
    const remainder = Math.max(0, 1 - explicitSum);
    const each = remainder / unexplicitCount;
    return explicit.map((v) => (v === null ? each : (v as number)));
  }
  if (edges.length === 2 && /^Yes$/i.test(edges[0].branchLabel) && /^No$/i.test(edges[1].branchLabel)) {
    const yesPct = 0.1 + rand() * 0.2; // a modest 10-30% reach the goal at this specific checkpoint
    return [yesPct, 1 - yesPct];
  }
  const base = 1 / edges.length;
  const raw = edges.map(() => Math.max(0.02, base + (rand() - 0.5) * 0.1 * base));
  const sum = raw.reduce((s, v) => s + v, 0);
  return raw.map((v) => v / sum);
}

export function generateDripAnalytics(campaign: DripCampaign): DripAnalyticsData {
  const rand = mulberry32(seedFromId(campaign.id));
  const totalMatched = Math.round(8000 + rand() * 12000);
  const control = Math.round((totalMatched * (campaign.controlPct || 0)) / 100);
  const entered = totalMatched - control;

  const nodeCounts: Record<string, number> = {};
  const edgeCounts: Record<string, { count: number; pct: number }> = {};
  const engagementByNodeId: Record<string, { deliveredPct: number; openedPct: number; clickedPct: number }> = {};
  let reachedGoal = 0;
  let exitedWithoutGoal = 0;
  let stillActive = 0;

  const graph = campaign.root;
  if (graph && graph.rootId) {
    const incomingEdges: Record<string, DripEdge[]> = {};
    graph.edges.forEach((e) => {
      if (e.to) (incomingEdges[e.to] ||= []).push(e);
    });
    const remainingIndegree: Record<string, number> = {};
    Object.keys(graph.nodes).forEach((id) => {
      remainingIndegree[id] = (incomingEdges[id] || []).length;
    });

    // A kill switch exits everyone immediately, regardless of position —
    // nobody is left "still active." Otherwise, a modest slice of the
    // treatment group hasn't reached any terminal state yet.
    const stillActiveFrac = campaign.status === 'KILLED' ? 0 : 0.05 + rand() * 0.06;
    const rootEntered = Math.round(entered * (1 - stillActiveFrac));
    stillActive = entered - rootEntered;

    nodeCounts[graph.rootId] = rootEntered;
    const queue: string[] = [graph.rootId];
    while (queue.length) {
      const nodeId = queue.shift()!;
      const node = graph.nodes[nodeId];
      if (!node) continue;
      const total = nodeCounts[nodeId] || 0;
      if (node.type === 'SEND' || node.type === 'CHANNEL_FAILOVER') {
        // Seeded independently per node (not off the shared `rand`
        // sequence) so engagement numbers don't shift depending on where
        // in the topological walk this node happens to land.
        const nodeRand = mulberry32(seedFromId(nodeId));
        const deliveredPct = Math.round(92 + nodeRand() * 7); // 92-99%
        const openedPct = Math.round(deliveredPct * (0.35 + nodeRand() * 0.3)); // 35-65% of delivered
        const clickedPct = Math.round(openedPct * (0.2 + nodeRand() * 0.25)); // 20-45% of opened
        engagementByNodeId[nodeId] = { deliveredPct, openedPct, clickedPct };
      }
      if (node.type === 'GOAL_EXIT') {
        reachedGoal += total;
        continue;
      }
      if (node.type === 'EXIT') {
        exitedWithoutGoal += total;
        continue;
      }
      const outs = graph.edges.filter((e) => e.from === nodeId && e.to);
      if (!outs.length) {
        // A dead end that isn't a terminal type shouldn't happen for a
        // submittable (non-DRAFT) campaign — defensive fallback only.
        exitedWithoutGoal += total;
        continue;
      }
      if (outs.length === 1) {
        const attrition = 0.02 + rand() * 0.04;
        const share = Math.round(total * (1 - attrition));
        const e = outs[0];
        edgeCounts[e.id] = { count: share, pct: 100 };
        exitedWithoutGoal += total - share;
        nodeCounts[e.to!] = (nodeCounts[e.to!] || 0) + share;
        remainingIndegree[e.to!] -= 1;
        if (remainingIndegree[e.to!] === 0) queue.push(e.to!);
        continue;
      }
      const pcts = computeSplitPcts(outs, rand);
      outs.forEach((e, i) => {
        const share = Math.round(total * pcts[i]);
        edgeCounts[e.id] = { count: share, pct: Math.round(pcts[i] * 100) };
        nodeCounts[e.to!] = (nodeCounts[e.to!] || 0) + share;
        remainingIndegree[e.to!] -= 1;
        if (remainingIndegree[e.to!] === 0) queue.push(e.to!);
      });
    }
  }

  const conversionRate = entered > 0 ? reachedGoal / entered : 0;

  return {
    metrics: { nodeCounts, edgeCounts, engagementByNodeId },
    totals: { totalMatched, control, entered, reachedGoal, exitedWithoutGoal, stillActive, conversionRate },
  };
}
