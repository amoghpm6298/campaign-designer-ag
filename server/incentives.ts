// The incentive menu: special offers a campaign may use, on top of what the
// customer is already eligible for, each with its cost to the bank. The agent
// picks by id and never invents one. Features the customer already has (EMI
// conversion at the standard rate, the virtual card, points already earned)
// are not incentives: they are things to talk about in messages.
//
// The menu lives in one file per bank, managed by the bank's ops team on the
// Offers page:
//
//   <CAMPAIGN_DIR>/../incentives/<tenantId>.json
//
// Until a bank's ops team saves its first change, the bank gets the example
// menu below (standard credit card offers with dummy figures), marked as such.
// Offers are never deleted, only paused: campaigns refer to them by id.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { campaignDir } from './campaignFiles';
import type { TenantConfig } from './tenants';
import { canonicalCondition, conditionSql, signalConditionProblem, signalConditionText, signalsFor, type Signal, type SignalCondition } from './signals';
import { runWarehouseQuery, warehouseAvailable } from './warehouse';

export type CostType = 'flat' | 'pctOfSpend' | 'interest' | 'cardFee';

export interface Incentive {
  id: string;
  label: string;
  /** small or big: its rung on the cost ladder (0 is messages only, so never an incentive). */
  size: 'small' | 'big';
  /** What the customer gets. */
  mechanic: string;
  /** What the customer must do to earn it. */
  trigger: { action: 'spend' | 'first_spend' | 'emi_conversion'; minAmount?: number; withinDays: number; category?: string };
  /** Campaign goal events this trigger serves (a spend goal needs a spend-triggered offer). */
  fitsGoals: string[];
  /** How its cost to the bank is worked out (by code, in the cost calculator). */
  costType: CostType;
  cost: { perRedemption?: number; ratePct?: number; capPerCustomer?: number; interestDiscountPctPa?: number; feeByCardType?: Record<string, number> };
  /** The most one customer can cost the bank, for ordering the menu. */
  maxCostPerCustomer: number;
  /** Product eligibility it depends on: set by the bank's policy, never granted by a campaign. */
  requires: SignalCondition[];
  /** Who the offer is meant for, beyond what it requires. */
  eligibility: SignalCondition[];
  /**
   * Eligibility rules that can't be written in signals: the engine checks them when it issues the offer.
   * They only ever narrow who qualifies, so design-time counts and costs are an upper bound.
   */
  unmatchedCriteria: string[];
  validFrom: string;
  validTo: string;
  /** Exact terms, to be quoted in messages. */
  terms: string;
  /**
   * The offer as the customer reads it, exactly. The agent never writes it:
   * it attaches the offer by id and the system puts this line into the
   * message (after the copy, before the CTA/link), like a link.
   */
  offerLine: string;
  /** live: the designer may use it · paused: kept, but not offered to new or existing campaigns · draft: being set up. */
  status: 'live' | 'paused' | 'draft';
  /** Example data, not the bank's real offer. */
  mock?: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

const VALID = { validFrom: '2026-11-01', validTo: '2027-03-31' };

function mockLibrary(feeByCardType: Record<string, number>): Incentive[] {
  return [
    {
      id: 'emi_fee_waiver',
      label: 'EMI processing fee waiver',
      size: 'small',
      mechanic: 'No processing fee when converting a purchase to EMI.',
      trigger: { action: 'emi_conversion', minAmount: 5000, withinDays: 30 },
      fitsGoals: ['EMI conversion', 'Transaction'],
      costType: 'flat',
      cost: { perRedemption: 199 },
      maxCostPerCustomer: 199,
      requires: [{ attribute: 'emi_eligible', operator: 'Is', value: 'true' }],
      eligibility: [],
      unmatchedCriteria: [],
      ...VALID,
      terms: 'Zero processing fee (usually ₹199 + GST) on converting a purchase of ₹5,000 or more to EMI within 30 days. One conversion per customer.',
      offerLine: 'Zero processing fee when you convert ₹5,000+ to EMI within 30 days. T&Cs apply.',
      status: 'live',
    },
    {
      id: 'points_2x_category',
      label: '2x reward points on a category',
      size: 'small',
      mechanic: 'Double reward points on spends in one category for 30 days.',
      trigger: { action: 'spend', withinDays: 30 },
      fitsGoals: ['Transaction'],
      costType: 'pctOfSpend',
      cost: { ratePct: 0.25, capPerCustomer: 200 },
      maxCostPerCustomer: 200,
      requires: [],
      eligibility: [],
      unmatchedCriteria: [],
      ...VALID,
      terms: '2x reward points on spends in the chosen category for 30 days from the offer date. Extra points capped at 800 (worth ₹200).',
      offerLine: '2x reward points on this category for 30 days (up to 800 extra points). T&Cs apply.',
      status: 'live',
    },
    {
      id: 'cashback_first_spend_100',
      label: '₹100 cashback on first spend',
      size: 'small',
      mechanic: '₹100 cashback on a first spend after a gap.',
      trigger: { action: 'first_spend', minAmount: 1000, withinDays: 14 },
      fitsGoals: ['Transaction'],
      costType: 'flat',
      cost: { perRedemption: 100 },
      maxCostPerCustomer: 100,
      requires: [],
      eligibility: [{ attribute: 'days_since_last_txn', operator: 'Greater than', value: '60' }],
      unmatchedCriteria: [],
      ...VALID,
      terms: '₹100 cashback on your first card spend of ₹1,000 or more within 14 days. Credited within 30 days. One per customer.',
      offerLine: 'Get ₹100 cashback on your first spend of ₹1,000+ within 14 days. T&Cs apply.',
      status: 'live',
    },
    {
      id: 'milestone_25k_voucher_500',
      label: 'Spend milestone: ₹500 voucher',
      size: 'big',
      mechanic: 'A ₹500 voucher for spending ₹25,000 in 30 days.',
      trigger: { action: 'spend', minAmount: 25000, withinDays: 30 },
      fitsGoals: ['Transaction'],
      costType: 'flat',
      cost: { perRedemption: 500 },
      maxCostPerCustomer: 500,
      requires: [],
      eligibility: [{ attribute: 'spend_90d', operator: 'Less than', value: '75000' }],
      unmatchedCriteria: [],
      ...VALID,
      terms: 'Spend ₹25,000 or more on your card within 30 days and get a ₹500 shopping voucher. Excludes fuel, rent and wallet loads. One per customer.',
      offerLine: 'Spend ₹25,000 in 30 days and get a ₹500 voucher. T&Cs apply.',
      status: 'live',
    },
    {
      id: 'annual_fee_waiver',
      label: 'Annual fee waiver',
      size: 'big',
      mechanic: "Next year's annual fee waived for spending ₹50,000 in 90 days.",
      trigger: { action: 'spend', minAmount: 50000, withinDays: 90 },
      fitsGoals: ['Transaction'],
      costType: 'cardFee',
      cost: { feeByCardType },
      maxCostPerCustomer: Math.max(0, ...Object.values(feeByCardType)),
      requires: [],
      eligibility: [],
      unmatchedCriteria: ['Not given a fee waiver in the last 12 months (the engine checks).'],
      ...VALID,
      terms: "Spend ₹50,000 or more within 90 days and next year's annual fee is waived. Not valid with any other fee waiver in the same year.",
      offerLine: "Spend ₹50,000 in 90 days and next year's annual fee is waived. T&Cs apply.",
      status: 'live',
    },
    {
      id: 'emi_rate_discount',
      label: 'EMI interest discount',
      size: 'big',
      mechanic: 'EMI at 13% a year instead of the standard 16%.',
      trigger: { action: 'emi_conversion', minAmount: 10000, withinDays: 30 },
      fitsGoals: ['EMI conversion', 'Transaction'],
      costType: 'interest',
      cost: { interestDiscountPctPa: 3 },
      maxCostPerCustomer: 1500,
      requires: [
        { attribute: 'emi_eligible', operator: 'Is', value: 'true' },
        { attribute: 'max_emi_amount', operator: 'Greater than', value: '9999' },
      ],
      eligibility: [],
      unmatchedCriteria: [],
      ...VALID,
      terms: 'Convert a purchase of ₹10,000 or more to EMI within 30 days at 13% p.a. (standard 16% p.a.). Tenures 3 to 12 months. Processing fee applies.',
      offerLine: 'EMI at 13% p.a. (usually 16%) on ₹10,000+ converted within 30 days. T&Cs apply.',
      status: 'live',
    },
    {
      id: 'no_cost_emi_electronics',
      label: 'No-cost EMI on electronics',
      size: 'big',
      mechanic: 'Zero-interest EMI on electronics purchases; the bank pays the interest.',
      trigger: { action: 'emi_conversion', minAmount: 10000, withinDays: 30, category: 'electronics' },
      fitsGoals: ['EMI conversion', 'Transaction'],
      costType: 'interest',
      cost: { interestDiscountPctPa: 16 },
      maxCostPerCustomer: 5000,
      requires: [
        { attribute: 'emi_eligible', operator: 'Is', value: 'true' },
        { attribute: 'max_emi_amount', operator: 'Greater than', value: '9999' },
      ],
      eligibility: [{ attribute: 'top_category', operator: 'Equals', value: 'electronics' }],
      unmatchedCriteria: [],
      ...VALID,
      terms: 'No-cost EMI (0% interest) on electronics purchases of ₹10,000 or more converted within 30 days, for 3 or 6 months. Processing fee applies.',
      offerLine: 'No-cost EMI on electronics of ₹10,000+ for 3 or 6 months. T&Cs apply.',
      status: 'live',
    },
  ];
}

/** Annual fees per card variant: assumed for the mock (the mock data has card variants, not fees). */
const MOCK_FEES: Record<string, Record<string, number>> = {
  yesbank: { 'Yes Prosperity Edge': 499, 'Yes First Preferred': 999, 'Yes First Exclusive': 2499 },
  indusind: { 'IndusInd Nexxt': 499, 'IndusInd Platinum Aura': 999, 'IndusInd Legend': 1499, 'IndusInd Pinnacle': 2499 },
};

export function incentivesDir(): string {
  return process.env.INCENTIVES_DIR ? resolve(process.env.INCENTIVES_DIR) : resolve(dirname(campaignDir()), 'incentives');
}

const fileFor = (tenantId: string, dir: string) => {
  if (!/^[A-Z0-9-]{2,40}$/i.test(tenantId)) throw new Error('Not a valid tenant id.');
  return join(dir, `${tenantId}.json`);
};

type MenuTenant = Pick<TenantConfig, 'tenantId' | 'incentives' | 'warehouse'>;

/** The example menu a bank starts with, marked as example data. */
const exampleMenu = (tenant: MenuTenant): Incentive[] => mockLibrary(MOCK_FEES[tenant.warehouse?.bank ?? ''] ?? { Standard: 499 }).map((i) => ({ ...i, mock: true }));

/** The incentive menu for a bank, paused and draft offers included. Empty when it has none. */
export function incentivesFor(tenant: MenuTenant | null | undefined, dir = incentivesDir()): Incentive[] {
  if (!tenant?.incentives) return [];
  const p = fileFor(tenant.tenantId, dir);
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as Incentive[];
    } catch {
      /* a broken file falls back to the example menu */
    }
  }
  return exampleMenu(tenant);
}

function writeMenu(tenantId: string, menu: Incentive[], dir: string): void {
  const p = fileFor(tenantId, dir);
  mkdirSync(dir, { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(menu, null, 1));
  renameSync(tmp, p);
}

const ID = /^[a-z][a-z0-9_]{1,40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ACTIONS = ['spend', 'first_spend', 'emi_conversion'] as const;
const COST_TYPES: CostType[] = ['flat', 'pctOfSpend', 'interest', 'cardFee'];
const num = (v: unknown) => (v === '' || v == null ? NaN : Number(v));
const pos = (v: unknown) => Number.isFinite(num(v)) && num(v) > 0;

/** The goals an offer serves follow from what the customer must do. */
const goalsFor = (action: Incentive['trigger']['action']) => (action === 'emi_conversion' ? ['EMI conversion', 'Transaction'] : ['Transaction']);

/**
 * Checks an offer as ops entered it and returns it cleaned (cost fields that
 * don't belong to its cost type dropped, conditions spelled canonically, the
 * most it can cost per customer worked out), or the problems, in plain words.
 */
export function checkIncentive(input: Partial<Incentive>, signals: Signal[]): { incentive?: Incentive; problems: string[] } {
  const problems: string[] = [];
  const str = (v: unknown) => String(v ?? '').trim();
  const id = str(input.id);
  if (!ID.test(id)) problems.push('The reference is lower-case letters, digits and underscores, starting with a letter (e.g. cashback_first_spend_100).');
  for (const [k, name] of [['label', 'a name'], ['mechanic', 'what the customer gets'], ['terms', 'the full terms'], ['offerLine', 'the line the customer reads']] as const) if (!str(input[k])) problems.push(`Give the offer ${name}.`);
  const offerLine = str(input.offerLine);
  if (offerLine.length > 160) problems.push(`The line the customer reads is ${offerLine.length} characters. Keep it to 160: it goes into SMS.`);
  if (/https?:\/\/|www\./i.test(offerLine)) problems.push('The line the customer reads cannot carry a link. Links are added from the Links list.');
  const size = input.size === 'big' ? 'big' : input.size === 'small' ? 'small' : null;
  if (!size) problems.push('Say whether the offer is small or big.');

  const t = (input.trigger ?? {}) as Partial<Incentive['trigger']>;
  const action = ACTIONS.find((a) => a === t.action);
  if (!action) problems.push('Say what the customer must do: spend, make a first spend, or convert to EMI.');
  if (!(Number.isInteger(num(t.withinDays)) && num(t.withinDays) >= 1 && num(t.withinDays) <= 365)) problems.push('The window to earn it is a whole number of days, 1 to 365.');
  if (t.minAmount != null && String(t.minAmount) !== '' && !(Number.isFinite(num(t.minAmount)) && num(t.minAmount) >= 0)) problems.push('The minimum amount must be a number of rupees.');
  const trigger: Incentive['trigger'] = {
    action: action ?? 'spend',
    ...(pos(t.minAmount) ? { minAmount: num(t.minAmount) } : {}),
    withinDays: num(t.withinDays),
    ...(str(t.category) ? { category: str(t.category) } : {}),
  };

  const costType = COST_TYPES.find((c) => c === input.costType);
  const c = (input.cost ?? {}) as Incentive['cost'];
  let cost: Incentive['cost'] = {};
  let maxCost = NaN;
  if (!costType) problems.push('Say how the offer costs the bank: a fixed amount, a share of spend, an interest discount, or a card fee.');
  else if (costType === 'flat') {
    if (!pos(c.perRedemption)) problems.push('A fixed-cost offer needs its cost per customer who earns it, in rupees.');
    cost = { perRedemption: num(c.perRedemption) };
    maxCost = num(c.perRedemption);
  } else if (costType === 'pctOfSpend') {
    if (action === 'emi_conversion') problems.push('A share-of-spend cost needs a spend trigger, not an EMI conversion.');
    if (!(pos(c.ratePct) && num(c.ratePct) <= 100)) problems.push('A share-of-spend offer needs its cost as a % of spend, above 0 and at most 100.');
    if (!pos(c.capPerCustomer)) problems.push('A share-of-spend offer needs a cap per customer, in rupees.');
    cost = { ratePct: num(c.ratePct), capPerCustomer: num(c.capPerCustomer) };
    maxCost = num(c.capPerCustomer);
  } else if (costType === 'interest') {
    if (action !== 'emi_conversion') problems.push('An interest discount only works with an EMI conversion trigger.');
    if (!(pos(c.interestDiscountPctPa) && num(c.interestDiscountPctPa) <= 50)) problems.push('An interest discount needs the points a year the bank gives up, above 0 and at most 50.');
    if (!pos(input.maxCostPerCustomer)) problems.push('An interest discount needs the most it can cost the bank per customer, in rupees.');
    cost = { interestDiscountPctPa: num(c.interestDiscountPctPa) };
    maxCost = num(input.maxCostPerCustomer);
  } else {
    const fees = Object.entries(c.feeByCardType ?? {}).map(([k, v]) => [k.trim(), num(v)] as const).filter(([k]) => k);
    if (!fees.length) problems.push('A card-fee offer needs the annual fee for each card type.');
    if (fees.some(([, v]) => !(Number.isFinite(v) && v >= 0))) problems.push('Each card fee must be a number of rupees.');
    cost = { feeByCardType: Object.fromEntries(fees) };
    maxCost = Math.max(0, ...fees.map(([, v]) => v));
  }

  const conds = (list: unknown, what: string): SignalCondition[] =>
    (Array.isArray(list) ? list : []).map((raw) => {
      const cond = canonicalCondition(signals, raw as SignalCondition);
      const p = signalConditionProblem(signals, cond, 'eligibility');
      if (p) problems.push(`${what}: ${p.replace(/ Use list_signals;.*$/, '')}`);
      return cond;
    });
  const requires = conds(input.requires, 'Product rule');
  const eligibility = conds(input.eligibility, 'Meant for');
  const unmatchedCriteria = (Array.isArray(input.unmatchedCriteria) ? input.unmatchedCriteria : []).map(str).filter(Boolean);

  const validFrom = str(input.validFrom);
  const validTo = str(input.validTo);
  if (!DATE.test(validFrom) || !DATE.test(validTo)) problems.push('Give the dates the offer is valid, from and to.');
  else if (validFrom > validTo) problems.push('The offer ends before it starts.');
  const status = input.status === 'paused' || input.status === 'draft' ? input.status : 'live';

  if (problems.length) return { problems };
  return {
    problems,
    incentive: {
      id,
      label: str(input.label),
      size: size!,
      mechanic: str(input.mechanic),
      trigger,
      fitsGoals: goalsFor(trigger.action),
      costType: costType!,
      cost,
      maxCostPerCustomer: maxCost,
      requires,
      eligibility,
      unmatchedCriteria,
      validFrom,
      validTo,
      terms: str(input.terms),
      offerLine,
      status,
    },
  };
}

/** Adds or changes an offer. Its reference, once created, never changes. Saving turns the example menu into the bank's own. */
export function saveIncentive(tenant: MenuTenant & Pick<TenantConfig, 'warehouse'>, input: Partial<Incentive>, by = 'ops', dir = incentivesDir()): { ok: boolean; error?: string; problems?: string[]; incentive?: Incentive } {
  if (!tenant.incentives) return { ok: false, error: 'This bank has no offer menu.' };
  const { incentive, problems } = checkIncentive(input, signalsFor(tenant));
  if (!incentive) return { ok: false, error: problems[0], problems };
  const menu = incentivesFor(tenant, dir);
  const prev = menu.find((i) => i.id === incentive.id);
  const saved: Incentive = { ...incentive, updatedAt: new Date().toISOString(), updatedBy: by };
  writeMenu(tenant.tenantId, prev ? menu.map((i) => (i.id === saved.id ? saved : i)) : [...menu, saved], dir);
  return { ok: true, incentive: saved };
}

/** Pauses, resumes or drafts an offer. */
export function setIncentiveStatus(tenant: MenuTenant, id: string, status: Incentive['status'], by = 'ops', dir = incentivesDir()): { ok: boolean; error?: string } {
  if (!['live', 'paused', 'draft'].includes(status)) return { ok: false, error: 'Unknown status.' };
  const menu = incentivesFor(tenant, dir);
  if (!menu.some((i) => i.id === id)) return { ok: false, error: `No offer "${id}".` };
  writeMenu(tenant.tenantId, menu.map((i) => (i.id === id ? { ...i, status, updatedAt: new Date().toISOString(), updatedBy: by } : i)), dir);
  return { ok: true };
}

/** Valid for the campaign's dates (spend is each campaign's own budget, not the offer's): live, and running at least over the whole window (or, with no dates, live today). */
export function validFor(i: Incentive, dates: { startDate?: string; endDate?: string } | null | undefined, today: string): boolean {
  if (i.status !== 'live') return false;
  const from = dates?.startDate ?? today;
  const to = dates?.endDate ?? from;
  return i.validFrom <= from && i.validTo >= to;
}

/** Problems with an incentive's own conditions against this bank's signals (e.g. a signal the bank doesn't have). */
export function incentiveProblems(i: Incentive, signals: Signal[]): string[] {
  return [...i.requires, ...i.eligibility].map((c) => signalConditionProblem(signals, c, 'eligibility')).filter((x): x is string => !!x);
}

/** How many of a group's customers meet the offer's requirements, and its targeting. Needs the warehouse. */
export function qualifyingShare(bank: string, signals: Signal[], groupSql: string, i: Incentive): { size: number; meetRequires: number; qualify: number; checkedBy: string[] } | { error: string } {
  if (!warehouseAvailable(bank)) return { error: 'No data access for this bank.' };
  const conds = (list: SignalCondition[]) => list.map((c) => conditionSql(signals, c)).filter((x): x is string => !!x);
  const req = conds(i.requires);
  const all = [...req, ...conds(i.eligibility)];
  const inner = groupSql.trim().replace(/;+\s*$/, '');
  const count = (filters: string[]) =>
    Number(runWarehouseQuery(bank, `SELECT COUNT(DISTINCT g.customer_id) AS n FROM (${inner}) g${filters.length ? ` WHERE ${filters.map((f) => `g.customer_id IN (${f})`).join(' AND ')}` : ''}`).rows[0]?.n ?? 0);
  try {
    return { size: count([]), meetRequires: count(req), qualify: count(all), checkedBy: [...i.requires, ...i.eligibility].map((c) => signalConditionText(signals, c)) };
  } catch (e) {
    return { error: `Could not count: ${(e as Error).message}` };
  }
}

/** The menu as the agent sees it. */
export function incentiveForAgent(i: Incentive, signals: Signal[]) {
  return {
    id: i.id,
    label: i.label,
    size: i.size,
    mechanic: i.mechanic,
    trigger: i.trigger,
    fitsGoals: i.fitsGoals,
    costToBank: i.cost,
    costType: i.costType,
    maxCostPerCustomer: i.maxCostPerCustomer,
    requires: i.requires.map((c) => signalConditionText(signals, c)),
    meantFor: i.eligibility.map((c) => signalConditionText(signals, c)),
    checkedByTheEngineOnly: i.unmatchedCriteria,
    validFrom: i.validFrom,
    validTo: i.validTo,
    terms: i.terms,
    offerLine: i.offerLine,
    offerLineLength: i.offerLine.length,
  };
}
