// Phase 1: the signals menu, the incentive menu, and the tools that serve them.
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalCondition, conditionSql, signalConditionProblem, signalConditionText, signalsFor, signalsForAgent, resolveSignalSql } from '../../server/signals';
import { incentivesFor, qualifyingShare, validFor } from '../../server/incentives';
import { resolveTenant } from '../../server/tenants';
import { runWarehouseQuery, warehousePath } from '../../server/warehouse';
import { buildFromBlueprint, type BpStep } from '../../server/blueprint';
import { planToBlueprint } from '../../server/agent/compile';
import { runToolCall, toolsFor, type ToolEnv } from '../../server/agent/tools';
import { initialState } from '../../server/agent/state';
import { systemPrompt } from '../../server/agent/prompt';
import { campaignBrief } from '../../server/mcp/brief';
import type { CampaignObject } from '../../server/agent/types';

const YES = resolveTenant('TEN-YES')!;
const DEMO = resolveTenant('TEN-DEMO')!;
const hasYes = existsSync(warehousePath('yesbank'));
const env = (tenant = YES): ToolEnv => ({ tenant, availableChannels: ['SMS', 'WHATSAPP'], goalStatement: 'x', sessionId: 's1', lookupCache: new Map(), ...(hasYes && tenant === YES ? { warehouseBank: 'yesbank' } : {}) });

beforeEach(() => {
  process.env.CAMPAIGN_DIR = mkdtempSync(join(tmpdir(), 'cd-sig-'));
});

describe('signals menu', () => {
  it('a bank without data has only journey signals', () => {
    const s = signalsFor(DEMO);
    expect(s.every((x) => x.kind === 'journey')).toBe(true);
    expect(s.map((x) => x.key)).toContain('read_last_message');
  });

  it.runIf(hasYes)('a bank with data has the data signals, values from its data, and SQL hidden from the agent', () => {
    const s = signalsFor(YES);
    expect(s.map((x) => x.key)).toEqual(expect.arrayContaining(['spend_90d', 'top_category', 'days_since_last_txn', 'emi_eligible', 'logo', 'card_activated']));
    expect(s.find((x) => x.key === 'top_category')!.values).toContain('grocery');
    expect(s.find((x) => x.key === 'logo')!.values).toContain('YES BANK ACE');
    expect(s.some((x) => x.key === 'card_type')).toBe(false); // one card per customer is gone: logos and cards replace it
    expect(JSON.stringify(signalsForAgent(s))).not.toMatch(/SELECT/);
  });

  it.runIf(hasYes)('every data signal runs on the warehouse and returns customer_id, value', () => {
    for (const s of signalsFor(YES).filter((x) => x.sql)) {
      const r = runWarehouseQuery('yesbank', `SELECT * FROM (${resolveSignalSql(s.sql!)}) LIMIT 3`);
      expect(r.columns, s.key).toEqual(['customer_id', 'value']);
      expect(r.rows.length, s.key).toBeGreaterThan(0);
    }
  });

  it('checks conditions: unknown signal, wrong operator, bad value, wrong place', () => {
    const s = signalsFor(DEMO).concat([{ key: 'spend_90d', label: 'Spend', type: 'money', kind: 'behaviour', definition: '', usableIn: ['rule'], status: 'proposed', sensitivity: 'normal' }, { key: 'top_category', label: 'Top', type: 'category', kind: 'behaviour', definition: '', values: ['grocery', 'fuel'], usableIn: ['rule'], status: 'proposed', sensitivity: 'normal' }]);
    expect(signalConditionProblem(s, { attribute: 'made_up', operator: 'Equals', value: '1' }, 'rule')).toMatch(/not a signal/);
    expect(signalConditionProblem(s, { attribute: 'spend_90d', operator: 'Any of', value: '1' }, 'rule')).toMatch(/takes/);
    expect(signalConditionProblem(s, { attribute: 'spend_90d', operator: 'Greater than', value: 'lots' }, 'rule')).toMatch(/number/);
    expect(signalConditionProblem(s, { attribute: 'top_category', operator: 'Equals', value: 'travel' }, 'rule')).toMatch(/no value "travel"/);
    expect(signalConditionProblem(s, { attribute: 'read_last_message', operator: 'Is', value: 'true' }, 'rule')).toMatch(/can't be used in a bucket rule/);
    expect(signalConditionProblem(s, { attribute: 'spend_90d', operator: 'Between', value: '1000,5000' }, 'rule')).toBeNull();
    expect(signalConditionText(s, { attribute: 'spend_90d', operator: 'Greater than', value: '20000' })).toBe('Spend more than ₹20,000');
  });

  it('common operator spellings and value lists become the builder\'s spelling; the menu lists operators', () => {
    const s = signalsFor(DEMO).concat([{ key: 'top_category', label: 'Top', type: 'category', kind: 'behaviour', definition: '', values: ['grocery', 'fuel'], usableIn: ['switch'], status: 'proposed', sensitivity: 'normal' }, { key: 'spend_90d', label: 'Spend', type: 'money', kind: 'behaviour', definition: '', usableIn: ['switch'], status: 'proposed', sensitivity: 'normal' }]);
    expect(canonicalCondition(s, { attribute: 'top_category', operator: '=', value: 'grocery' })).toMatchObject({ operator: 'Equals', value: 'grocery' });
    expect(canonicalCondition(s, { attribute: 'top_category', operator: 'in', value: ['grocery', 'fuel'] })).toMatchObject({ operator: 'Any of', value: 'grocery,fuel' });
    expect(canonicalCondition(s, { attribute: 'top_category', operator: 'in', value: ['grocery'] })).toMatchObject({ operator: 'Equals', value: 'grocery' });
    expect(canonicalCondition(s, { attribute: 'spend_90d', operator: '>', value: 20000 })).toMatchObject({ operator: 'Greater than', value: '20000' });
    expect(canonicalCondition(s, { attribute: 'read_last_message', operator: '=', value: 'true' })).toMatchObject({ operator: 'Is' });
    expect(signalsForAgent(s).find((x) => x.key === 'top_category')!.operators).toEqual(['Equals', 'Not Equals', 'Any of']);
  });

  it.runIf(hasYes)('a condition becomes SQL that selects the right customers', () => {
    const s = signalsFor(YES);
    const sql = conditionSql(s, { attribute: 'top_category', operator: 'Equals', value: 'grocery' })!;
    const n = Number(runWarehouseQuery('yesbank', `SELECT COUNT(*) AS n FROM (${sql})`).rows[0].n);
    expect(n).toBeGreaterThan(0);
  });
});

describe('bucket rules on signals', () => {
  const send = { kind: 'send', name: 'Nudge', stage: 'first-touch', describe: 'Nudge', rationale: 'r', objective: ['activation'], channelPreference: ['SMS'] };
  const journey = [send, { kind: 'wait', durationHours: 72 }, { kind: 'goalCheck' }, { kind: 'exit', reason: 'End', outcome: 'no_response' }] as unknown as BpStep[];
  const campaign = (rule: unknown[]): CampaignObject =>
    ({ name: 'A', goal: { eventCategory: 'Card Events', eventType: 'Card Activated' }, entry: { kind: 'audience', entity: 'Card' }, membership: { type: 'locked' }, everyoneElse: { approach: 'none' }, buckets: [{ id: 'b1', name: 'Big spenders', priority: 1, rule, journey }] }) as unknown as CampaignObject;
  const signals = [{ key: 'spend_90d', label: 'Spend', type: 'money' as const, kind: 'behaviour' as const, definition: '', usableIn: ['rule' as const], status: 'proposed' as const, sensitivity: 'normal' as const }];
  const build = (rule: unknown[]) => buildFromBlueprint(planToBlueprint(campaign(rule)).blueprint!, { availableChannels: ['SMS'], templateLibraryAccess: 'unavailable', signals });

  it('builds with a known signal', () => {
    const r = build([{ entity: 'Signal', conditions: [{ attribute: 'spend_90d', operator: 'Greater than', value: '20000' }] }]);
    expect(JSON.stringify(r.issues ?? [])).not.toMatch(/signal/i);
    const g = r.graph as { nodes: Record<string, { type: string; _config?: { audienceGroups?: { entity: string }[] } }> };
    expect(Object.values(g.nodes).some((n) => n._config?.audienceGroups?.some((x) => x.entity === 'Signal'))).toBe(true);
  });

  it('refuses an unknown signal, by name', () => {
    const r = build([{ entity: 'Signal', conditions: [{ attribute: 'vip_score', operator: 'Greater than', value: '5' }] }]);
    expect((r.issues ?? []).map((i) => i.problem).join(' ')).toMatch(/"vip_score" is not a signal/);
  });
});

describe('incentive menu', () => {
  it('banks without a menu have none; special offers only, never plain features', () => {
    expect(incentivesFor(DEMO)).toEqual([]);
    const list = incentivesFor(YES);
    expect(list.length).toBeGreaterThan(4);
    expect(list.map((i) => i.id)).not.toContain('emi_conversion');
    expect(list.find((i) => i.id === 'emi_rate_discount')!.requires.map((c) => c.attribute)).toContain('emi_eligible');
    expect(list.find((i) => i.id === 'annual_fee_waiver')!.cost.feeByCardType).toHaveProperty('Yes First Exclusive');
  });

  it('valid only within its dates and while live', () => {
    const i = incentivesFor(YES)[0];
    expect(validFor(i, { startDate: '2026-12-01', endDate: '2026-12-20' }, '2026-11-19')).toBe(true);
    expect(validFor(i, { startDate: '2027-03-20', endDate: '2027-04-20' }, '2026-11-19')).toBe(false);
    expect(validFor({ ...i, status: 'paused' }, null, '2026-11-19')).toBe(false);
  });

  it.runIf(hasYes)('counts who in a group meets the requirements and the targeting', () => {
    const s = signalsFor(YES);
    const i = incentivesFor(YES).find((x) => x.id === 'no_cost_emi_electronics')!;
    const q = qualifyingShare('yesbank', s, 'SELECT customer_id FROM customers WHERE is_active = 1', i);
    if ('error' in q) throw new Error(q.error);
    expect(q.size).toBeGreaterThan(q.meetRequires);
    expect(q.meetRequires).toBeGreaterThan(q.qualify);
    expect(q.qualify).toBeGreaterThan(0);
  });
});

describe('tools and prompt', () => {
  it('list_incentives is offered only with a menu; list_signals always', () => {
    expect(toolsFor(false).map((t) => t.name)).toContain('list_signals');
    expect(toolsFor(false).map((t) => t.name)).not.toContain('list_incentives');
    expect(toolsFor(false, true).map((t) => t.name)).toContain('list_incentives');
  });

  it('list_incentives returns valid offers cheapest first, labelled mock', () => {
    const r = runToolCall('list_incentives', {}, initialState(), env());
    const list = r.result as { maxCostPerCustomer: number; terms: string }[];
    expect(list.map((x) => x.maxCostPerCustomer)).toEqual([...list.map((x) => x.maxCostPerCustomer)].sort((a, b) => a - b));
    expect(list.every((x) => x.terms.length > 10)).toBe(true);
    expect(r.forModel).toMatch(/MOCK/);
    expect(runToolCall('list_incentives', {}, initialState(), env(DEMO)).forModel).toMatch(/no incentive menu/);
  });

  it('the prompt has the speed vs spend aspect only for banks with a menu; never invent', () => {
    expect(systemPrompt(true, true)).toMatch(/SPEED VS SPEND/);
    expect(systemPrompt(true, true)).toMatch(/topic "Spend"/);
    expect(systemPrompt(true, false)).not.toMatch(/SPEED VS SPEND/);
    expect(systemPrompt(true, false)).toMatch(/ALREADY AVAILABLE/);
    for (const p of [systemPrompt(true, true), systemPrompt(false, false)]) expect(p).toMatch(/Never invent or promise an incentive/);
    expect(systemPrompt(false)).toMatch(/list_signals/);
  });

  it('the MCP brief carries the spend appetite', () => {
    const c = { goal: null, entry: null, membership: null, buckets: [], everyoneElse: null } as unknown as CampaignObject;
    const ctx = { entries: [{ kind: 'brief', topic: 'Spend', text: 'Cheapest first; budget ₹2L', source: 'manager', at: new Date().toISOString() }] };
    expect(campaignBrief(c, ctx as never).spendAppetite).toBe('Cheapest first; budget ₹2L');
  });
});
