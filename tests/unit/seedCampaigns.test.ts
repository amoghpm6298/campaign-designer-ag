// Sanity-checks the 6 seed campaigns extracted from the live prototype —
// confirms the port didn't silently corrupt anything (every edge's `to`/
// `from` resolves to a real node or null, every node is reachable from
// root, root exists for every non-empty graph).
import { describe, expect, it } from 'vitest';
import { DRIP_CAMPAIGNS } from '../../src/data/seedCampaigns';
import { dcGraphHasOpenBranches } from '../../src/reducer/graphOps';

describe('Seed campaign data integrity', () => {
  it('has exactly the 6 real campaigns', () => {
    expect(DRIP_CAMPAIGNS.length).toBe(6);
    expect(DRIP_CAMPAIGNS.map((c) => c.id)).toEqual(['DRIP-001', 'DRIP-002', 'DRIP-003', 'DRIP-004', 'DRIP-005', 'DRIP-006']);
  });

  it.each(DRIP_CAMPAIGNS.map((c) => [c.id, c] as const))('%s: every edge resolves to a real node or an open slot', (_id, campaign) => {
    const graph = campaign.root!;
    expect(graph.rootId).toBeTruthy();
    expect(graph.nodes[graph.rootId!]).toBeTruthy();
    graph.edges.forEach((e) => {
      expect(graph.nodes[e.from]).toBeTruthy();
      if (e.to !== null) expect(graph.nodes[e.to]).toBeTruthy();
    });
  });

  it.each(DRIP_CAMPAIGNS.map((c) => [c.id, c] as const))('%s: every node is reachable from root', (_id, campaign) => {
    const graph = campaign.root!;
    const seen = new Set<string>([graph.rootId!]);
    const stack = [graph.rootId!];
    while (stack.length) {
      const cur = stack.pop()!;
      graph.edges.filter((e) => e.from === cur && e.to).forEach((e) => {
        if (!seen.has(e.to!)) {
          seen.add(e.to!);
          stack.push(e.to!);
        }
      });
    }
    expect(seen.size).toBe(Object.keys(graph.nodes).length);
  });

  it('ACTIVE campaigns (DRIP-001, DRIP-002) have no open branches — real completed campaigns', () => {
    const active = DRIP_CAMPAIGNS.filter((c) => c.status === 'ACTIVE');
    expect(active.length).toBeGreaterThan(0);
    active.forEach((c) => {
      expect(dcGraphHasOpenBranches(c.root!)).toBe(false);
    });
  });

  it('DRAFT campaign (DRIP-003, Spend Milestone) has no shared campaign-level Goal — independent checkpoints', () => {
    const draft = DRIP_CAMPAIGNS.find((c) => c.id === 'DRIP-003')!;
    expect(draft.goal).toBeNull();
  });
});
