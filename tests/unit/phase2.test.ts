// Phase 2: offers in journeys, the cost calculator, the checks, the budget pass, the engine export.
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { campaignCost, costChange, costLine, shortInr } from '../../server/costModel';
import { listVersions } from '../../server/campaignVersions';
import { statusBlock, systemPrompt } from '../../server/agent/prompt';
import { initialState } from '../../server/agent/state';
import { offerProblems } from '../../server/agent/offerChecks';
import { toEngineCampaign, REASONING_FIELDS } from '../../server/engineExport';
import { withOfferLine, assembleSms } from '../../src/designer/v2/smsText';
import { diffCampaigns } from '../../server/agent/versionDiff';
import { resolveTenant } from '../../server/tenants';
import { warehousePath } from '../../server/warehouse';
import { saveCampaignObject, saveContext, loadStores } from '../../server/campaignFiles';
import { directEdit } from '../../server/agent/directEdit';
import type { CampaignContext, CampaignObject } from '../../server/agent/types';

const YES = resolveTenant('TEN-YES')!;
const hasYes = existsSync(warehousePath('yesbank'));
const NO_DATA = { incentives: true } as never;
const at = new Date().toISOString();
const LAPSED_SQL = "SELECT customer_id FROM customers WHERE is_active = 1 AND customer_id IN (SELECT customer_id FROM transactions GROUP BY customer_id HAVING MAX(transaction_date) < date((SELECT MAX(transaction_date) FROM transactions), '-90 day'))";

const offerSend = (extra: Record<string, unknown> = {}) => ({
  id: 's-offer',
  kind: 'send',
  name: 'Comeback offer',
  rationale: 'r',
  copy: 'Your card is ready when you are.',
  channelPreference: ['SMS'],
  incentive: 'cashback_first_spend_100',
  costAssumptions: { reach: { expected: 0.6, few: 0.6, why: 'judgement' }, redeem: { expected: 0.15, few: 0.05, why: 'judgement' } },
  ...extra,
});
const journey = (send: Record<string, unknown>) => [send, { id: 's-w', kind: 'wait', durationHours: 72, rationale: 'w' }, { id: 's-g', kind: 'goalCheck' }, { id: 's-e', kind: 'exit', reason: 'End', outcome: 'no_response' }];
const campaign = (send: Record<string, unknown> = offerSend(), extra: Partial<CampaignObject> = {}): CampaignObject =>
  ({
    name: 'Diwali',
    goal: { eventCategory: 'Transaction Events', eventType: 'Transaction' },
    entry: { kind: 'audience', entity: 'Customer' },
    membership: { type: 'locked' },
    schedule: { startDate: '2026-12-01', endDate: '2026-12-20' },
    everyoneElse: { approach: 'none' },
    buckets: [{ id: 'lapsed', name: 'Lapsed', priority: 1, rule: [{ entity: 'Card', conditions: [] }], journey: journey(send) }],
    ...extra,
  }) as unknown as CampaignObject;
const context = (withNotes = true, size = 2000): CampaignContext => ({
  entries: [
    { id: 'c1', at, kind: 'sizing', bucketId: 'lapsed', topic: 'size', text: 'Lapsed', source: 'agent', data: { sql: LAPSED_SQL, size } },
    { id: 'c2', at, kind: 'bucket', bucketId: 'lapsed', topic: 'evidence', text: 'measured', source: 'agent', data: { level: 'measured' } },
    ...(withNotes
      ? [
          { id: 'c3', at, kind: 'note' as const, topic: 'incentive strategy', text: 'Lapsed: ₹100 cashback.', source: 'agent' as const },
          { id: 'c4', at, kind: 'brief' as const, topic: 'Spend', text: 'Cheapest first.', source: 'manager' as const },
        ]
      : []),
  ],
} as unknown as CampaignContext);

beforeEach(() => {
  process.env.CAMPAIGN_DIR = mkdtempSync(join(tmpdir(), 'cd-p2-'));
});

describe('the offer line is added by the system, like a link', () => {
  it('goes after the copy and before the CTA and link', () => {
    expect(withOfferLine('Your card is ready', 'Get ₹100 cashback.')).toBe('Your card is ready. Get ₹100 cashback.');
    expect(assembleSms('Your card is ready', 'Spend now', 'https://y.es/a', 'Get ₹100 cashback.')).toBe('Your card is ready. Get ₹100 cashback. Spend now: https://y.es/a');
  });
});

describe('cost calculator', () => {
  it('with no data access: per 1,000 customers, from the estimates and the menu', () => {
    const r = campaignCost(campaign(), context(), NO_DATA);
    expect(r.mode).toBe('perThousand');
    // 1,000 × 60% × 15% × ₹100
    expect(r.total.expected).toBe(9000);
    expect(r.total.under).toBe(3000);
    expect(r.total.max).toBe(100000);
    expect(r.lines[0].equations.expected).toMatch(/1,000 customers × 60% reach × 15% take it up × ₹100 = ₹9,000/);
  });

  it.runIf(hasYes)('with data: sizes and who qualifies come from the data; the max is everyone who qualifies at the most per customer', () => {
    const r = campaignCost(campaign(), context(), YES);
    expect(r.mode).toBe('totals');
    const l = r.lines[0];
    expect(l.customers).toBe(2000);
    expect(l.qualified).toBeGreaterThan(0);
    expect(r.total.expected).toBe(Math.round(l.qualified! * 0.6 * 0.15 * 100));
    expect(r.total.max).toBe(l.qualified! * 100);
  });

  it('the budget cap limits the max; costLine says so', () => {
    const r = campaignCost(campaign(offerSend(), { budgetCap: 50000 }), context(), NO_DATA);
    expect(r.total.maxWithCap).toBe(50000);
    expect(costLine(r)).toMatch(/capped at ₹50,000/);
  });

  it('the max counts an offer once per bucket, even on two routes', () => {
    const send2 = { ...offerSend(), id: 's-offer-2', name: 'Retry with offer' };
    const c = campaign();
    c.buckets[0].journey = [{ kind: 'branch', label: 'Read?', rationale: 'r', paths: [{ label: 'Read', statuses: ['READ'], steps: journey(offerSend()) }], otherwise: journey(send2) }] as never;
    const r = campaignCost(c, context(), NO_DATA);
    expect(r.lines).toHaveLength(2);
    expect(r.total.max).toBe(100000);
    expect(r.total.expected).toBe(18000);
  });

  it('confidence is high only when take-up comes from past results', () => {
    const judged = campaignCost(campaign(), context(), NO_DATA).lines[0];
    expect(judged.confidence).toBe('medium');
    const noHist = campaignCost(campaign(offerSend({ costAssumptions: { reach: { expected: 0.5, few: 0.4, why: 'No campaign history for this bank. Judgement.' }, redeem: { expected: 0.1, few: 0.05, why: 'No campaign history.' } } })), context(), NO_DATA).lines[0];
    expect(noHist.confidence).toBe('medium');
    const past = campaignCost(campaign(offerSend({ costAssumptions: { reach: { expected: 0.5, few: 0.4, why: 'From the last campaign: 52% read.' }, redeem: { expected: 0.1, few: 0.05, why: 'Previous campaign measured take-up of 11%.' } } })), context(), NO_DATA).lines[0];
    expect(past.confidence).toBe('high');
  });

  it('a holdout reduces who gets the offer', () => {
    const c = campaign();
    c.buckets[0].holdoutPct = 10;
    expect(campaignCost(c, context(), YES).lines[0].customers).toBe(hasYes ? 1800 : 1000);
  });
});

describe('offer checks', () => {
  it('a clean offer passes', () => {
    expect(offerProblems(campaign(), context(), NO_DATA).problems).toEqual([]);
  });
  it('an unknown offer, amounts in the copy, and missing estimates are flagged', () => {
    expect(offerProblems(campaign(offerSend({ incentive: 'free_iphone' })), context(), NO_DATA).problems.join(' ')).toMatch(/not an offer on this bank's menu/);
    expect(offerProblems(campaign(offerSend({ copy: 'Get ₹100 back!' })), context(), NO_DATA).problems.join(' ')).toMatch(/states an amount/);
    expect(offerProblems(campaign(offerSend({ costAssumptions: undefined })), context(), NO_DATA).problems.join(' ')).toMatch(/needs costAssumptions/);
  });
  it('needs the incentive strategy note and the Spend brief', () => {
    const p = offerProblems(campaign(), context(false), NO_DATA).problems.join(' ');
    expect(p).toMatch(/no incentive strategy/);
    expect(p).toMatch(/Spend/);
  });
  it('the budget pass: "as expected" over the cap asks the agent to cut offers, not people', () => {
    const p = offerProblems(campaign(offerSend(), { budgetCap: 5000 }), context(), YES).problems.join(' ');
    if (hasYes) expect(p).toMatch(/BUDGET PASS.*cut offers, not people/s);
  });
  it.runIf(hasYes)('an offer most of the bucket does not qualify for is flagged', () => {
    const p = offerProblems(campaign(offerSend({ incentive: 'no_cost_emi_electronics' })), context(), YES).problems.join(' ');
    expect(p).toMatch(/qualify for "No-cost EMI on electronics"/);
  });
});

describe('engine export', () => {
  it('keeps only what runs: no reasoning, offers resolved with their exact line and terms', () => {
    const { engine, problems } = toEngineCampaign(campaign(offerSend({ describe: 'why', objective: ['spend'], hypothesis: 'h' })), YES);
    expect(problems).toEqual([]);
    const json = JSON.stringify(engine);
    for (const f of REASONING_FIELDS) expect(json).not.toContain(`"${f}"`);
    expect((engine.offers as { offerLine: string }[])[0].offerLine).toMatch(/₹100 cashback/);
    expect(engine.format).toBe('cd-engine-1');
  });
  it('flags what the engine cannot run', () => {
    const { problems } = toEngineCampaign(campaign(offerSend({ copy: '' })), YES);
    expect(problems.join(' ')).toMatch(/no message copy/);
  });
});

describe('estimates and the cap are the manager\'s to change, with no agent', () => {
  it('a cost estimate change is not a design change', () => {
    const a = campaign();
    const b = campaign(offerSend({ costAssumptions: { reach: { expected: 0.5, few: 0.4, why: 'x' }, redeem: { expected: 0.1, few: 0.05, why: 'x' } } }));
    expect(diffCampaigns(a, b).counts).toEqual({ added: 0, changed: 0, removed: 0 });
  });
  it('direct edits set an estimate (marked as yours) and the budget cap', () => {
    saveCampaignObject('cv-p2', 'TEN-YES', campaign());
    saveContext('cv-p2', 'TEN-YES', context());
    const r = directEdit('cv-p2', 'TEN-YES', { op: 'costAssumption', bucketId: 'lapsed', stepId: 's-offer', which: 'redeem', expected: 10, few: 4 });
    expect(r.ok).toBe(true);
    const step = loadStores('cv-p2').campaign!.buckets[0].journey![0] as unknown as { costAssumptions: { redeem: { expected: number; why: string } } };
    expect(step.costAssumptions.redeem).toMatchObject({ expected: 0.1, why: 'Set by the manager.' });
    expect(directEdit('cv-p2', 'TEN-YES', { op: 'costAssumption', bucketId: 'lapsed', stepId: 's-offer', which: 'redeem', expected: 5, few: 9 }).error).toMatch(/no higher/);
    expect(directEdit('cv-p2', 'TEN-YES', { op: 'budgetCap', value: 200000 }).ok).toBe(true);
    expect(loadStores('cv-p2').campaign!.budgetCap).toBe(200000);
  });
});

describe('version history shows what each change did to the cost', () => {
  it('words the change briefly', () => {
    const snap = (expected: number, max: number, cap: number | null = null) => ({ under: 0, expected, max, cap, unit: 'totals' as const });
    expect(costChange(snap(160000, 1300000), snap(95000, 500000, 500000))).toBe('As expected ₹1.6L → ₹95k · Max ₹13L → ₹5L · Cap none → ₹5L');
    expect(costChange(null, snap(90000, 1000000))).toBe('Offers added: as expected ₹90k · max ₹10L');
    expect(costChange(snap(90000, 1000000), null)).toBe('Offers removed: no spend on offers');
    expect(costChange(snap(1, 2), snap(1, 2))).toBeNull();
    expect(costChange(undefined, snap(1, 2))).toBeNull();
    expect(shortInr(800)).toBe('₹800');
  });

  it('an estimate change (not a design change) still gets a version, with its cost line', () => {
    saveCampaignObject('cv-p2v', 'TEN-YES', campaign());
    saveContext('cv-p2v', 'TEN-YES', context());
    expect(directEdit('cv-p2v', 'TEN-YES', { op: 'budgetCap', value: 400000 }).ok).toBe(true);
    expect(directEdit('cv-p2v', 'TEN-YES', { op: 'costAssumption', bucketId: 'lapsed', stepId: 's-offer', which: 'redeem', expected: 30, few: 10 }).ok).toBe(true);
    const vs = listVersions('cv-p2v');
    const last = vs[vs.length - 1];
    expect(last.costChange).toBe('As expected ₹18k → ₹36k');
    expect(vs.some((v) => /Offer budget cap: no cap → ₹4,00,000/.test(v.summary))).toBe(true);
  });
});

describe('the agent keeps its incentive strategy in view', () => {
  it('the status block carries the strategy note every turn; the prompt says to keep it current', () => {
    const st = { ...initialState(), campaign: campaign(), context: context() };
    expect(statusBlock(st)).toMatch(/## Your incentive strategy[\s\S]*Lapsed: ₹100 cashback/);
    expect(systemPrompt(true, true)).toMatch(/update the incentive strategy note to match/);
    expect(systemPrompt(true, true)).not.toMatch(/escalated offer at most once/);
  });
  it('rules only the engine can check are flagged: counts and cost may be lower', () => {
    const r = campaignCost(campaign(offerSend({ incentive: 'annual_fee_waiver' })), context(), NO_DATA);
    expect(r.lines[0].engineOnly.join(' ')).toMatch(/fee waiver in the last 12 months/);
    expect(r.notes.join(' ')).toMatch(/may be lower than shown, because the engine also checks/);
  });
});
