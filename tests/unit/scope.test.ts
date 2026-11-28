// Card logos and scope: every flow or campaign is for one or more of the bank's
// card logos, or all cards. The fake data has logos and cards; code keeps every
// count within the scope; the designer settles scope first; the trend replays it.
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { logosFor, parseScope, scopeBlock, scopeText, withinScope, holdersSql } from '../../server/logos';
import { conditionSql, resolveSignalSql, signalsFor } from '../../server/signals';
import { runWarehouseQuery, warehousePath } from '../../server/warehouse';
import { sizingPlan } from '../../server/agent/autoSize';
import { resolveTenant } from '../../server/tenants';
import type { CampaignObject } from '../../server/agent/types';

const YES = resolveTenant('TEN-YES')!;
const DEMO = resolveTenant('TEN-DEMO')!;
const hasData = existsSync(warehousePath('yesbank'));
const n = (sql: string) => Number(runWarehouseQuery('yesbank', `SELECT COUNT(*) AS n FROM (${sql})`).rows[0].n);

describe('the logo catalogue', () => {
  it('each bank has its real card lineup; a bank without data still gets its catalogue', () => {
    const yes = logosFor(YES).map((l) => l.name);
    expect(yes).toEqual(expect.arrayContaining(['YES BANK MARQUEE', 'YES BANK ACE', 'YES BANK KLICK (RuPay)']));
    expect(yes.length).toBeGreaterThanOrEqual(6);
    expect(logosFor(DEMO).map((l) => l.name)).toContain('IndusInd Legend'); // IndusInd issuer, no warehouse
  });
});

describe('scope', () => {
  const logos = logosFor(YES);
  it('takes ids or names, refuses a card the bank does not issue, and "every logo" is all cards', () => {
    expect(parseScope({ logos: ['ACE'] }, logos)).toEqual({ value: { logos: ['yes_ace'] } });
    expect(parseScope({ logos: ['yes_ace', 'YES BANK ELITE+'] }, logos)).toEqual({ value: { logos: ['yes_ace', 'yes_elite_plus'] } });
    expect(parseScope({ logos: ['Platinum Aura'] }, logos)).toMatchObject({ error: expect.stringMatching(/not one of this bank's card logos/) });
    expect(parseScope({ all: true }, logos)).toEqual({ value: { all: true } });
    expect(parseScope({ logos: logos.map((l) => l.logo_id) }, logos)).toEqual({ value: { all: true } });
    expect(scopeText({ logos: ['yes_ace', 'yes_klick'] }, logos)).toBe('ACE · KLICK (RuPay)');
  });

  it('the designer is told to settle scope first, and gets the scoped card\'s own fact sheet', () => {
    expect(scopeBlock({ scope: null }, YES)).toMatch(/Scope: NOT DECIDED[\s\S]*Which card is this for\?[\s\S]*All cards/);
    const one = scopeBlock({ scope: { logos: ['yes_ace'] } }, YES);
    expect(one).toMatch(/## Scope: ACE/);
    expect(one).toMatch(/8 YES Rewardz points per ₹200 online/);
    expect(one).toMatch(/never quote a fee/i);
  });
});

describe.runIf(hasData)('the fake data: logos and cards', () => {
  it('every customer has a card, about a fifth hold two, nothing happens before a card exists', () => {
    const r = runWarehouseQuery('yesbank', `SELECT (SELECT COUNT(*) FROM customers) AS customers, (SELECT COUNT(DISTINCT customer_id) FROM cards) AS holders, (SELECT COUNT(*) FROM cards WHERE is_primary = 0) AS second,
      (SELECT COUNT(*) FROM transactions t JOIN cards c ON c.card_id = t.card_id WHERE t.transaction_date < c.issued_date) AS early,
      (SELECT COUNT(*) FROM transactions WHERE card_id IS NULL) AS orphan`).rows[0];
    expect(r.holders).toBe(r.customers);
    expect(Number(r.second) / Number(r.customers)).toBeGreaterThan(0.12);
    expect(Number(r.second) / Number(r.customers)).toBeLessThan(0.25);
    expect(r.early).toBe(0);
    expect(r.orphan).toBe(0);
  });
});

describe.runIf(hasData)('counts stay within the scope', () => {
  const signals = signalsFor(YES);
  it('a signal looks only at the scoped cards: spend on ACE is never more than spend on all cards', () => {
    const all = conditionSql(signals, { attribute: 'ever_transacted', operator: 'Is', value: 'true' })!;
    const ace = conditionSql(signals, { attribute: 'ever_transacted', operator: 'Is', value: 'true' }, { logos: ['yes_ace'] })!;
    expect(n(ace)).toBeLessThan(n(all));
    expect(n(withinScope(all, { logos: ['yes_ace'] }))).toBeLessThanOrEqual(n(holdersSql({ logos: ['yes_ace'] })));
  });

  it('a rule that matches everyone still counts only the scope\'s cardholders', () => {
    const c = { scope: { logos: ['yes_marquee'] }, entry: null, everyoneElse: null, membership: { type: 'locked' }, goal: null,
      buckets: [{ id: 'b', name: 'Everyone', priority: 1, rule: [{ entity: 'Signal', conditions: [{ attribute: 'cards_held', operator: 'Greater than', value: '0' }] }], journey: [] }] } as unknown as CampaignObject;
    const plan = sizingPlan(c, YES, {})!;
    expect(n(plan.buckets[0].sql!)).toBeLessThanOrEqual(n(holdersSql({ logos: ['yes_marquee'] })));
    expect(n(plan.target!)).toBe(n(plan.buckets[0].sql!));
  });

  it('"today" can be moved back: the same rule as of 90 days ago uses only the data up to then', () => {
    const sql = signals.find((s) => s.key === 'days_since_last_txn')!.sql!;
    const asOf = runWarehouseQuery('yesbank', `SELECT MAX(value) AS m FROM (${resolveSignalSql(sql)})`).rows[0].m as number;
    const past = runWarehouseQuery('yesbank', `SELECT MAX(value) AS m FROM (${resolveSignalSql(sql, { asOf: '2026-02-04' })})`).rows[0].m as number;
    expect(past).toBeLessThan(asOf); // nobody can have been away longer than the data reaches back
    expect(resolveSignalSql(sql, { asOf: '2026-02-04', logos: ['yes_ace'] })).toMatch(/transaction_date <= '2026-02-04' AND card_id IN \(SELECT card_id FROM cards WHERE logo_id IN \('yes_ace'\)\)/);
  });
});
