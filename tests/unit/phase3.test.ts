// Phase 3: signal switches (routes inside a bucket), route sizes and cost, route checks, split helpers.
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildFromBlueprint } from '../../server/blueprint';
import { planToBlueprint } from '../../server/agent/compile';
import { campaignCost } from '../../server/costModel';
import { routeProblems } from '../../server/agent/routeChecks';
import { toEngineCampaign } from '../../server/engineExport';
import { applySplitOutcomes, closingMessage, pendingSplitIdeas, runSplitHelper } from '../../server/agent/splitHelper';
import { initialState } from '../../server/agent/state';
import { signalsFor } from '../../server/signals';
import { resolveTenant } from '../../server/tenants';
import { warehousePath } from '../../server/warehouse';
import type { ToolEnv } from '../../server/agent/tools';
import type { AgentState, CampaignContext, CampaignObject } from '../../server/agent/types';

const YES = resolveTenant('TEN-YES')!;
const hasYes = existsSync(warehousePath('yesbank'));
const at = new Date().toISOString();
const ACTIVE = 'SELECT customer_id FROM customers WHERE is_active = 1';

const send = (name: string, extra: Record<string, unknown> = {}) => ({ id: `s-${name}`, kind: 'send', name, rationale: 'r', copy: 'Use your card this week.', channelPreference: ['SMS'], ...extra });
const tail = (name: string, extra: Record<string, unknown> = {}) => [send(name, extra), { id: `w-${name}`, kind: 'wait', durationHours: 72, rationale: 'w' }, { id: `g-${name}`, kind: 'goalCheck' }, { id: `e-${name}`, kind: 'exit', reason: 'End', outcome: 'no_response' }];
const offer = { incentive: 'no_cost_emi_electronics', costAssumptions: { reach: { expected: 1, few: 1, why: 'j' }, redeem: { expected: 0.1, few: 0.05, why: 'j' } } };
const sw = (paths: { label: string; operator: string; value: string; steps: unknown[] }[], extra: Record<string, unknown> = {}) => ({ id: 'sw1', kind: 'branch', signal: 'top_category', label: 'What do they spend on most?', rationale: 'r', paths, otherwise: tail('else'), ...extra });
const camp = (journey: unknown[], extra: Partial<CampaignObject> = {}): CampaignObject =>
  ({
    name: 'Spend',
    goal: { eventCategory: 'Transaction Events', eventType: 'Transaction' },
    entry: { kind: 'audience', entity: 'Customer' },
    membership: { type: 'locked' },
    schedule: { startDate: '2026-12-01', endDate: '2026-12-20' },
    everyoneElse: { approach: 'none' },
    buckets: [{ id: 'occ', name: 'Occasional', priority: 1, rule: [{ entity: 'Card', conditions: [] }], journey }],
    ...extra,
  }) as unknown as CampaignObject;
const ctx = (): CampaignContext =>
  ({
    entries: [
      { id: 'c1', at, kind: 'sizing', bucketId: 'occ', topic: 'size', text: 'All active', source: 'agent', data: { sql: ACTIVE, size: 45966 } },
      { id: 'c2', at, kind: 'note', topic: 'campaign strategy', text: 'Occasional: no_cost_emi_electronics for electronics buyers.', source: 'agent' },
      { id: 'c3', at, kind: 'brief', topic: 'Spend', text: 'Cheapest first.', source: 'manager' },
    ],
  }) as unknown as CampaignContext;
const env: ToolEnv = { tenant: YES, availableChannels: ['SMS'], goalStatement: 'x', sessionId: 's', lookupCache: new Map(), ...(hasYes ? { warehouseBank: 'yesbank' } : {}) };

beforeEach(() => {
  process.env.CAMPAIGN_DIR = mkdtempSync(join(tmpdir(), 'cd-p3-'));
});

describe('signal switch', () => {
  const signals = [{ key: 'top_category', label: 'Top category', type: 'category' as const, kind: 'behaviour' as const, definition: '', values: ['grocery', 'electronics'], usableIn: ['switch' as const], status: 'proposed' as const, sensitivity: 'normal' as const }];
  const build = (j: unknown[]) => buildFromBlueprint(planToBlueprint(camp(j)).blueprint!, { availableChannels: ['SMS'], templateLibraryAccess: 'unavailable', signals });
  it('builds as a split on the signal, with every route and everyone else', () => {
    const r = build([sw([{ label: 'Electronics', operator: 'Equals', value: 'electronics', steps: tail('el') }])]);
    expect((r.issues ?? []).map((i) => i.problem).join(' ')).not.toMatch(/signal/i);
    const g = r.graph as { nodes: Record<string, { type: string; _config?: { source?: string; attribute?: string } }> };
    expect(Object.values(g.nodes).some((n) => n.type === 'DECISION_SPLIT' && n._config?.source === 'Signal' && n._config?.attribute === 'top_category')).toBe(true);
  });
  it('refuses a value the signal does not take', () => {
    const r = build([sw([{ label: 'Boats', operator: 'Equals', value: 'boats', steps: tail('b') }])]);
    expect((r.issues ?? []).map((i) => i.problem).join(' ')).toMatch(/no value "boats"/);
  });
  it('the engine gets the switch; the split idea stays in the design', () => {
    const { engine } = toEngineCampaign(camp([sw([{ label: 'Electronics', operator: 'Equals', value: 'electronics', steps: tail('el') }], { splitIdea: { hypothesis: 'h', by: ['top_category'], status: 'split' } })]), YES);
    const j = JSON.stringify(engine);
    expect(j).toContain('"signal":"top_category"');
    expect(j).not.toContain('splitIdea');
  });
});

describe('route sizes and cost per route', () => {
  it.runIf(hasYes)('each route is counted by code; an offer inside a route is costed on the route', () => {
    const c = camp([sw([{ label: 'Electronics', operator: 'Equals', value: 'electronics', steps: tail('el', offer) }])]);
    const r = campaignCost(c, ctx(), YES);
    const el = r.routes.find((x) => x.label === 'Electronics')!;
    const other = r.routes.find((x) => x.otherwise)!;
    expect(el.size).toBeGreaterThan(0);
    expect(el.size! + other.size!).toBeLessThanOrEqual(45966);
    expect(r.lines[0].customers).toBe(el.size);
    expect(r.lines[0].route).toBe('Electronics');
  });
});

describe('route checks', () => {
  const cost = (c: CampaignObject) => campaignCost(c, ctx(), YES);
  it('too many routes, no everyone-else, too deep', () => {
    const five = ['grocery', 'electronics', 'dining', 'fuel', 'travel'].map((v) => ({ label: v, operator: 'Equals', value: v, steps: tail(v) }));
    const c1 = camp([sw(five, { otherwise: [] })]);
    const p1 = routeProblems(c1, ctx(), YES, cost(c1)).join(' ');
    expect(p1).toMatch(/5 routes; at most 4/);
    expect(p1).toMatch(/needs an "everyone else" route/);
    const inner = (d: number): unknown[] => (d === 0 ? tail('leaf') : [sw([{ label: `L${d}`, operator: 'Equals', value: 'grocery', steps: inner(d - 1) }], { id: `sw-${d}` })]);
    const c2 = camp(inner(3));
    expect(routeProblems(c2, ctx(), YES, cost(c2)).join(' ')).toMatch(/at most 2 deep/);
  });
  it('a split the campaign strategy does not describe is flagged', () => {
    const c = camp([sw([{ label: 'Electronics', operator: 'Equals', value: 'electronics', steps: tail('el') }])]);
    const plain = ctx();
    (plain.entries as { topic: string; text: string }[]).find((e) => e.topic === 'campaign strategy')!.text = 'Occasional: messages only.';
    expect(routeProblems(c, plain, YES, cost(c)).join(' ')).toMatch(/doesn't describe this split \(by top category\)/);
    expect(routeProblems(c, ctx(), YES, cost(c)).join(' ')).not.toMatch(/doesn't describe this split/);
  });

  it.runIf(hasYes)('a route too small to measure is flagged', () => {
    const c = camp([sw([{ label: 'Others', operator: 'Equals', value: 'others', steps: tail('o') }])]);
    expect(routeProblems(c, ctx(), YES, cost(c)).join(' ')).toMatch(/route "Others" has [\d,]+ customers, below the/);
  });
});

describe('split helpers', () => {
  const withIdea = () => [send('first'), { id: 'w0', kind: 'wait', durationHours: 48, rationale: 'w' }, { id: 'g0', kind: 'goalCheck' }, ...tail('second', { splitIdea: { hypothesis: 'Electronics buyers want EMI', by: ['top_category'] } })];
  const state = (): AgentState => ({ ...initialState(), campaign: camp(withIdea()), context: ctx() });
  const scripted = (replies: string[]) => {
    let i = 0;
    return async () => replies[Math.min(i++, replies.length - 1)];
  };

  it('finds untested ideas, one per bucket', () => {
    const ideas = pendingSplitIdeas(state());
    expect(ideas).toHaveLength(1);
    expect(ideas[0]).toMatchObject({ bucketId: 'occ', stepId: 's-second', by: ['top_category'] });
  });

  it.runIf(hasYes)('a decline is recorded on the step, and nothing else changes', async () => {
    const st = state();
    const o = await runSplitHelper(st, env, pendingSplitIdeas(st)[0], scripted([JSON.stringify({ action: 'decline', reason: 'Electronics buyers are 3% of the bucket: too small.' })]));
    expect(o.status).toBe('not split');
    const next = applySplitOutcomes(st, [o]);
    const step = (next.campaign.buckets[0].journey as unknown as { id: string; splitIdea?: { status: string; result: string } }[]).find((x) => x.id === 's-second')!;
    expect(step.splitIdea).toMatchObject({ status: 'not split', result: /too small/ });
    expect(pendingSplitIdeas(next)).toHaveLength(0);
  });

  it.runIf(hasYes)('a split replaces only the step with the idea and what follows it', async () => {
    const st = state();
    const branch = sw([{ label: 'Electronics', operator: 'Equals', value: 'electronics', steps: tail('el2') }], { id: undefined });
    const o = await runSplitHelper(st, env, pendingSplitIdeas(st)[0], scripted([JSON.stringify({ action: 'route_sizes', signal: 'top_category', paths: [{ label: 'Electronics', operator: 'Equals', value: 'electronics' }] }), JSON.stringify({ action: 'split', branch })]));
    expect(o.status).toBe('split');
    const next = applySplitOutcomes(st, [o]);
    const j = next.campaign.buckets[0].journey as unknown as { kind: string; name?: string; signal?: string; splitIdea?: { status: string } }[];
    expect(j.map((x) => x.kind)).toEqual(['send', 'wait', 'goalCheck', 'branch']);
    expect(j[0].name).toBe('first');
    expect(j[3]).toMatchObject({ signal: 'top_category', splitIdea: { status: 'split' } });
    expect(closingMessage([o])).toMatch(/SPLIT into routes[\s\S]*update your campaign strategy/);
  });

  it('with no data access the idea is left unsplit, with the reason', async () => {
    const st = state();
    const o = await runSplitHelper(st, { ...env, warehouseBank: undefined }, pendingSplitIdeas(st)[0], scripted([]));
    expect(o).toMatchObject({ status: 'not split', result: /No data access/ });
  });

  it('signals menu offers switch-usable signals', () => {
    expect(signalsFor(YES).some((s) => s.usableIn.includes('switch'))).toBe(true);
  });
});
