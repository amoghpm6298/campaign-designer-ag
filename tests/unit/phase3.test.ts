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
import { applyJourneyOps, initialState } from '../../server/agent/state';
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

describe('edit_journey replace_from', () => {
  it('replaces the step and everything after it in that list with one step (e.g. a switch)', () => {
    const j = [send('a'), { kind: 'wait', durationHours: 48 }, send('b'), { kind: 'exit', outcome: 'no_response' }] as never[];
    const r = applyJourneyOps(j, [{ op: 'replace_from', path: '2', step: sw([{ label: 'Electronics', operator: 'Equals', value: 'electronics', steps: tail('el') }]) }]);
    expect(r.errors).toEqual([]);
    expect((r.journey as unknown as { kind: string }[]).map((x) => x.kind)).toEqual(['send', 'wait', 'branch']);
  });
});

describe('the max counts each customer once', () => {
  it.runIf(hasYes)('the same offer before and inside a route: distinct qualifying customers, not the sum', () => {
    const c = camp([send('first', offer), sw([{ label: 'Electronics', operator: 'Equals', value: 'electronics', steps: tail('el', offer) }])]);
    const r = campaignCost(c, ctx(), YES);
    const perCustomer = r.lines[0].maxPerCustomer;
    expect(r.lines).toHaveLength(2);
    expect(r.total.max).toBe(Math.max(...r.lines.map((l) => l.max ?? 0)));
    expect(r.total.max).toBeLessThanOrEqual(45966 * perCustomer);
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
  it('a split is for different treatment: wording-only routes are flagged', () => {
    const same = camp([sw([{ label: 'Electronics', operator: 'Equals', value: 'electronics', steps: tail('el') }, { label: 'Grocery', operator: 'Equals', value: 'grocery', steps: tail('gr') }])]);
    expect(routeProblems(same, ctx(), YES, cost(same)).join(' ')).toMatch(/every route gets the same treatment/);
    const longWait = tail('el');
    (longWait[1] as { durationHours: number }).durationHours = 168;
    const pair = camp([sw([{ label: 'Electronics', operator: 'Equals', value: 'electronics', steps: longWait }, { label: 'Grocery', operator: 'Equals', value: 'grocery', steps: tail('gr') }])]);
    const p = routeProblems(pair, ctx(), YES, cost(pair)).join(' ');
    expect(p).not.toMatch(/every route gets the same treatment/);
    expect(p).toMatch(/routes "Grocery" and "Everyone else" get the same treatment; only the wording differs\. Merge them/);
    const withOffer = camp([sw([{ label: 'Electronics', operator: 'Equals', value: 'electronics', steps: tail('el', offer) }])]);
    expect(routeProblems(withOffer, ctx(), YES, cost(withOffer)).join(' ')).not.toMatch(/same treatment/);
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

  it.runIf(hasYes)('a wording-only split is never applied: after two failed fixes the step is left as it was', async () => {
    const st = state();
    const cosmetic = sw([{ label: 'Electronics', operator: 'Equals', value: 'electronics', steps: tail('el3', { copy: 'Big buys are your thing.' }) }], { id: undefined });
    const o = await runSplitHelper(st, env, pendingSplitIdeas(st)[0], scripted([JSON.stringify({ action: 'split', expectedBenefit: 'More electronics buyers would respond to framing about big buys', branch: cosmetic })]));
    expect(o.status).toBe('not split');
    expect(o.result).toMatch(/same treatment/);
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
    const longer = tail('el2');
    (longer[1] as { durationHours: number }).durationHours = 168; // a different treatment: a longer window for big-ticket buys
    const branch = sw([{ label: 'Electronics', operator: 'Equals', value: 'electronics', steps: longer }], { id: undefined });
    const o = await runSplitHelper(st, env, pendingSplitIdeas(st)[0], scripted([JSON.stringify({ action: 'route_sizes', signal: 'top_category', paths: [{ label: 'Electronics', operator: 'Equals', value: 'electronics' }] }), JSON.stringify({ action: 'split', branch }), JSON.stringify({ action: 'split', expectedBenefit: 'Electronics buyers make bigger, slower purchases; a longer window should convert more of them', branch })]));
    expect(o.status).toBe('split');
    expect(o.result).toMatch(/Expected benefit: Electronics buyers make bigger/);
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

// ── Analyst-only data access, code sizing, repeated offers, personal words at a sentence start ──
import { autoSizeBuckets } from '../../server/agent/autoSize';
import { atSentenceStart, fillFields as fillPersonal } from '../../src/designer/v2/personalFields';
import { dataOverview, warehousePath as whPath } from '../../server/warehouse';
import { systemPrompt as promptFor } from '../../server/agent/prompt';
import { existsSync as exists } from 'node:fs';
import { initialState as fresh } from '../../server/agent/state';
import { resolveTenant as tenantOf } from '../../server/tenants';
import { campaignCost as costOf } from '../../server/costModel';
import { bucketContext as viewsOf } from '../../src/designer/v2/contextView';

const yesData = exists(whPath('yesbank'));
const sig = (attribute: string, operator: string, value: string) => [{ entity: 'Signal', conditions: [{ attribute, operator, value }] }];

describe('data access; code sizes signal buckets', () => {
  it('the agent explores the data itself, can hand bigger questions to the analyst, and keeps internal names away from the manager', () => {
    const p = promptFor(true, true);
    expect(p).toMatch(/start with get_table_schema/);
    expect(p).toMatch(/2-3 queries asking WHY/);
    expect(p).toMatch(/WORKBOOK/);
    expect(p).toMatch(/Never show the manager SQL, signal keys/);
  });
  it.runIf(yesData)('the data overview is plain words: no columns, no internal tables', () => {
    const o = dataOverview('yesbank');
    expect(o).toMatch(/every card transaction/);
    expect(o).not.toMatch(/sqlite_|customer_id|transaction_date/);
  });
  it.runIf(yesData)('signal-rule buckets are sized by code, first match wins; others are pointed at ask_data', () => {
    const st = fresh();
    st.campaign.buckets = [
      { id: 'a', name: 'Long gap', priority: 1, rule: sig('days_since_last_txn', 'Greater than', '180'), journey: [] },
      { id: 'b', name: 'Medium gap', priority: 2, rule: sig('days_since_last_txn', 'Greater than', '60'), journey: [] },
      { id: 'c', name: 'Hand rule', priority: 3, rule: [{ entity: 'Customer', conditions: [] }], journey: [] },
    ] as never;
    const r = autoSizeBuckets(st, tenantOf('TEN-YES'));
    const v = viewsOf(r.state.context.entries);
    expect(v.a.size).toBeGreaterThan(0);
    expect(v.b.size).toBeGreaterThan(0);
    // b excludes a (first match wins): sizing b's query alone would include a's customers.
    expect(v.b.sql).toMatch(/NOT IN/);
    expect(r.notes.join(' ')).toMatch(/"Hand rule" isn't sized.*ask_data with sizeBucket "c"/);
    // Running again with nothing changed files nothing new.
    expect(autoSizeBuckets(r.state, tenantOf('TEN-YES')).state.context.entries.length).toBe(r.state.context.entries.length);
  });
});

describe('a repeated offer on one path is taken up once', () => {
  it.runIf(yesData)('the second send of the same offer only counts those who have not taken it yet', () => {
    const send = (id: string) => ({ id, kind: 'send', name: id, copy: 'x', rationale: 'r', channelPreference: ['WHATSAPP'], incentive: 'cashback_first_spend_100', costAssumptions: { reach: { expected: 0.5, few: 0.4, why: 'w' }, redeem: { expected: 0.2, few: 0.1, why: 'w' } } });
    const st = fresh();
    st.campaign.buckets = [{ id: 'a', name: 'Long gap', priority: 1, rule: sig('days_since_last_txn', 'Greater than', '180'), journey: [send('first')] }] as never;
    const sized = autoSizeBuckets(st, tenantOf('TEN-YES')).state;
    const once = costOf(sized.campaign, sized.context, tenantOf('TEN-YES')).lines[0].expected!;
    sized.campaign.buckets[0].journey = [send('first'), { id: 'w', kind: 'wait', durationHours: 72 }, send('again')] as never;
    const twice = costOf(sized.campaign, sized.context, tenantOf('TEN-YES'));
    // first takes 10%; the second applies to the other 90%.
    expect(twice.lines[1].expected).toBeCloseTo(once * 0.9, -1);
    expect(twice.lines[1].equations.expected).toMatch(/90% who haven't already taken this offer/);
  });
});

describe('personal words at the start of a sentence', () => {
  it('are capitalised', () => {
    expect(fillPersonal('{{top_category | "everyday buys"}} are easy to pick back up.', () => 'groceries')).toBe('Groceries are easy to pick back up.');
    expect(fillPersonal('Nice. {{top_category | "x"}} again?', () => 'dining out')).toBe('Nice. Dining out again?');
    expect(fillPersonal('Spend on {{top_category | "x"}}.', () => 'groceries')).toBe('Spend on groceries.');
    expect(atSentenceStart('Hello! ', 7)).toBe(true);
  });
});

describe('journeys and edits sent as JSON text', () => {
  it('a journey given as JSON text is read, not dropped; bad text is refused plainly', async () => {
    const { upsertBucket } = await import('../../server/agent/state');
    const steps = [{ kind: 'send', name: 'Hi', copy: 'Hello.', rationale: 'r', channelPreference: ['SMS'] }, { kind: 'exit', outcome: 'no_response' }];
    const ok = upsertBucket(fresh(), { id: 'a', name: 'A', rule: [], journey: JSON.stringify(steps) } as never);
    expect(ok.error).toBeUndefined();
    expect(ok.state.campaign.buckets[0].journey).toHaveLength(2);
    expect(upsertBucket(fresh(), { id: 'a', name: 'A', rule: [], journey: '[{kind: send' } as never).error).toMatch(/must be a list of steps/);
  });
  it('edit_journey refuses empty or unreadable operations instead of reporting success', async () => {
    const { runToolCall } = await import('../../server/agent/tools');
    const env = { tenant: tenantOf('TEN-YES'), availableChannels: ['SMS'], goalStatement: '', sessionId: 's', lookupCache: new Map() } as never;
    expect(runToolCall('edit_journey', { bucketId: 'a', operations: 'not json' }, fresh(), env).ok).toBe(false);
  });
});

describe('code sizing leaves out people who are never messaged', () => {
  it.runIf(yesData)('do-not-contact and NPA customers are not counted', () => {
    const st = fresh();
    st.campaign.buckets = [{ id: 'a', name: 'Medium gap', priority: 1, rule: sig('days_since_last_txn', 'Greater than', '60'), journey: [] }] as never;
    const v = viewsOf(autoSizeBuckets(st, tenantOf('TEN-YES')).state.context.entries);
    expect(v.a.sql).toMatch(/NOT IN \(SELECT customer_id FROM dnc_list\)/);
    expect(v.a.sql).toMatch(/npa_list/);
  });
});

describe('questions that need options', () => {
  it('a non-yes/no question without options is sent back; real yes/no questions pass', async () => {
    const { needsOptions } = await import('../../server/agent/tools');
    expect(needsOptions([{ text: 'How many **messages** is it okay to send?' }, { text: 'Should the push run the whole of January, or wrap up sooner?' }])).toHaveLength(2);
    expect(needsOptions([{ text: 'Should customers be able to join mid-campaign?' }, { text: 'How many messages?', options: ['2', '3'] }])).toEqual([]);
  });
});

describe('offers behind a route nobody can count in advance', () => {
  it.runIf(yesData)('are costed on the whole group above it, and say so', () => {
    const send = { id: 'o', kind: 'send', name: 'Offer', copy: 'x', rationale: 'r', channelPreference: ['WHATSAPP'], incentive: 'cashback_first_spend_100', costAssumptions: { reach: { expected: 0.3, few: 0.2, why: 'w' }, redeem: { expected: 0.1, few: 0.05, why: 'w' } } };
    const st = fresh();
    st.campaign.buckets = [
      { id: 'a', name: 'Long gap', priority: 1, rule: sig('days_since_last_txn', 'Greater than', '90'), journey: [{ id: 'sw', kind: 'branch', signal: 'read_last_message', label: 'Read it?', rationale: 'r', paths: [{ label: 'Read', operator: 'Is', value: 'true', steps: [send] }], otherwise: [{ ...send, id: 'o2' }] }] },
    ] as never;
    const sized = autoSizeBuckets(st, tenantOf('TEN-YES')).state;
    const r = costOf(sized.campaign, sized.context, tenantOf('TEN-YES'));
    expect(r.total.expected).toBeGreaterThan(0);
    expect(r.lines[0].equations.expected).toMatch(/the whole group/);
    expect(r.routes.find((x) => x.label === 'Read')!.size).toBeNull();
  });
});
