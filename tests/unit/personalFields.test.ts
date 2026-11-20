// Dynamic messages: personal words ({{field | "fallback"}}) in copy.
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fillFields, formatValue, malformedFields, parseFields } from '../../src/designer/v2/personalFields';
import { fieldProblems } from '../../server/agent/fieldChecks';
import { fieldSamples } from '../../server/signals';
import { toEngineCampaign } from '../../server/engineExport';
import { resolveTenant } from '../../server/tenants';
import { warehousePath } from '../../server/warehouse';
import { systemPrompt } from '../../server/agent/prompt';
import type { CampaignObject } from '../../server/agent/types';

const YES = resolveTenant('TEN-YES')!;
const hasYes = existsSync(warehousePath('yesbank'));
const camp = (copy: string, extra: Record<string, unknown> = {}): CampaignObject =>
  ({
    goal: { eventCategory: 'Transaction Events', eventType: 'Transaction' },
    entry: { kind: 'audience', entity: 'Customer' },
    membership: { type: 'locked' },
    schedule: { startDate: '2026-12-01', endDate: '2026-12-20' },
    everyoneElse: { approach: 'none' },
    buckets: [{ id: 'b', name: 'B', priority: 1, rule: [], journey: [{ id: 's1', kind: 'send', name: 'Nudge', rationale: 'r', copy, channelPreference: ['WHATSAPP'], ...extra }] }],
  }) as unknown as CampaignObject;

describe('reading and formatting fields', () => {
  it('parses fields with and without fallbacks; spots malformed ones', () => {
    const r = parseFields('Most of it goes on {{top_category | "everyday buys"}}, {{ spend_90d|\'some\' }} and {{tenure_months}}.');
    expect(r.map((x) => [x.key, x.fallback])).toEqual([['top_category', 'everyday buys'], ['spend_90d', 'some'], ['tenure_months', null]]);
    expect(malformedFields('Hi {top_category} and {{ }}')).toEqual(['{top_category}', '{{ }}']);
  });
  it('code formats values; the fallback fills in when there is none', () => {
    expect(formatValue('top_category', 'category', 'online_shopping')).toBe('online shopping');
    expect(formatValue('top_category', 'category', 'grocery')).toBe('groceries');
    expect(formatValue('top_category', 'category', 'dining')).toBe('dining out');
    expect(formatValue('top_category', 'category', 'others')).toBe('');
    expect(formatValue('spend_90d', 'money', 4200.4)).toBe('₹4,200');
    expect(formatValue('tenure_months', 'number', 38)).toBe('3 years');
    expect(formatValue('tenure_months', 'number', 7)).toBe('7 months');
    expect(fillFields('On {{top_category | "everyday buys"}}', () => null)).toBe('On everyday buys');
    expect(fillFields('On {{top_category | "everyday buys"}}', () => 'groceries')).toBe('On groceries');
  });
});

describe('checks', () => {
  it.runIf(hasYes)('a field needs a real, allowed signal and a fallback; sensitive ones are never allowed', () => {
    expect(fieldProblems(camp('Spend on {{top_category | "everyday buys"}} this week.'), YES).join(' ')).not.toMatch(/top_category/);
    const p = fieldProblems(camp('{{vip_tier | "x"}} {{credit_limit | "your limit"}} {{top_category}} {top_category}'), YES).join(' ');
    expect(p).toMatch(/\{\{vip_tier\}\} is not a signal/);
    expect(p).toMatch(/\{\{credit_limit\}\} is sensitive/);
    expect(p).toMatch(/\{\{top_category\}\} needs a fallback/);
    expect(p).toMatch(/"\{top_category\}" isn't a valid personal field/);
  });
  it('without data access, no field can be used (there are no data signals)', () => {
    expect(fieldProblems(camp('Spend on {{top_category | "x"}}.'), { incentives: true } as never).join(' ')).toMatch(/is not a signal for this bank/);
  });
  it.runIf(hasYes)('an SMS must fit 160 characters with the longest value of every field', () => {
    const long = `${'Your card is ready for all of your favourite everyday purchases this festive month, '.repeat(2)}especially {{top_category | "everyday buys"}}.`;
    expect(fieldProblems(camp(long, { channelPreference: ['SMS'] }), YES).join(' ')).toMatch(/with the longest values filled in, the SMS is \d+ characters/);
    expect(fieldProblems(camp('Spend on {{top_category | "everyday buys"}}.', { channelPreference: ['SMS'] }), YES)).toEqual([]);
  });
  it.runIf(hasYes)('samples come from the data, formatted', () => {
    const top = fieldSamples(YES, formatValue).find((f) => f.key === 'top_category')!;
    expect(top.sample).toBeTruthy();
    expect(top.longest).toBe('online shopping');
    expect(fieldSamples(YES, formatValue).map((f) => f.key)).not.toContain('credit_limit');
  });
});

describe('engine and prompt', () => {
  it('the engine gets the copy with its fields, and the list of fields used', () => {
    const { engine } = toEngineCampaign(camp('Spend on {{top_category | "everyday buys"}}.'), YES);
    expect(JSON.stringify(engine)).toContain('{{top_category | \\"everyday buys\\"}}');
    if (hasYes) expect((engine.personalFields as { key: string }[]).map((f) => f.key)).toEqual(['top_category']);
  });
  it('the prompt teaches personal words, and wording-only differences use them instead of splits', () => {
    expect(systemPrompt(true, true)).toMatch(/PERSONAL WORDS/);
    expect(systemPrompt(true, true)).toMatch(/Wording only \(e\.g\. naming their category\) is never a split: use personal words/);
  });
});
