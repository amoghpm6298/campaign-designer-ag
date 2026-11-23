// Ops manage the offer menu (server/incentives.ts): a file per bank, every save checked, offers paused not deleted.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkIncentive, incentivesFor, saveIncentive, setIncentiveStatus, validFor, type Incentive } from '../../server/incentives';
import { resolveTenant } from '../../server/tenants';
import type { Signal } from '../../server/signals';

const YES = resolveTenant('TEN-YES')!;
const DEMO = resolveTenant('TEN-DEMO')!;
const dir = () => mkdtempSync(join(tmpdir(), 'cd-offers-'));
const SIGNALS: Signal[] = [{ key: 'emi_eligible', label: 'Eligible for EMI', type: 'bool', kind: 'profile', definition: '', usableIn: ['rule', 'eligibility'], status: 'live', sensitivity: 'normal' }];

const offer = (patch: Partial<Incentive> = {}): Partial<Incentive> => ({
  id: 'cashback_test',
  label: '₹150 cashback',
  size: 'small',
  mechanic: '₹150 cashback on a spend.',
  trigger: { action: 'spend', minAmount: 2000, withinDays: 14 },
  costType: 'flat',
  cost: { perRedemption: 150, ratePct: 9 },
  requires: [],
  eligibility: [],
  unmatchedCriteria: [],
  validFrom: '2026-12-01',
  validTo: '2027-01-31',
  terms: 'Spend ₹2,000 in 14 days, get ₹150.',
  offerLine: 'Spend ₹2,000 in 14 days and get ₹150 cashback. T&Cs apply.',
  status: 'live',
  ...patch,
});

describe('checking an offer ops entered', () => {
  it('cleans a valid offer: cost fields of other types dropped, max cost and goals worked out', () => {
    const r = checkIncentive(offer(), SIGNALS);
    expect(r.problems).toEqual([]);
    expect(r.incentive!.cost).toEqual({ perRedemption: 150 });
    expect(r.incentive!.maxCostPerCustomer).toBe(150);
    expect(r.incentive!.fitsGoals).toEqual(['Transaction']);
  });
  it('refuses a cost that does not suit the trigger, and says why', () => {
    const p = checkIncentive(offer({ trigger: { action: 'emi_conversion', withinDays: 30 }, costType: 'pctOfSpend', cost: { ratePct: 1 } }), SIGNALS).problems.join(' ');
    expect(p).toMatch(/needs a spend trigger/);
    expect(p).toMatch(/cap per customer/);
    expect(checkIncentive(offer({ costType: 'interest', cost: { interestDiscountPctPa: 3 }, maxCostPerCustomer: 900 }), SIGNALS).problems.join(' ')).toMatch(/only works with an EMI conversion/);
  });
  it('refuses rules on unknown signals, bad dates, and a link in the customer line', () => {
    const p = checkIncentive(
      offer({ requires: [{ attribute: 'vip_score', operator: 'Equals', value: '1' }], validFrom: '2027-02-01', offerLine: 'Go to https://x.in now' }),
      SIGNALS,
    ).problems.join(' ');
    expect(p).toMatch(/"vip_score" is not a signal/);
    expect(p).toMatch(/ends before it starts/);
    expect(p).toMatch(/cannot carry a link/);
  });
});

describe('the menu file', () => {
  it('a bank starts with the example menu; banks without a menu have none and cannot save', () => {
    const d = dir();
    expect(incentivesFor(YES, d).every((i) => i.mock)).toBe(true);
    expect(saveIncentive(DEMO, offer(), 'ops', d).ok).toBe(false);
  });
  it('saving adds or replaces by reference; the rest of the menu is kept', () => {
    const d = dir();
    const before = incentivesFor(YES, d).length;
    expect(saveIncentive(YES, offer(), 'ops', d).ok).toBe(true);
    expect(saveIncentive(YES, offer({ label: '₹150 cashback, changed' }), 'ops', d).ok).toBe(true);
    const menu = incentivesFor(YES, d);
    expect(menu).toHaveLength(before + 1);
    const mine = menu.find((i) => i.id === 'cashback_test')!;
    expect(mine.label).toBe('₹150 cashback, changed');
    expect(mine).not.toHaveProperty('budget');
    expect(mine.mock).toBeUndefined();
    expect(mine.updatedBy).toBe('ops');
  });
  it('a paused offer stays on file but is no longer valid for any campaign; resuming brings it back', () => {
    const d = dir();
    saveIncentive(YES, offer(), 'ops', d);
    expect(setIncentiveStatus(YES, 'cashback_test', 'paused', 'ops', d).ok).toBe(true);
    const paused = incentivesFor(YES, d).find((i) => i.id === 'cashback_test')!;
    expect(validFor(paused, { startDate: '2026-12-05', endDate: '2026-12-20' }, '2026-11-23')).toBe(false);
    setIncentiveStatus(YES, 'cashback_test', 'live', 'ops', d);
    expect(validFor(incentivesFor(YES, d).find((i) => i.id === 'cashback_test')!, { startDate: '2026-12-05', endDate: '2026-12-20' }, '2026-11-23')).toBe(true);
    expect(setIncentiveStatus(YES, 'nope', 'paused', 'ops', d).ok).toBe(false);
  });
});
