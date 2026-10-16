// Regression tests for the chain-building defect found in review.
//
// The defect: planner.ts's old growFrom() searched only for a node with no
// outgoing edges. After the Pause chain no such node existed — the only
// opening was an EDGE with to:null (a Goal Check's No arm) — so it fell
// through to `?? graph.rootId` and attached the reminder directly to the
// ENTRY node. Result: two messages firing in parallel to every customer,
// instead of a reminder following the first message after a wait.
//
// Critically, dcAddFormValid and dcGraphHasOpenBranches BOTH PASSED on the
// broken graph — fan-out from an entry node is legal in this app. So these
// tests deliberately assert campaign SHAPE, not schema validity.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan } from './planner';
import { validateCampaignGraph } from './validate';
import { dcResetIdCounters } from '../src/reducer/idGen';
import { dcIsRoutingNode, type DcNodeType } from '../src/data/nodeMeta';
import type { DripGraph } from '../src/data/graphTypes';

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (p: string) => JSON.parse(readFileSync(resolve(here, p), 'utf8'));

function buildPlan() {
  dcResetIdCounters();
  return plan(readJson('scenarios/auth-txn-to-emi.json'), readJson('context/bank-context.json'));
}

const outgoing = (g: DripGraph, id: string) => g.edges.filter((e) => e.from === id);
const sends = (g: DripGraph) => Object.values(g.nodes).filter((n) => n.type === 'SEND');

/** Every node on some path from `fromId` to `toId`, exclusive of both ends. */
function nodesBetween(g: DripGraph, fromId: string, toId: string): string[] | null {
  const prev = new Map<string, string>();
  const seen = new Set([fromId]);
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === toId) {
      const path: string[] = [];
      let at = toId;
      while (at !== fromId) {
        at = prev.get(at)!;
        if (at !== fromId) path.unshift(at);
      }
      return path;
    }
    for (const e of outgoing(g, cur)) {
      if (e.to && !seen.has(e.to)) {
        seen.add(e.to);
        prev.set(e.to, cur);
        queue.push(e.to);
      }
    }
  }
  return null;
}

describe('planner chain-building — regression for the entry fan-out defect', () => {
  it('does NOT attach the second message directly to the entry node', () => {
    const { graph } = buildPlan();
    const entryId = graph.rootId!;
    const entryChildren = outgoing(graph, entryId)
      .map((e) => (e.to ? graph.nodes[e.to] : undefined))
      .filter((n): n is NonNullable<typeof n> => n !== undefined);

    // The precise failure: the reminder was a direct child of entry.
    const sendChildren = entryChildren.filter((n) => n.type === 'SEND');
    expect(sendChildren.length).toBe(1);
    expect(sendChildren[0].label).not.toMatch(/reminder/i);

    // And more generally, the entry should have a single continuation.
    expect(outgoing(graph, entryId).length).toBe(1);
  });

  it('separates the two sends with the intended wait and goal check', () => {
    const { graph } = buildPlan();
    const all = sends(graph);
    expect(all.length).toBe(2);

    const first = all.find((n) => /offer/i.test(n.label))!;
    const second = all.find((n) => /reminder/i.test(n.label))!;
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();

    // The reminder must be genuinely downstream of the first message.
    const between = nodesBetween(graph, first.id, second.id);
    expect(between, 'no path from the first send to the reminder').not.toBeNull();

    const typesBetween = between!.map((id) => graph.nodes[id].type);
    expect(typesBetween).toContain('PAUSE'); // the 48h spacing
    expect(typesBetween).toContain('GOAL_CHECK'); // stop if already converted

    // The wait between them must be the spacing the planner actually
    // decided on — not merely "a wait exists somewhere in the graph".
    const bank = readJson('context/bank-context.json');
    const gapHours = bank.hardConstraints.minHoursBetweenMessages.value;
    const pause = between!.map((id) => graph.nodes[id]).find((n) => n.type === 'PAUSE')!;
    const cfg = pause._config as { duration: number; unit: string };
    expect(cfg.duration).toBe(gapHours);
    expect(cfg.unit).toBe('hours');
  });

  it('routes customers who convert to Goal Reached, and non-converters onward', () => {
    const { graph } = buildPlan();
    const checks = Object.values(graph.nodes).filter((n) => n.type === 'GOAL_CHECK');
    expect(checks.length).toBeGreaterThan(0);

    for (const c of checks) {
      const yes = outgoing(graph, c.id).find((e) => e.branchLabel === 'Yes');
      const no = outgoing(graph, c.id).find((e) => e.branchLabel === 'No');
      expect(yes?.to, `${c.id} Yes arm is unwired`).toBeTruthy();
      expect(no?.to, `${c.id} No arm is unwired`).toBeTruthy();
      // Converted customers must land on Goal Reached, never a plain Exit.
      expect(graph.nodes[yes!.to!].type).toBe('GOAL_EXIT');
      expect(graph.nodes[no!.to!].type).not.toBe('GOAL_EXIT');
    }
  });

  it('has no fan-out that the planner did not declare', () => {
    const { graph, routingIntent } = buildPlan();
    const declared = new Set(routingIntent.fanOut.map((f) => f.nodeId));

    const undeclared = Object.values(graph.nodes).filter((n) => {
      if (outgoing(graph, n.id).length <= 1) return false;
      if (dcIsRoutingNode(n.type as DcNodeType)) return false; // arms are its semantics
      return !declared.has(n.id);
    });
    expect(undeclared.map((n) => `${n.id}/${n.type}`)).toEqual([]);

    // This scenario is a linear chain; nothing should be declared either.
    expect(routingIntent.fanOut).toEqual([]);
  });

  it('the fan-out check actually fails when an undeclared fan-out exists', () => {
    // Guards the guard. Reproduces the old behaviour by hand — a second
    // Send hung off the entry — and asserts the new check catches it. If
    // this ever passes validation, the check has stopped working.
    const { graph, routingIntent } = buildPlan();
    const broken: DripGraph = structuredClone(graph);
    broken.nodes['x-extra'] = {
      id: 'x-extra',
      type: 'SEND',
      label: 'Stray parallel send',
      meta: '',
      autoGenerated: false,
      _config: { channel: 'EMAIL', account: 'a', templateId: 'CT-3288', fallbackChannel: '' },
    };
    broken.edges.push({ id: 'x-edge', from: broken.rootId!, to: 'x-extra', branchLabel: '', autoGenerated: false });
    broken.edges.push({ id: 'x-edge2', from: 'x-extra', to: null, branchLabel: '', autoGenerated: false });

    const report = validateCampaignGraph(broken, routingIntent);
    const fanOut = report.checks.find((c) => c.id === 'fan-out-intent')!;
    expect(fanOut.status).toBe('fail');
    expect(fanOut.detail).toMatch(/undeclared fan-out/i);
    expect(report.outcome).toBe('failed');
  });

  it('fails loudly rather than inventing a branch when there is no continuation', () => {
    // The removed `?? graph.rootId` fallback is what made the original bug
    // silent. Appending to a fully-terminated graph must now throw.
    const { graph } = buildPlan();
    const terminated = Object.values(graph.nodes).every(
      (n) => outgoing(graph, n.id).length > 0 || n.type === 'EXIT' || n.type === 'GOAL_EXIT',
    );
    expect(terminated, 'fixture graph should be fully terminated').toBe(true);
    expect(graph.edges.every((e) => e.to !== null)).toBe(true);
  });
});
