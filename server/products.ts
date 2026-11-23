// Products the bank wants to sell: the product list (Smart Engage 2.0), next
// to the offer menu. An offer is a reward on the current card (a cost); a
// product is a different thing to sell (a card upgrade, a loan on the card,
// insurance). The schema is the NBA agent's product offering
// (~/ai-projects-feb26/propensity-agent, NBAOffering), with two changes for
// this system: eligibility is also written as conditions on the bank's
// signals (so it can be counted and checked), and the product page is a
// reference into the bank's Links registry (so SMS gets its short link).
//
//   <CAMPAIGN_DIR>/../products/<tenantId>.json
//
// Until the bank saves a change, it gets the starting list below (card-focused).
// Products are paused, never deleted: campaigns refer to them by id.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { campaignDir } from './campaignFiles';
import type { TenantConfig } from './tenants';
import { canonicalCondition, conditionSql, signalConditionProblem, signalConditionText, signalsFor, type Signal, type SignalCondition } from './signals';
import { runWarehouseQuery, warehouseAvailable } from './warehouse';
import { listLinks } from './links';

export type ProductType = 'card' | 'loan' | 'fd' | 'insurance' | 'other';

export interface Product {
  product_id: string;
  product_name: string;
  product_type: ProductType;
  description: string;
  /** Who it is for, in words (as the bank wrote it). */
  target_audience_description: string;
  /** Eligibility in plain words: who it includes and who it leaves out. */
  eligibility_rules: { include: string[]; exclude: string[] };
  /** The same eligibility as conditions on the bank's signals, where they can say it (all must hold). */
  eligibility: SignalCondition[];
  /** The product page: a reference into the bank's Links. */
  link: string;
  status: 'live' | 'paused';
  /** Starting data, not the bank's real product. */
  mock?: boolean;
  updatedAt?: string;
  updatedBy?: string;
}

export const PRODUCT_TYPES: ProductType[] = ['card', 'loan', 'fd', 'insurance', 'other'];

export function productsDir(): string {
  return process.env.PRODUCTS_DIR ? resolve(process.env.PRODUCTS_DIR) : resolve(dirname(campaignDir()), 'products');
}

const fileFor = (tenantId: string, dir: string) => {
  if (!/^[A-Z0-9-]{2,40}$/i.test(tenantId)) throw new Error('Not a valid tenant id.');
  return join(dir, `${tenantId}.json`);
};

/** The starting list: card-focused, with product pages seeded in Links (server/links.ts). */
function startingList(): Product[] {
  const p = (x: Omit<Product, 'status' | 'mock'>): Product => ({ ...x, status: 'live', mock: true });
  return [
    p({
      product_id: 'premium_upgrade',
      product_name: 'Premium card upgrade',
      product_type: 'card',
      description: 'An upgrade to the bank’s premium card: higher rewards, lounge access and a higher limit.',
      target_audience_description: 'Customers who already spend a lot on their card and use it often.',
      eligibility_rules: { include: ['Spent ₹1 lakh or more on the card in the last 90 days'], exclude: ['Already on the premium card', 'Flagged NPA or fraud'] },
      eligibility: [{ attribute: 'spend_90d', operator: 'Greater than', value: '100000' }],
      link: 'apply_upgrade',
    }),
    p({
      product_id: 'addon_card',
      product_name: 'Add-on card for family',
      product_type: 'card',
      description: 'A free add-on card for a family member, sharing the main card’s limit and earning rewards on one account.',
      target_audience_description: 'Active cardholders who could bring family spending onto the card.',
      eligibility_rules: { include: ['Used the card in the last 60 days'], exclude: ['Flagged NPA or fraud'] },
      eligibility: [{ attribute: 'days_since_last_txn', operator: 'Less than', value: '60' }],
      link: 'apply_addon',
    }),
    p({
      product_id: 'loan_on_card',
      product_name: 'Loan on your card',
      product_type: 'loan',
      description: 'A pre-approved loan within the card limit, paid into the bank account and repaid in EMIs.',
      target_audience_description: 'Customers eligible for EMI with room on their limit.',
      eligibility_rules: { include: ['Eligible for EMI conversion', 'Using under 50% of the limit'], exclude: ['Flagged NPA or fraud'] },
      eligibility: [
        { attribute: 'emi_eligible', operator: 'Is', value: 'true' },
        { attribute: 'utilisation_pct', operator: 'Less than', value: '50' },
      ],
      link: 'apply_loan_on_card',
    }),
    p({
      product_id: 'balance_transfer',
      product_name: 'Balance transfer',
      product_type: 'loan',
      description: 'Move another card’s outstanding balance to this card at a lower rate, repaid in EMIs.',
      target_audience_description: 'Customers with room on their limit who may carry balances elsewhere.',
      eligibility_rules: { include: ['Using under 40% of the limit'], exclude: ['Flagged NPA or fraud'] },
      eligibility: [{ attribute: 'utilisation_pct', operator: 'Less than', value: '40' }],
      link: 'apply_balance_transfer',
    }),
    p({
      product_id: 'card_protection',
      product_name: 'Card protection plan',
      product_type: 'insurance',
      description: 'Cover against fraud, lost or stolen cards, with one call to block every card.',
      target_audience_description: 'Any active cardholder.',
      eligibility_rules: { include: ['Has used the card'], exclude: [] },
      eligibility: [{ attribute: 'ever_transacted', operator: 'Is', value: 'true' }],
      link: 'buy_card_protection',
    }),
    p({
      product_id: 'travel_card',
      product_name: 'Travel credit card',
      product_type: 'card',
      description: 'A travel card with air miles, lounge access and low forex markup.',
      target_audience_description: 'Customers whose top spend is travel.',
      eligibility_rules: { include: ['Top spend category in the last 90 days is travel'], exclude: ['Flagged NPA or fraud'] },
      eligibility: [{ attribute: 'top_category', operator: 'Equals', value: 'travel' }],
      link: 'apply_travel_card',
    }),
  ];
}

type BankTenant = Pick<TenantConfig, 'tenantId' | 'warehouse'>;

/** The bank's products, paused ones included. */
export function productsFor(tenant: BankTenant | null | undefined, dir = productsDir()): Product[] {
  if (!tenant?.tenantId) return startingList();
  const p = fileFor(tenant.tenantId, dir);
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as Product[];
    } catch {
      /* a broken file falls back to the starting list */
    }
  }
  return startingList();
}

function write(tenantId: string, list: Product[], dir: string): void {
  const p = fileFor(tenantId, dir);
  mkdirSync(dir, { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(list, null, 1));
  renameSync(tmp, p);
}

const ID = /^[a-z][a-z0-9_]{1,40}$/;

/** Checks a product as ops entered it; returns it cleaned, or the problems in plain words. */
export function checkProduct(input: Partial<Product>, signals: Signal[], linkRefs: string[]): { product?: Product; problems: string[] } {
  const problems: string[] = [];
  const str = (v: unknown) => String(v ?? '').trim();
  const id = str(input.product_id);
  if (!ID.test(id)) problems.push('The reference is lower-case letters, digits and underscores, starting with a letter (e.g. travel_card).');
  if (!str(input.product_name)) problems.push('Give the product a name.');
  if (!str(input.description)) problems.push('Say what the product is.');
  const type = PRODUCT_TYPES.find((t) => t === input.product_type);
  if (!type) problems.push('Choose the product type: card, loan, FD, insurance or other.');
  const link = str(input.link);
  if (!link) problems.push('Choose the product page from Links.');
  else if (!linkRefs.includes(link)) problems.push(`There is no link "${link}". Add it in Links first.`);
  const words = (v: unknown) => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
  const eligibility = (Array.isArray(input.eligibility) ? input.eligibility : []).map((raw) => {
    const c = canonicalCondition(signals, raw as SignalCondition);
    const p = signalConditionProblem(signals, c, 'eligibility');
    if (p) problems.push(`Eligibility: ${p.replace(/ Use list_signals;.*$/, '')}`);
    return c;
  });
  if (problems.length) return { problems };
  return {
    problems,
    product: {
      product_id: id,
      product_name: str(input.product_name),
      product_type: type!,
      description: str(input.description),
      target_audience_description: str(input.target_audience_description),
      eligibility_rules: { include: words(input.eligibility_rules?.include), exclude: words(input.eligibility_rules?.exclude) },
      eligibility,
      link,
      status: input.status === 'paused' ? 'paused' : 'live',
    },
  };
}

/** Adds or changes a product. Its reference never changes once created. */
export function saveProduct(tenant: BankTenant, input: Partial<Product>, by = 'ops', dir = productsDir()): { ok: boolean; error?: string; problems?: string[]; product?: Product } {
  const { product, problems } = checkProduct(input, signalsFor(tenant), listLinks(tenant.tenantId).filter((l) => l.status === 'active').map((l) => l.ref));
  if (!product) return { ok: false, error: problems[0], problems };
  const list = productsFor(tenant, dir);
  const saved: Product = { ...product, updatedAt: new Date().toISOString(), updatedBy: by };
  write(tenant.tenantId, list.some((x) => x.product_id === saved.product_id) ? list.map((x) => (x.product_id === saved.product_id ? saved : x)) : [...list, saved], dir);
  return { ok: true, product: saved };
}

export function setProductStatus(tenant: BankTenant, id: string, status: Product['status'], by = 'ops', dir = productsDir()): { ok: boolean; error?: string } {
  if (status !== 'live' && status !== 'paused') return { ok: false, error: 'Unknown status.' };
  const list = productsFor(tenant, dir);
  if (!list.some((x) => x.product_id === id)) return { ok: false, error: `No product "${id}".` };
  write(tenant.tenantId, list.map((x) => (x.product_id === id ? { ...x, status, updatedAt: new Date().toISOString(), updatedBy: by } : x)), dir);
  return { ok: true };
}

/** The product as the designer sees it. */
export const productForAgent = (p: Product, signals: Signal[]) => ({
  id: p.product_id,
  name: p.product_name,
  type: p.product_type,
  description: p.description,
  targetAudience: p.target_audience_description,
  include: p.eligibility_rules.include,
  exclude: p.eligibility_rules.exclude,
  eligibility: p.eligibility.map((c) => signalConditionText(signals, c)),
  link: p.link,
});

/** How many of a group's customers are eligible for a product (its signal conditions). Needs the warehouse. */
export function eligibleShare(bank: string, signals: Signal[], groupSql: string, p: Product): { size: number; eligible: number } | { error: string } {
  if (!warehouseAvailable(bank)) return { error: 'No data access for this bank.' };
  const conds = p.eligibility.map((c) => conditionSql(signals, c)).filter((x): x is string => !!x);
  const inner = groupSql.trim().replace(/;+\s*$/, '');
  const count = (filters: string[]) =>
    Number(runWarehouseQuery(bank, `SELECT COUNT(DISTINCT g.customer_id) AS n FROM (${inner}) g${filters.length ? ` WHERE ${filters.map((f) => `g.customer_id IN (${f})`).join(' AND ')}` : ''}`).rows[0]?.n ?? 0);
  try {
    return { size: count([]), eligible: count(conds) };
  } catch (e) {
    return { error: `Could not count: ${(e as Error).message}` };
  }
}
