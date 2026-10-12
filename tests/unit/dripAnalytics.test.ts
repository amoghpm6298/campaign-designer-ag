// Verifies generateDripAnalytics() against every real seed campaign —
// deterministic (same campaign, same numbers across calls), monotonic
// (a node can never show more reach than its incoming total), and the
// control-group/conversion-rate math checks out against the totals it's
// derived from.
import { describe, expect, it } from 'vitest';
import { DRIP_CAMPAIGNS } from '../../src/data/seedCampaigns';
import { generateDripAnalytics } from '../../src/data/dripAnalytics';

const LIVE_CAMPAIGNS = DRIP_CAMPAIGNS.filter((c) => c.root && c.root.rootId);

describe('generateDripAnalytics', () => {
  it.each(LIVE_CAMPAIGNS.map((c) => [c.id, c] as const))('%s: deterministic across repeated calls', (_id, campaign) => {
    const a = generateDripAnalytics(campaign);
    const b = generateDripAnalytics(campaign);
    expect(a.totals).toEqual(b.totals);
    expect(a.metrics.nodeCounts).toEqual(b.metrics.nodeCounts);
  });

  it.each(LIVE_CAMPAIGNS.map((c) => [c.id, c] as const))('%s: control + entered sums to total matched', (_id, campaign) => {
    const { totals } = generateDripAnalytics(campaign);
    expect(totals.control + totals.entered).toBe(totals.totalMatched);
  });

  it.each(LIVE_CAMPAIGNS.map((c) => [c.id, c] as const))('%s: conversion rate matches reachedGoal / entered', (_id, campaign) => {
    const { totals } = generateDripAnalytics(campaign);
    const expected = totals.entered > 0 ? totals.reachedGoal / totals.entered : 0;
    expect(totals.conversionRate).toBeCloseTo(expected, 10);
  });

  it.each(LIVE_CAMPAIGNS.map((c) => [c.id, c] as const))('%s: every node count is non-negative and no larger than the root', (_id, campaign) => {
    const { metrics } = generateDripAnalytics(campaign);
    const rootCount = metrics.nodeCounts[campaign.root!.rootId!];
    Object.values(metrics.nodeCounts).forEach((n) => {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(rootCount);
    });
  });

  it.each(LIVE_CAMPAIGNS.map((c) => [c.id, c] as const))('%s: Random/Decision Split edges split by their own encoded percentage', (_id, campaign) => {
    const { metrics } = generateDripAnalytics(campaign);
    const graph = campaign.root!;
    Object.values(graph.nodes)
      .filter((n) => n.type === 'RANDOM_SPLIT' || n.type === 'DECISION_SPLIT')
      .forEach((n) => {
        const outs = graph.edges.filter((e) => e.from === n.id && e.to);
        outs.forEach((e) => {
          const m = e.branchLabel.match(/\((\d+)%\)/);
          if (m && metrics.edgeCounts[e.id]) {
            expect(metrics.edgeCounts[e.id].pct).toBe(parseInt(m[1], 10));
          }
        });
      });
  });

  it('a KILLED campaign has zero "still active"', () => {
    const killed = LIVE_CAMPAIGNS.find((c) => c.status === 'KILLED') || { ...LIVE_CAMPAIGNS[0], status: 'KILLED' as const };
    const { totals } = generateDripAnalytics(killed);
    expect(totals.stillActive).toBe(0);
  });

  it('Send nodes get engagement stats, other types do not', () => {
    const campaign = LIVE_CAMPAIGNS.find((c) => c.id === 'DRIP-005')!;
    const { metrics } = generateDripAnalytics(campaign);
    const graph = campaign.root!;
    Object.values(graph.nodes).forEach((n) => {
      const eng = metrics.engagementByNodeId[n.id];
      if (n.type === 'SEND') {
        expect(eng).toBeTruthy();
        expect(eng.deliveredPct).toBeGreaterThan(0);
        expect(eng.deliveredPct).toBeLessThanOrEqual(100);
      } else {
        expect(eng).toBeUndefined();
      }
    });
  });
});

// The distinction that makes a fan-out campaign's numbers correct: a
// routing node DIVIDES its arrivals between mutually exclusive paths,
// while a fan-out node sends EVERY customer down EVERY path, so each
// path carries the full incoming count. Counting fan-out the routing way
// would have quietly reported a quarter of the real reach on each of
// DRIP-003's four milestone checkpoints.
describe('fan-out counts in full, routing divides', () => {
  const drip003 = DRIP_CAMPAIGNS.find((c) => c.id === 'DRIP-003')!;

  it("DRIP-003's four parallel paths each carry the entry's full count, not a share", () => {
    const { metrics, totals } = generateDripAnalytics({ ...drip003, status: 'ACTIVE' });
    const entryId = drip003.root!.rootId!;
    const outs = drip003.root!.edges.filter((e) => e.from === entryId && e.to);
    expect(outs.length).toBe(4);
    const shares = outs.map((e) => metrics.edgeCounts[e.id]?.count ?? 0);
    // Compared against the entry node's own arrivals, not the campaign
    // total — the entry already holds some back as still-in-sequence
    // before any path is taken. Every path is within normal per-hop
    // attrition of ALL of them, emphatically not a quarter each, which
    // is what a routing split would have produced.
    const arrivals = metrics.nodeCounts[entryId];
    shares.forEach((s) => {
      expect(s).toBeGreaterThan(arrivals * 0.92);
      expect(s).toBeLessThanOrEqual(arrivals);
    });
    // Their sum far exceeds the arrivals, which is correct here and
    // would be a bug for a routing node.
    expect(shares.reduce((a, b) => a + b, 0)).toBeGreaterThan(arrivals * 3);
    expect(totals.entered).toBeGreaterThan(0);
  });

  it("a routing node's paths still divide, summing to roughly its arrivals", () => {
    // DRIP-002's Experiment splits traffic between two variants.
    const drip002 = DRIP_CAMPAIGNS.find((c) => c.id === 'DRIP-002')!;
    const { metrics } = generateDripAnalytics({ ...drip002, status: 'ACTIVE' });
    const splitId = Object.values(drip002.root!.nodes).find((n) => n.type === 'RANDOM_SPLIT')!.id;
    const outs = drip002.root!.edges.filter((e) => e.from === splitId && e.to);
    const arrivals = metrics.nodeCounts[splitId];
    const sum = outs.reduce((acc, e) => acc + (metrics.edgeCounts[e.id]?.count ?? 0), 0);
    expect(sum).toBeLessThanOrEqual(arrivals + outs.length); // rounding only
    expect(sum).toBeGreaterThan(arrivals * 0.95);
  });
});
