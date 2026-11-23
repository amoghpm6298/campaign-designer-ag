// The step-by-step funnel: the designer's estimates on every message (funnelChecks) and the
// bank's delivery rates (bankSettings). The maths itself is covered in phase2/phase3.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { funnelProblems } from '../../server/agent/funnelChecks';
import { DEFAULT_DELIVERY_RATES, getBankSettings, saveBankSettings } from '../../server/bankSettings';
import type { CampaignObject } from '../../server/agent/types';

const est = (rate: number, why = 'judgement') => ({ rate, why });
const send = (name: string, ch: string, funnel?: Record<string, unknown>) => ({ kind: 'send', name, channelPreference: [ch], ...(funnel ? { funnel } : {}) });
const camp = (journey: unknown[]) => ({ buckets: [{ id: 'b', name: 'Lapsed', priority: 1, journey }] }) as unknown as CampaignObject;
const after = (first: unknown, second: unknown) => camp([first, { kind: 'wait', durationHours: 72 }, { kind: 'goalCheck' }, { kind: 'branch', paths: [{ label: 'Read', statuses: ['READ'], steps: [second] }] }]);

describe('funnel estimates on every message', () => {
  it('every message needs opens and converts; SMS needs converts only', () => {
    const p = funnelProblems(camp([send('Hello', 'WHATSAPP'), send('Text', 'SMS', { converts: est(0.05) })])).join(' ');
    expect(p).toMatch(/"Hello": give funnel opens and converts/);
    expect(p).not.toMatch(/"Text"/);
    expect(funnelProblems(camp([send('Hello', 'WHATSAPP', { opens: est(0.6), converts: est(0.1) })]))).toEqual([]);
  });
  it('a later message may convert better than an earlier one: that is the designer\'s judgement, not checked', () => {
    const first = send('First', 'WHATSAPP', { opens: est(0.6), converts: est(0.04) });
    expect(funnelProblems(after(first, send('Reminder', 'WHATSAPP', { opens: est(0.5), converts: est(0.05) })))).toEqual([]);
  });
  it('rates must be fractions with a reason', () => {
    expect(funnelProblems(camp([send('Hello', 'WHATSAPP', { opens: est(60), converts: est(0.1) })])).join(' ')).toMatch(/give funnel opens/);
    expect(funnelProblems(camp([send('Hello', 'WHATSAPP', { opens: est(0.6, ' '), converts: est(0.1) })])).join(' ')).toMatch(/give funnel opens/);
  });
});

describe("the bank's delivery rates", () => {
  it('start at typical rates, save per channel, and ignore anything that is not a fraction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cd-rates-'));
    expect(getBankSettings('TEN-YES', dir).deliveryRates).toEqual(DEFAULT_DELIVERY_RATES);
    saveBankSettings('TEN-YES', { deliveryRates: { WHATSAPP: 0.82, SMS: 7 } as never }, dir);
    const r = getBankSettings('TEN-YES', dir).deliveryRates;
    expect(r.WHATSAPP).toBe(0.82);
    expect(r.SMS).toBe(DEFAULT_DELIVERY_RATES.SMS);
    // Changing the SMS retry setting keeps the rates.
    saveBankSettings('TEN-YES', { smsFallback: false }, dir);
    expect(getBankSettings('TEN-YES', dir)).toMatchObject({ smsFallback: false, deliveryRates: { WHATSAPP: 0.82 } });
  });
});
