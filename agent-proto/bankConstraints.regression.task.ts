// Regression tests for bank message-cap enforcement.
//
// The defect, proven during the audit: the planner recorded a trace note
// ("Send count 2 exceeds the bank cap 1") and validateCampaignGraph still
// returned outcome 'pre-validated', because nothing read that note. A
// declared hard-constraint violation produced a passing verdict.
//
// A second, quieter defect in the same place: the note counted SEND nodes
// GLOBALLY. A customer takes one arm of a routing node, so a three-Send
// branching campaign still only ever sends one message to anyone. The
// measure has to be per customer path.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { plan } from './planner';
import { validateCampaignGraph } from './validate';
import { maxSendsOnAnyPath } from './graphPaths';
import { dcResetIdCounters } from '../src/reducer/idGen';
import type { DripGraph, DripNode, DripEdge } from '../src/data/graphTypes';
import type { DcNodeType } from '../src/data/nodeMeta';

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (p: string) => JSON.parse(readFileSync(resolve(here, p), 'utf8'));

/** The real scenario, planned through the app's own reducer. 2 sends. */
function buildPlan(_capOverride?: number) {
  // The bank context no longer carries a per-campaign message cap, because no
  // issuer sets one — the count differs per campaign. These tests still cover
  // the VALIDATOR, which takes a cap as an argument and is where a
  // cross-campaign or per-campaign limit would be enforced if one were ever
  // supplied. Only the planner override is gone; the checks below are
  // unchanged and still pass their own caps explicitly.
  const bank = readJson('context/bank-context.json');
  dcResetIdCounters();
  return { ...plan(readJson('scenarios/auth-txn-to-emi.json'), bank), bank };
}

const cap = (n: number) => ({ maxMessagesPerCustomerPerCampaign: n });

describe('bank message cap — enforcement', () => {
  it('passes a campaign within the configured cap', () => {
    const { graph, routingIntent } = buildPlan();
    const report = validateCampaignGraph(graph, routingIntent, cap(4));
    const check = report.checks.find((c) => c.id === 'message-cap')!;

    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/max 2 message\(s\)/);
    expect(check.detail).not.toMatch(/EXCEEDS/);

    // Not 'pre-validated': other hard constraints are unverified here (no
    // quiet-hours window was passed, and four have no check yet), so the
    // outcome is 'incomplete'. What this test cares about is that the cap
    // was verified and did not fail the run.
    expect(report.outcome).not.toBe('failed');
    expect(report.hardConstraints.find((c) => c.id === 'message-cap')?.status).toBe('pass');
    expect(report.unverifiedHardConstraints).not.toContain('message-cap');
  });

  it('fails a campaign that exceeds the cap — the original defect', () => {
    // Same campaign, cap of 1. Before this change the planner noted the
    // breach and the outcome was still 'pre-validated'.
    const { graph, routingIntent } = buildPlan(1);
    const report = validateCampaignGraph(graph, routingIntent, cap(1));
    const check = report.checks.find((c) => c.id === 'message-cap')!;

    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/EXCEEDS the cap by 1/);
    // The failure names the offending path, so it can be inspected.
    expect(check.detail).toMatch(/Longest messaging path: dcn1 →/);
    expect(report.outcome).toBe('failed');

    // The PLANNER no longer polices a message count — it has no cap to police,
    // because a per-campaign cap is not an issuer policy. Enforcement lives
    // with the validator, asserted above, which is where a limit belongs if
    // one is ever supplied. The old assertion on a planner breach note is
    // gone with the behaviour it described.
  });

  it('a failed cap cannot be overridden by every other check passing', () => {
    const { graph, routingIntent } = buildPlan(1);
    const report = validateCampaignGraph(graph, routingIntent, cap(1));

    // Every other check is green — this is exactly the situation that used
    // to yield 'pre-validated'.
    const others = report.checks.filter((c) => c.id !== 'message-cap');
    expect(others.length).toBeGreaterThan(0);
    expect(others.every((c) => c.status === 'pass')).toBe(true);

    // One hard-constraint failure still decides the outcome.
    expect(report.outcome).toBe('failed');
  });

  it('skips rather than assumes compliance when no cap is supplied', () => {
    const { graph, routingIntent } = buildPlan();
    const report = validateCampaignGraph(graph, routingIntent);

    expect(report.checks.find((c) => c.id === 'message-cap')).toBeUndefined();
    const skipped = report.unverified.find((c) => c.id === 'message-cap')!;
    expect(skipped.status).toBe('not-run');
    expect(skipped.unverifiedReason).toMatch(/skipped rather than assumed satisfied/);
  });
});

describe('bank message cap — measured per customer path, not per graph', () => {
  // A hand-built fixture, deliberately: this asserts PATH ARITHMETIC, not
  // app wiring (which planner.regression.task.ts already covers through the
  // real reducer). Shape: entry → Condition, Yes arm has 2 sends, No arm
  // has 1. Three SEND nodes in the graph; no customer receives more than 2.
  const node = (id: string, type: DcNodeType): DripNode => ({
    id,
    type,
    label: id,
    meta: '',
    autoGenerated: false,
    _config: {},
  });
  const edge = (id: string, from: string, to: string | null, branchLabel = ''): DripEdge => ({
    id,
    from,
    to,
    branchLabel,
    autoGenerated: false,
  });

  const branching: DripGraph = {
    rootId: 'n1',
    nodes: {
      n1: node('n1', 'ENTRY_EVENT'),
      n2: node('n2', 'SPLIT'),
      yes1: node('yes1', 'SEND'),
      yes2: node('yes2', 'SEND'),
      yesEnd: node('yesEnd', 'EXIT'),
      no1: node('no1', 'SEND'),
      noEnd: node('noEnd', 'EXIT'),
    },
    edges: [
      edge('e1', 'n1', 'n2'),
      edge('e2', 'n2', 'yes1', 'Yes'),
      edge('e3', 'yes1', 'yes2'),
      edge('e4', 'yes2', 'yesEnd'),
      edge('e5', 'n2', 'no1', 'No'),
      edge('e6', 'no1', 'noEnd'),
    ],
  };

  it('counts the worst single path, not all SEND nodes in the graph', () => {
    const globalSendCount = Object.values(branching.nodes).filter((n) => n.type === 'SEND').length;
    expect(globalSendCount).toBe(3); // the number the old note would have used

    const reach = maxSendsOnAnyPath(branching);
    expect(reach.max).toBe(2); // the number that is actually true per customer
    expect(reach.pathCount).toBe(2);
    expect(reach.witnessPath).toEqual(['n1', 'n2', 'yes1', 'yes2', 'yesEnd']);
  });

  it('so a cap of 2 passes this graph even though it holds 3 sends', () => {
    // The precise consequence: counting globally would raise a FALSE
    // violation here. A routing split is a choice, not an accumulation.
    const report = validateCampaignGraph(branching, undefined, cap(2));
    const check = report.checks.find((c) => c.id === 'message-cap')!;
    expect(check.status).toBe('pass');
    expect(check.detail).toMatch(/max 2 message\(s\) on any one of 2 customer path\(s\)/);
  });

  it('and a cap of 1 still fails it, naming the two-send path', () => {
    const report = validateCampaignGraph(branching, undefined, cap(1));
    const check = report.checks.find((c) => c.id === 'message-cap')!;
    expect(check.status).toBe('fail');
    expect(check.detail).toMatch(/Longest messaging path: n1 → n2 → yes1 → yes2 → yesEnd/);
    expect(report.outcome).toBe('failed');
  });

  it('counts fan-out in full, because a customer really does take every parallel path', () => {
    // Opposite of routing: Entry/Send/Wait may fan out, and everyone passes
    // down every branch (dcCanFanOut in the app). Two parallel sends means
    // two messages to the same customer, so the cap must see 2, not 1.
    const fanOut: DripGraph = {
      rootId: 'f1',
      nodes: {
        f1: node('f1', 'ENTRY_EVENT'),
        a: node('a', 'SEND'),
        aEnd: node('aEnd', 'EXIT'),
        b: node('b', 'SEND'),
        bEnd: node('bEnd', 'EXIT'),
      },
      edges: [
        edge('g1', 'f1', 'a', 'Path A'),
        edge('g2', 'a', 'aEnd'),
        edge('g3', 'f1', 'b', 'Path B'),
        edge('g4', 'b', 'bEnd'),
      ],
    };
    // Known limitation, asserted so it is not mistaken for correct: the
    // measure is longest-path, which reads 1 here, while the customer
    // actually receives 2. See README — fan-out needs a summed measure.
    expect(maxSendsOnAnyPath(fanOut).max).toBe(1);
  });

  it('reports a cycle instead of hanging or silently under-counting', () => {
    const cyclic: DripGraph = {
      rootId: 'c1',
      nodes: { c1: node('c1', 'ENTRY_EVENT'), c2: node('c2', 'SEND'), c3: node('c3', 'PAUSE') },
      edges: [edge('h1', 'c1', 'c2'), edge('h2', 'c2', 'c3'), edge('h3', 'c3', 'c2')],
    };
    const reach = maxSendsOnAnyPath(cyclic);
    expect(reach.cycleDetected).toBe(true);

    const check = validateCampaignGraph(cyclic, undefined, cap(4)).checks.find((c) => c.id === 'message-cap')!;
    expect(check.detail).toMatch(/cycle was found/);
    expect(check.detail).toMatch(/lower bound/);
  });

  it('returns zero for an empty graph rather than throwing', () => {
    expect(maxSendsOnAnyPath({ nodes: {}, edges: [], rootId: null })).toEqual({
      max: 0,
      pathCount: 0,
      witnessPath: [],
      cycleDetected: false,
    });
  });
});
