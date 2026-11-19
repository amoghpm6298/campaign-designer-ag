// The incentive menu: special offers a campaign may use, on top of what the
// customer is already eligible for, each with its cost to the bank. The agent
// picks by id and never invents one. Features the customer already has (EMI
// conversion at the standard rate, the virtual card, points already earned)
// are not incentives: they are things to talk about in messages.
//
// MOCK until the real incentive library exists: standard credit card offers
// with dummy figures. Only incentivesFor() changes when the real library
// arrives.
import type { TenantConfig } from './tenants';
import { conditionSql, signalConditionProblem, signalConditionText, type Signal, type SignalCondition } from './signals';
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
  budget: { total: number; remaining: number };
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
  status: 'live' | 'draft';
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
      budget: { total: 500000, remaining: 500000 },
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
      budget: { total: 1000000, remaining: 1000000 },
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
      budget: { total: 300000, remaining: 300000 },
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
      budget: { total: 1000000, remaining: 1000000 },
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
      budget: { total: 1500000, remaining: 1500000 },
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
      budget: { total: 1000000, remaining: 1000000 },
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
      budget: { total: 2000000, remaining: 2000000 },
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

/** The incentive menu for a bank. Empty when it has none. */
export function incentivesFor(tenant: Pick<TenantConfig, 'incentives' | 'warehouse'> | null | undefined): Incentive[] {
  if (!tenant?.incentives) return [];
  return mockLibrary(MOCK_FEES[tenant.warehouse?.bank ?? ''] ?? { Standard: 499 });
}

/** Valid for the campaign's dates: live, and running at least over the whole window (or, with no dates, live today). */
export function validFor(i: Incentive, dates: { startDate?: string; endDate?: string } | null | undefined, today: string): boolean {
  if (i.status !== 'live' || i.budget.remaining <= 0) return false;
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
    budgetRemaining: i.budget.remaining,
    validFrom: i.validFrom,
    validTo: i.validTo,
    terms: i.terms,
    offerLine: i.offerLine,
    offerLineLength: i.offerLine.length,
  };
}
