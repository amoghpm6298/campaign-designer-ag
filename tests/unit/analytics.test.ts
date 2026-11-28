// Analytics: the designer writes the KPI and charts (set_analytics); code checks,
// runs and caches them: read-only, within the scope, the right columns for each
// chart type, refused with the reason when not.
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyticsFor, parseAnalytics, resolveAnalyticsSql, runChart } from '../../server/analytics';
import { saveCampaignObject } from '../../server/campaignFiles';
import { warehousePath } from '../../server/warehouse';
import { systemPrompt } from '../../server/agent/prompt';
import type { CampaignObject } from '../../server/agent/types';

const hasData = existsSync(warehousePath('yesbank'));
const KPI = {
  title: 'Weekly ACE spenders',
  definition: 'ACE cardholders with a transaction that week',
  unit: 'count',
  sql: `SELECT date(transaction_date, 'weekday 0') AS week, COUNT(DISTINCT customer_id) AS value FROM {{TX}} WHERE transaction_date > date({{ASOF}}, '-91 day') GROUP BY 1 ORDER BY 1`,
};
const BAR = { title: 'Spend by category', question: 'Where do they spend?', type: 'bar', sql: `SELECT category AS label, COUNT(*) AS value FROM {{TX}} GROUP BY 1 ORDER BY 2 DESC LIMIT 8` };

beforeEach(() => {
  process.env.CAMPAIGN_DIR = mkdtempSync(join(tmpdir(), 'cd-an-'));
});

describe('the analytics spec', () => {
  it('needs a KPI and 1-6 charts, each with a title, a question, a known type and SQL', () => {
    expect(parseAnalytics({ kpi: KPI, charts: [BAR] })).toMatchObject({ value: { kpi: { id: 'kpi', type: 'line', title: 'Weekly ACE spenders' }, charts: [{ type: 'bar' }] } });
    expect(parseAnalytics({ charts: [BAR] })).toMatchObject({ error: expect.stringMatching(/kpi/) });
    expect(parseAnalytics({ kpi: KPI, charts: [] })).toMatchObject({ error: expect.stringMatching(/1 to 6/) });
    expect(parseAnalytics({ kpi: KPI, charts: Array(7).fill(BAR) })).toMatchObject({ error: expect.stringMatching(/1 to 6/) });
    expect(parseAnalytics({ kpi: KPI, charts: [{ ...BAR, type: 'pie' }] })).toMatchObject({ error: expect.stringMatching(/line, bar, funnel or number/) });
    expect(parseAnalytics({ kpi: KPI, charts: [{ ...BAR, question: '' }] })).toMatchObject({ error: expect.stringMatching(/needs question/) });
  });

  it('the app fills in the scope: only the scoped cards and their holders, never a logo filter written by the designer', () => {
    const sql = resolveAnalyticsSql('SELECT COUNT(*) AS value FROM {{TX}} WHERE customer_id IN {{SCOPE}}', { logos: ['yes_ace'] });
    expect(sql).toMatch(/card_id IN \(SELECT card_id FROM cards WHERE logo_id IN \('yes_ace'\)\)/);
    expect(sql).toMatch(/customer_id IN \(SELECT DISTINCT customer_id FROM cards WHERE logo_id IN \('yes_ace'\)\)/);
    expect(sql).not.toMatch(/\{\{/);
  });

  it('the designer is told to write the analytics after every build, KPI first', () => {
    const p = systemPrompt(true, true, 'flow');
    expect(p).toMatch(/ANALYTICS\. After every build, write the analytics with set_analytics/);
    expect(p).toMatch(/In a flow, the analytics KPI is per weekly group of joiners/);
    // A first live run headlined 0%: the newest weeks' 30 days had not passed yet.
    expect(p).toMatch(/only include weekly groups whose N days have passed, so the latest point is the latest complete week/);
    expect(systemPrompt(true, true, 'campaign')).toMatch(/In a campaign, the analytics KPI is progress against the target/);
  });
});

describe.runIf(hasData)('running the charts', () => {
  it('runs within the scope and keeps only the columns the chart shows', () => {
    const r = runChart('yesbank', { id: 'kpi', ...KPI, question: '', type: 'line', unit: 'count' }, { logos: ['yes_ace'] });
    expect(r.error).toBeUndefined();
    expect(r.rows.length).toBeGreaterThan(5);
    expect(Object.keys(r.rows[0])).toEqual(['week', 'value']);
    const all = runChart('yesbank', { id: 'b', ...BAR, type: 'bar' }, { all: true });
    const ace = runChart('yesbank', { id: 'b', ...BAR, type: 'bar' }, { logos: ['yes_ace'] });
    expect(Number(ace.rows[0].value)).toBeLessThan(Number(all.rows[0].value));
  });

  it('refuses the wrong columns, too many rows, and anything that is not a read', () => {
    expect(runChart('yesbank', { id: 'x', title: 'Bad', question: 'q', type: 'line', sql: 'SELECT 1 AS a, 2 AS b' }, null).error).toMatch(/returned columns a, b; a line needs week, value/);
    expect(runChart('yesbank', { id: 'x', title: 'Big', question: 'q', type: 'number', sql: 'SELECT customer_id AS value FROM customers LIMIT 5' }, null).error).toMatch(/at most 1/);
    expect(runChart('yesbank', { id: 'x', title: 'Del', question: 'q', type: 'number', sql: 'DELETE FROM customers' }, null).error).toBeTruthy();
  });

  it('caches the results beside the campaign and reruns them when the spec changes', () => {
    const spec = parseAnalytics({ kpi: KPI, charts: [BAR] });
    if (!('value' in spec)) throw new Error('bad spec');
    const c = { goal: null, entry: null, membership: null, buckets: [], everyoneElse: null, scope: { logos: ['yes_ace'] }, analytics: spec.value } as unknown as CampaignObject;
    saveCampaignObject('cv-an1', 'TEN-YES', c);
    const first = analyticsFor('cv-an1', 'TEN-YES');
    expect(first.results.kpi.rows.length).toBeGreaterThan(5);
    expect(analyticsFor('cv-an1', 'TEN-YES').ranAt).toBe(first.ranAt); // from the cache
    saveCampaignObject('cv-an1', 'TEN-YES', { ...c, analytics: { ...spec.value, charts: [{ ...spec.value.charts[0], title: 'Spend by category (top 8)' }] } });
    expect(analyticsFor('cv-an1', 'TEN-YES').results[spec.value.charts[0].id].rows.length).toBeGreaterThan(0);
  });
});
