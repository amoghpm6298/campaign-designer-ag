// Offers described in plain words (server/incentiveDraft.ts): code decides when the draft is complete; the model fixes what it can, ops are asked the rest.
import { describe, it, expect } from 'vitest';
import { draftIncentive, selfFixable } from '../../server/incentiveDraft';
import { resolveTenant } from '../../server/tenants';

const YES = resolveTenant('TEN-YES')!;
const full = {
  label: '₹250 cashback on dining', mechanic: '₹250 cashback on a dining spend.', offerLine: 'Spend ₹5,000 on dining in 21 days, get ₹250 cashback. T&Cs apply.', terms: 'Spend ₹5,000 on dining within 21 days.',
  size: 'big', action: 'spend', withinDays: 21, minAmount: 5000, category: 'dining', costType: 'flat', perRedemption: 250, ratePct: 0, capPerCustomer: 0,
  interestDiscountPctPa: 0, maxCostPerCustomer: 0, feeByCardType: [], requires: [], eligibility: [], unmatchedCriteria: [], validFrom: '2026-12-01', validTo: '2027-02-28', question: '',
};
const reply = (o: Record<string, unknown>) => ({ text: JSON.stringify(o), model: 'x', durationMs: 1 });
const turns = [{ role: 'ops' as const, text: '₹250 cashback on ₹5,000 dining spend in 21 days, costs ₹250, Dec to Feb.' }];

describe('describing an offer', () => {
  it('missing facts are asked, never filled in: dates left empty keep it open', async () => {
    const calls: string[] = [];
    const r = await draftIncentive(YES, turns, null, async (_s, u) => (calls.push(u), reply({ ...full, validFrom: '', validTo: '', question: 'When does it run?' })));
    expect(r.done).toBe(false);
    expect(r.question).toBe('When does it run?');
    expect(r.problems.join(' ')).toMatch(/dates/);
    expect(calls).toHaveLength(1); // missing facts are not "fixed" by the model
  });
  it('the model fixes what it can itself (a rule spelled wrongly) before anyone is asked', async () => {
    let n = 0;
    const r = await draftIncentive(YES, turns, null, async () => {
      n++;
      return reply(n === 1 ? { ...full, requires: [{ attribute: 'emi_ok', operator: 'Is', value: 'true' }] } : full);
    });
    expect(n).toBe(2);
    expect(r.done).toBe(true);
    expect(r.question).toBeNull();
    expect(r.draft.id).toBe('rs250_cashback_on_dining');
  });
  it('code decides it is complete, whatever the model says; and a question is asked while checks fail even if the model asks none', async () => {
    expect((await draftIncentive(YES, turns, null, async () => reply({ ...full, question: 'Anything else?' }))).done).toBe(true);
    const open = await draftIncentive(YES, turns, null, async () => reply({ ...full, perRedemption: 0, question: '' }));
    expect(open.done).toBe(false);
    expect(open.question).toMatch(/Still needed/);
  });
  it('only check problems the model can fix send it back', () => {
    expect(selfFixable('Product rule: "emi_ok" is not a signal for this bank.')).toBe(true);
    expect(selfFixable('The line the customer reads is 190 characters. Keep it to 160: it goes into SMS.')).toBe(true);
    expect(selfFixable('A fixed-cost offer needs its cost per customer who earns it, in rupees.')).toBe(false);
    expect(selfFixable('Give the dates the offer is valid, from and to.')).toBe(false);
  });
});
