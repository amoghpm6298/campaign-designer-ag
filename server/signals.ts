// The signals menu: named, defined facts about a customer that the agent may
// use by name — in bucket rules now; in switches, personal words in copy and
// incentive eligibility in later phases. The agent never writes what a signal
// means: each definition (and, for banks with data, the SQL behind it) is owned
// here. Like the link registry, code checks every reference.
//
// Data signals are worked out from the bank's warehouse. The engine cannot
// supply them yet, so they are "proposed": the canvas says so.
import type { TenantConfig } from './tenants';
import { runWarehouseQuery, warehouseAvailable } from './warehouse';

export type SignalType = 'number' | 'money' | 'days' | 'category' | 'bool';
export type SignalUse = 'rule' | 'switch' | 'copy' | 'eligibility';

export interface Signal {
  key: string;
  label: string;
  type: SignalType;
  /** profile: who they are · behaviour: what they did · journey: what they did in this campaign. */
  kind: 'profile' | 'behaviour' | 'journey';
  /** What it means, in plain words. */
  definition: string;
  /** SQL over the warehouse returning (customer_id, value). Data signals only; never shown to the agent. */
  sql?: string;
  /** Category signals: the values it takes (filled from the data). */
  values?: string[];
  usableIn: SignalUse[];
  /** live: the engine can evaluate it today · proposed: designed, not yet supplied by the engine. */
  status: 'live' | 'proposed';
  /** restricted: may route people, never appears in message copy. */
  sensitivity: 'normal' | 'restricted';
}

/** "Today" for a warehouse is the last date in its data. */
const ASOF = `(SELECT MAX(transaction_date) FROM transactions)`;

/** Data signals for a bank with the standard mock warehouse (customers, transactions, emi_eligibility). */
const DATA_SIGNALS: Signal[] = [
  {
    key: 'tenure_months',
    label: 'Months since account opened',
    type: 'number',
    kind: 'profile',
    definition: 'Whole months between the account opening date and today.',
    sql: `SELECT customer_id, CAST((julianday(${ASOF}) - julianday(account_open_date)) / 30.44 AS INTEGER) AS value FROM customers`,
    usableIn: ['rule', 'switch', 'copy', 'eligibility'],
    status: 'proposed',
    sensitivity: 'normal',
  },
  {
    key: 'card_type',
    label: 'Card variant',
    type: 'category',
    kind: 'profile',
    definition: 'The card product the customer holds.',
    sql: `SELECT customer_id, card_type AS value FROM customers`,
    usableIn: ['rule', 'switch', 'copy', 'eligibility'],
    status: 'proposed',
    sensitivity: 'normal',
  },
  {
    key: 'credit_limit',
    label: 'Credit limit',
    type: 'money',
    kind: 'profile',
    definition: 'The card credit limit in rupees.',
    sql: `SELECT customer_id, credit_limit AS value FROM customers`,
    usableIn: ['rule', 'switch', 'eligibility'],
    status: 'proposed',
    sensitivity: 'restricted',
  },
  {
    key: 'utilisation_pct',
    label: 'Share of limit in use',
    type: 'number',
    kind: 'profile',
    definition: 'Current balance as a percentage of the credit limit.',
    sql: `SELECT customer_id, ROUND(100.0 * current_balance / NULLIF(credit_limit, 0), 1) AS value FROM customers`,
    usableIn: ['rule', 'switch', 'eligibility'],
    status: 'proposed',
    sensitivity: 'restricted',
  },
  {
    key: 'preferred_language',
    label: 'Preferred language',
    type: 'category',
    kind: 'profile',
    definition: 'The language the customer chose for communication.',
    sql: `SELECT customer_id, preferred_language AS value FROM customers`,
    usableIn: ['rule', 'switch', 'eligibility'],
    status: 'proposed',
    sensitivity: 'normal',
  },
  {
    key: 'ever_transacted',
    label: 'Has ever used the card',
    type: 'bool',
    kind: 'behaviour',
    definition: 'Whether the customer has made at least one card transaction.',
    sql: `SELECT c.customer_id, CASE WHEN EXISTS (SELECT 1 FROM transactions t WHERE t.customer_id = c.customer_id) THEN 'true' ELSE 'false' END AS value FROM customers c`,
    usableIn: ['rule', 'switch', 'eligibility'],
    status: 'proposed',
    sensitivity: 'normal',
  },
  {
    key: 'days_since_last_txn',
    label: 'Days since last card use',
    type: 'days',
    kind: 'behaviour',
    definition: 'Days between the last card transaction and today. Empty for customers who never used the card.',
    sql: `SELECT customer_id, CAST(julianday(${ASOF}) - julianday(MAX(transaction_date)) AS INTEGER) AS value FROM transactions GROUP BY customer_id`,
    usableIn: ['rule', 'switch', 'eligibility'],
    status: 'proposed',
    sensitivity: 'normal',
  },
  {
    key: 'spend_90d',
    label: 'Card spend, last 90 days',
    type: 'money',
    kind: 'behaviour',
    definition: 'Total card spend in rupees over the last 90 days (0 if none).',
    sql: `SELECT c.customer_id, COALESCE((SELECT ROUND(SUM(t.amount)) FROM transactions t WHERE t.customer_id = c.customer_id AND t.transaction_date >= date(${ASOF}, '-90 day')), 0) AS value FROM customers c`,
    usableIn: ['rule', 'switch', 'copy', 'eligibility'],
    status: 'proposed',
    sensitivity: 'normal',
  },
  {
    key: 'txn_count_30d',
    label: 'Card transactions, last 30 days',
    type: 'number',
    kind: 'behaviour',
    definition: 'Number of card transactions in the last 30 days (0 if none).',
    sql: `SELECT c.customer_id, (SELECT COUNT(*) FROM transactions t WHERE t.customer_id = c.customer_id AND t.transaction_date >= date(${ASOF}, '-30 day')) AS value FROM customers c`,
    usableIn: ['rule', 'switch', 'copy', 'eligibility'],
    status: 'proposed',
    sensitivity: 'normal',
  },
  {
    key: 'top_category',
    label: 'Top spend category, last 90 days',
    type: 'category',
    kind: 'behaviour',
    definition: 'The category with the most card transactions in the last 90 days. Empty if no transactions.',
    sql: `SELECT customer_id, category AS value FROM (SELECT customer_id, category, ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY COUNT(*) DESC, category) AS rk FROM transactions WHERE transaction_date >= date(${ASOF}, '-90 day') GROUP BY customer_id, category) WHERE rk = 1`,
    usableIn: ['rule', 'switch', 'copy', 'eligibility'],
    status: 'proposed',
    sensitivity: 'normal',
  },
  {
    key: 'has_emi',
    label: 'Has an active EMI',
    type: 'bool',
    kind: 'behaviour',
    definition: 'Whether the customer has at least one existing EMI.',
    sql: `SELECT c.customer_id, CASE WHEN COALESCE(e.existing_emi_count, 0) > 0 THEN 'true' ELSE 'false' END AS value FROM customers c LEFT JOIN emi_eligibility e ON e.customer_id = c.customer_id`,
    usableIn: ['rule', 'switch', 'eligibility'],
    status: 'proposed',
    sensitivity: 'normal',
  },
  {
    key: 'emi_eligible',
    label: 'Eligible for EMI conversion',
    type: 'bool',
    kind: 'profile',
    definition: "Whether the bank's credit policy lets the customer convert purchases to EMI. Set by the bank; a campaign cannot change it.",
    sql: `SELECT c.customer_id, CASE WHEN COALESCE(e.eligible_for_emi, 0) = 1 THEN 'true' ELSE 'false' END AS value FROM customers c LEFT JOIN emi_eligibility e ON e.customer_id = c.customer_id`,
    usableIn: ['rule', 'switch', 'eligibility'],
    status: 'proposed',
    sensitivity: 'normal',
  },
  {
    key: 'max_emi_amount',
    label: 'Largest EMI amount allowed',
    type: 'money',
    kind: 'profile',
    definition: "The largest purchase the bank's credit policy lets the customer convert to EMI (0 if not eligible).",
    sql: `SELECT c.customer_id, COALESCE(e.max_emi_amount, 0) AS value FROM customers c LEFT JOIN emi_eligibility e ON e.customer_id = c.customer_id`,
    usableIn: ['rule', 'switch', 'eligibility'],
    status: 'proposed',
    sensitivity: 'restricted',
  },
  {
    key: 'last_login_days',
    label: 'Days since last app login',
    type: 'days',
    kind: 'behaviour',
    definition: 'Days between the last app login and today.',
    sql: `SELECT customer_id, CAST(julianday(${ASOF}) - julianday(last_login_date) AS INTEGER) AS value FROM customers`,
    usableIn: ['rule', 'switch', 'eligibility'],
    status: 'proposed',
    sensitivity: 'normal',
  },
];

/** What the customer did in this campaign. Every bank has these. */
const JOURNEY_SIGNALS: Signal[] = [
  {
    key: 'read_last_message',
    label: 'Read the last message',
    type: 'bool',
    kind: 'journey',
    definition: 'Whether the channel reported the previous message as read. Today this is the delivery-status branch.',
    values: ['true', 'false'],
    usableIn: ['switch'],
    status: 'live',
    sensitivity: 'normal',
  },
  {
    key: 'clicked_last_message',
    label: 'Clicked the last message',
    type: 'bool',
    kind: 'journey',
    definition: "Whether the customer tapped the previous message's link.",
    values: ['true', 'false'],
    usableIn: ['switch'],
    status: 'proposed',
    sensitivity: 'normal',
  },
  {
    key: 'spent_since_entry',
    label: 'Spent since joining the campaign',
    type: 'money',
    kind: 'journey',
    definition: 'Card spend in rupees since the customer entered this campaign.',
    usableIn: ['switch'],
    status: 'proposed',
    sensitivity: 'normal',
  },
];

const valuesCache = new Map<string, string[]>();

/** Category values from the data, so the menu shows what each signal can actually be. */
function categoryValues(bank: string, s: Signal): string[] | undefined {
  if (s.type === 'bool') return ['true', 'false'];
  if (s.type !== 'category' || !s.sql) return s.values;
  const k = `${bank}:${s.key}`;
  if (!valuesCache.has(k)) {
    try {
      const r = runWarehouseQuery(bank, `SELECT DISTINCT value FROM (${s.sql}) WHERE value IS NOT NULL ORDER BY value`);
      valuesCache.set(k, r.rows.map((x) => String(x.value)));
    } catch {
      valuesCache.set(k, []);
    }
  }
  return valuesCache.get(k);
}

/** The signals a bank offers: data signals only where it has a warehouse; journey signals always. */
export function signalsFor(tenant: Pick<TenantConfig, 'warehouse'> | null | undefined): Signal[] {
  const bank = tenant?.warehouse?.bank;
  const data = bank && warehouseAvailable(bank) ? DATA_SIGNALS.map((s) => ({ ...s, values: categoryValues(bank, s) })) : [];
  return [...data, ...JOURNEY_SIGNALS];
}

/** The menu as the agent sees it: no SQL; the operators each signal takes, spelled exactly. */
export function signalsForAgent(signals: Signal[]) {
  return signals.map(({ sql: _sql, ...s }) => (void _sql, { ...s, operators: operatorsFor(s.type) }));
}

const OPERATOR_ALIASES: Record<string, string> = {
  '=': 'Equals', '==': 'Equals', eq: 'Equals', equals: 'Equals', is: 'Equals',
  '!=': 'Not Equals', '<>': 'Not Equals', ne: 'Not Equals', 'not equals': 'Not Equals', 'is not': 'Not Equals',
  '>': 'Greater than', gt: 'Greater than', 'greater than': 'Greater than', more: 'Greater than',
  '<': 'Less than', lt: 'Less than', 'less than': 'Less than',
  in: 'Any of', 'one of': 'Any of', one_of: 'Any of', 'any of': 'Any of', anyof: 'Any of',
  between: 'Between',
};

/**
 * The canonical spelling of a condition: common operator spellings ("=", "in", "eq") become the
 * builder's, and a list of values becomes "a,b". Deterministic, so what is checked is what is stored.
 */
export function canonicalCondition(signals: Signal[], c: { attribute?: unknown; operator?: unknown; value?: unknown }): SignalCondition {
  const s = signals.find((x) => x.key === String(c.attribute ?? '').trim());
  const raw = String(c.operator ?? '').trim();
  let op = operatorsFor(s?.type ?? 'category').find((o) => o.toLowerCase() === raw.toLowerCase()) ?? OPERATOR_ALIASES[raw.toLowerCase()] ?? raw;
  let value = Array.isArray(c.value) ? (c.value as unknown[]).map(String).join(',') : String(c.value ?? '');
  if (s?.type === 'bool' && op === 'Equals') op = 'Is';
  if (s?.type === 'category' && op === 'Any of' && !value.includes(',')) op = 'Equals';
  if (s?.type === 'category' && op === 'Equals' && value.includes(',')) op = 'Any of';
  value = value.trim();
  return { attribute: String(c.attribute ?? '').trim(), operator: op, value };
}

/** The operators a signal of this type accepts (builder spelling). */
export function operatorsFor(type: SignalType): string[] {
  if (type === 'bool') return ['Is'];
  if (type === 'category') return ['Equals', 'Not Equals', 'Any of'];
  return ['Equals', 'Not Equals', 'Greater than', 'Less than', 'Between'];
}

export interface SignalCondition {
  attribute?: string;
  operator?: string;
  value?: string;
}

/** Why a condition on a signal can't be used here, or null when it's fine. */
export function signalConditionProblem(signals: Signal[], c: SignalCondition, use: SignalUse): string | null {
  const s = signals.find((x) => x.key === String(c.attribute ?? '').trim());
  if (!s) return `"${c.attribute}" is not a signal for this bank. ${signals.length ? `Use list_signals; known: ${signals.map((x) => x.key).join(', ')}.` : 'This bank has no signals.'}`;
  if (!s.usableIn.includes(use)) return `Signal "${s.key}" can't be used in a ${use === 'rule' ? 'bucket rule' : use}.`;
  const ops = operatorsFor(s.type);
  if (!ops.includes(String(c.operator))) return `Signal "${s.key}" takes ${ops.join(', ')}, not "${c.operator}".`;
  const v = String(c.value ?? '').trim();
  if (!v) return `Signal "${s.key}" needs a value.`;
  if (s.type === 'bool' && !['true', 'false'].includes(v.toLowerCase())) return `Signal "${s.key}" is true or false.`;
  if (['number', 'money', 'days'].includes(s.type)) {
    const parts = c.operator === 'Between' ? v.split(',') : [v];
    if ((c.operator === 'Between' && parts.length !== 2) || parts.some((p) => !Number.isFinite(Number(p.trim())))) return `Signal "${s.key}" needs a number${c.operator === 'Between' ? ' range "min,max"' : ''}.`;
  }
  if (s.type === 'category' && s.values?.length) {
    const asked = c.operator === 'Any of' ? v.split(',').map((x) => x.trim()) : [v];
    const unknown = asked.filter((a) => !s.values!.includes(a));
    if (unknown.length) return `Signal "${s.key}" has no value ${unknown.map((u) => `"${u}"`).join(', ')}. Values: ${s.values.join(', ')}.`;
  }
  return null;
}

const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

/** SQL selecting the customer_ids that meet one condition on a signal (data signals only). */
export function conditionSql(signals: Signal[], c: SignalCondition): string | null {
  const s = signals.find((x) => x.key === c.attribute);
  if (!s?.sql) return null;
  const v = String(c.value ?? '').trim();
  const num = ['number', 'money', 'days'].includes(s.type);
  const lit = (x: string) => (num ? String(Number(x)) : q(x));
  let where: string;
  switch (c.operator) {
    case 'Equals':
    case 'Is':
      where = `value = ${lit(s.type === 'bool' ? v.toLowerCase() : v)}`;
      break;
    case 'Not Equals':
      where = `value <> ${lit(v)}`;
      break;
    case 'Greater than':
      where = `value > ${lit(v)}`;
      break;
    case 'Less than':
      where = `value < ${lit(v)}`;
      break;
    case 'Between': {
      const [a, b] = v.split(',').map((x) => x.trim());
      where = `value BETWEEN ${lit(a)} AND ${lit(b)}`;
      break;
    }
    case 'Any of':
      where = `value IN (${v.split(',').map((x) => lit(x.trim())).join(', ')})`;
      break;
    default:
      return null;
  }
  return `SELECT customer_id FROM (${s.sql}) WHERE ${where}`;
}

/** Plain words for a condition on a signal, e.g. "Card spend, last 90 days greater than ₹20,000". */
export function signalConditionText(signals: Signal[], c: SignalCondition): string {
  const s = signals.find((x) => x.key === c.attribute);
  const label = s?.label ?? String(c.attribute);
  const v = String(c.value ?? '');
  const fmt = (x: string) => (s?.type === 'money' ? `₹${Number(x).toLocaleString('en-IN')}` : s?.type === 'days' ? `${x} days` : x);
  const op: Record<string, string> = { Equals: 'is', Is: 'is', 'Not Equals': 'is not', 'Greater than': 'more than', 'Less than': 'less than', 'Any of': 'is any of', Between: 'between' };
  const val = c.operator === 'Between' ? v.split(',').map((x) => fmt(x.trim())).join(' and ') : s?.type === 'bool' ? '' : fmt(v);
  if (s?.type === 'bool') return v.toLowerCase() === 'true' ? label : `Not: ${label.toLowerCase()}`;
  return `${label} ${op[String(c.operator)] ?? c.operator} ${val}`.trim();
}
