// Offers in plain words. Ops describe an offer as they would to a colleague;
// the model turns it into the offer's fields, and code checks the draft with
// the same checks a save uses (checkIncentive). While anything required is
// missing or doesn't add up, the reply is a question about what's left, and
// ops answer in the same box. The model never invents a business fact
// (dates, cost, amounts): what wasn't said stays empty and is asked
// for. Nothing is saved here: the finished draft opens in the form for review.
import { callClaude, type LlmCallResult } from './anthropic';
import { checkIncentive, incentivesFor, type Incentive } from './incentives';
import { operatorsFor, signalsFor } from './signals';
import { todayIST } from './agent/schedule';
import type { TenantConfig } from './tenants';

export interface DraftTurn {
  role: 'ops' | 'designer';
  text: string;
}

const COND = {
  type: 'object',
  properties: { attribute: { type: 'string' }, operator: { type: 'string' }, value: { type: 'string' } },
  required: ['attribute', 'operator', 'value'],
  additionalProperties: false,
};
// No nullable fields: the API caps union types at 16. "Not said yet" is "" for text and 0 for numbers
// (never a real value for any of these), and toIncentive reads both as empty.
const NUM = { type: 'number' };
const STR = { type: 'string' };
const oneOf = (values: string[]) => ({ type: 'string', enum: [...values, ''] });

/** Every field is present; "" or 0 means "not said yet". */
export const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    label: STR,
    mechanic: STR,
    offerLine: STR,
    terms: STR,
    size: oneOf(['small', 'big']),
    action: oneOf(['spend', 'first_spend', 'emi_conversion']),
    withinDays: NUM,
    minAmount: NUM,
    category: STR,
    costType: oneOf(['flat', 'pctOfSpend', 'interest', 'cardFee']),
    perRedemption: NUM,
    ratePct: NUM,
    capPerCustomer: NUM,
    interestDiscountPctPa: NUM,
    maxCostPerCustomer: NUM,
    feeByCardType: { type: 'array', items: { type: 'object', properties: { cardType: { type: 'string' }, fee: { type: 'number' } }, required: ['cardType', 'fee'], additionalProperties: false } },
    requires: { type: 'array', items: COND },
    eligibility: { type: 'array', items: COND },
    unmatchedCriteria: { type: 'array', items: { type: 'string' } },
    validFrom: STR,
    validTo: STR,
    question: STR,
  },
  required: [
    'label', 'mechanic', 'offerLine', 'terms', 'size', 'action', 'withinDays', 'minAmount', 'category', 'costType', 'perRedemption', 'ratePct', 'capPerCustomer',
    'interestDiscountPctPa', 'maxCostPerCustomer', 'feeByCardType', 'requires', 'eligibility', 'unmatchedCriteria', 'validFrom', 'validTo', 'question',
  ],
  additionalProperties: false,
} as const;

type Raw = Record<string, unknown> & { feeByCardType?: { cardType: string; fee: number }[] };

/** The model's flat reply as an offer (a reference made from the name, unless one exists). */
export function toIncentive(r: Raw, id?: string): Partial<Incentive> {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v !== 0 ? v : undefined);
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const label = s(r.label) ?? '';
  const ref =
    id ||
    label
      .toLowerCase()
      .replace(/₹/g, 'rs')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .replace(/^(\d)/, 'offer_$1')
      .slice(0, 40);
  const costType = s(r.costType) as Incentive['costType'] | undefined;
  return {
    id: ref,
    label,
    mechanic: s(r.mechanic) ?? '',
    offerLine: s(r.offerLine) ?? '',
    terms: s(r.terms) ?? '',
    size: s(r.size) as Incentive['size'],
    trigger: { action: s(r.action) as Incentive['trigger']['action'], withinDays: n(r.withinDays) as number, ...(n(r.minAmount) ? { minAmount: n(r.minAmount) } : {}), ...(s(r.category) ? { category: s(r.category) } : {}) },
    costType,
    cost: {
      ...(n(r.perRedemption) != null ? { perRedemption: n(r.perRedemption) } : {}),
      ...(n(r.ratePct) != null ? { ratePct: n(r.ratePct) } : {}),
      ...(n(r.capPerCustomer) != null ? { capPerCustomer: n(r.capPerCustomer) } : {}),
      ...(n(r.interestDiscountPctPa) != null ? { interestDiscountPctPa: n(r.interestDiscountPctPa) } : {}),
      ...(r.feeByCardType?.length ? { feeByCardType: Object.fromEntries(r.feeByCardType.map((f) => [f.cardType, f.fee])) } : {}),
    },
    maxCostPerCustomer: n(r.maxCostPerCustomer) as number,
    requires: (r.requires as Incentive['requires']) ?? [],
    eligibility: (r.eligibility as Incentive['eligibility']) ?? [],
    unmatchedCriteria: (r.unmatchedCriteria as string[]) ?? [],
    validFrom: s(r.validFrom) ?? '',
    validTo: s(r.validTo) ?? '',
    status: 'draft',
  };
}

function systemFor(tenant: TenantConfig): string {
  const signals = signalsFor(tenant).filter((s) => s.usableIn.includes('eligibility'));
  const cards = Object.keys(incentivesFor(tenant).find((i) => i.costType === 'cardFee')?.cost.feeByCardType ?? {});
  return `You turn a bank ops person's description of a credit card offer into its fields, for ${tenant.displayName}. Today is ${todayIST()} (dates are YYYY-MM-DD).

Fields:
- label: a short name, e.g. "₹100 cashback on first spend".
- mechanic: what the customer gets, one sentence.
- action: what the customer must do: "spend", "first_spend" (first spend after a gap or ever), or "emi_conversion". withinDays: the window to do it. minAmount: the minimum in rupees, if any. category: a spend category, if the offer is limited to one.
- costType and its fields, what the offer costs the bank:
  - "flat": a fixed amount per customer who earns it (perRedemption, rupees). Cashback, vouchers, fee waivers of a known amount.
  - "pctOfSpend": a share of spend (ratePct, % of spend) with a cap per customer (capPerCustomer, rupees). Reward points multipliers: the extra points' value as a % of spend.
  - "interest": EMI interest the bank gives up (interestDiscountPctPa, points a year) and the most it can cost per customer (maxCostPerCustomer, rupees). Only with action "emi_conversion".
  - "cardFee": an annual fee waived; feeByCardType lists the fee per card type${cards.length ? ` (this bank's card types: ${cards.join(', ')})` : ''}.
- size: "small" or "big". Small for low-cost nudges (roughly up to ₹200 a customer), big above that.
- requires: product rules the customer must already meet (set by the bank's policy, e.g. EMI eligible). eligibility: who the offer is meant for. Both as {attribute, operator, value} using ONLY these signals, spelled exactly:
${signals.map((s) => `  - ${s.key} (${s.label}; ${s.type}; operators: ${operatorsFor(s.type).join(', ')}${s.values?.length ? `; values: ${s.values.join(', ')}` : ''})`).join('\n') || '  (none)'}
  A rule no signal can express goes in unmatchedCriteria, in plain words.
- validFrom, validTo: the dates it runs.
- offerLine: the line the customer reads, at most 160 characters, no links, ending "T&Cs apply." Write it from the facts given.
- terms: the full terms, written from the facts given.

Rules:
- NEVER invent a business fact. Amounts, costs, dates, windows and who qualifies come only from what ops said. If it wasn't said, leave it empty: "" for text and choices, 0 for numbers, [] for lists.
- You may write label, mechanic, offerLine and terms from the facts given, and choose size from the cost.
- Keep everything already settled in the current draft unless ops change it.
- question: if anything needed is still empty or unclear, ask for it in ONE short, plain message (you may ask about several things at once, as a short list). Name what you need in the ops person's words, never field names. If nothing is missing, "".`;
}

export interface DraftResult {
  draft: Partial<Incentive>;
  /** What the checks still find, in plain words (empty when the draft is complete). */
  problems: string[];
  /** The next question to ops, or null when complete. */
  question: string | null;
  done: boolean;
}

type Call = (system: string, user: string) => Promise<LlmCallResult>;

/** Rounds the model gets to fix check problems itself before ops are asked. */
export const MAX_SELF_FIX = 2;

/**
 * Problems the model can fix from what ops already said (a rule's spelling, the customer line,
 * a cost put with the wrong trigger, a reference already taken). Missing facts are not on this
 * list: those are asked.
 */
export const selfFixable = (p: string) => /^(Product rule|Meant for):|characters\. Keep it|cannot carry a link|needs a spend trigger|only works with an EMI|already an offer with the reference|The reference is lower-case/.test(p);

const defaultCall: Call = (system, user) =>
  callClaude({ system, messages: [{ role: 'user', content: user }], maxTokens: 6000, timeoutMs: 90_000, outputConfig: { effort: 'low', format: { type: 'json_schema', schema: DRAFT_SCHEMA as unknown as Record<string, unknown> } } });

/** One step of the conversation: the turns so far and the current draft → the updated draft and what's still needed. */
export async function draftIncentive(tenant: TenantConfig, turns: DraftTurn[], current: Partial<Incentive> | null, call: Call = defaultCall): Promise<DraftResult> {
  const convo = turns.map((t) => `${t.role === 'ops' ? 'OPS' : 'YOU ASKED'}: ${t.text}`).join('\n\n');
  const user = `${current ? `Current draft (keep what is settled):\n${JSON.stringify(current)}\n\n` : ''}Conversation:\n${convo}\n\nReturn the full updated draft.`;
  const system = systemFor(tenant);
  const ask = async (prompt: string) => {
    const r = await call(system, prompt);
    if (r.stopReason === 'max_tokens') throw new Error('The draft ran out of room. Try a shorter description.');
    try {
      return JSON.parse(r.text) as Raw;
    } catch {
      throw new Error('Could not read the draft. Try again.');
    }
  };
  const check = (raw: Raw) => {
    const draft = toIncentive(raw, current?.id);
    const { problems } = checkIncentive({ ...draft, status: 'live' }, signalsFor(tenant));
    if (!current?.id && incentivesFor(tenant).some((i) => i.id === draft.id)) problems.push(`There is already an offer with the reference "${draft.id}". Give this one a different name.`);
    return { draft, problems };
  };
  // A small loop: the checks go back to the model so it fixes what it can from what ops said
  // (a rule's spelling, a line too long, a cost in the wrong field). Only what needs ops is asked.
  let raw = await ask(user);
  let { draft, problems } = check(raw);
  for (let round = 0; round < MAX_SELF_FIX && problems.some(selfFixable); round++) {
    raw = await ask(`${user}\n\nYour draft:\n${JSON.stringify(raw)}\n\nThe checks found:\n${problems.map((p) => `- ${p}`).join('\n')}\n\nFix what you can from what ops said. Never invent a fact to pass a check: anything only ops can answer stays empty and goes in the question. Return the full draft.`);
    ({ draft, problems } = check(raw));
  }
  const done = problems.length === 0;
  const asked = typeof raw.question === 'string' && raw.question.trim() ? raw.question.trim() : null;
  // Code decides when the draft is complete; the model only words the question.
  const question = done ? null : (asked ?? `Still needed:\n${problems.map((p) => `- ${p}`).join('\n')}`);
  return { draft, problems, question, done };
}
