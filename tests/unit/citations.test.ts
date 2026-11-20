// Data-anchored writing: inline sources ([Q7], [M], [O]) checked by code against the rows.
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { citationProblems, extractNumbers, matchesSource, nextQid, sentences } from '../../server/agent/citations';
import { runToolCall, type ToolEnv } from '../../server/agent/tools';
import { initialState } from '../../server/agent/state';
import { resolveTenant } from '../../server/tenants';
import { warehousePath } from '../../server/warehouse';
import type { CampaignContext, CampaignObject } from '../../server/agent/types';

const YES = resolveTenant('TEN-YES')!;
const n = (s: string) => extractNumbers(s)[0];

describe('reading numbers as people write them', () => {
  it('handles rupees, Indian commas, percentages, decimals, ranges, lakh and k', () => {
    const v = (s: string) => extractNumbers(s).map((x) => x.value);
    expect(v('₹1,11,800 vs ₹1,55,437')).toEqual([111800, 155437]);
    expect(v('61% of 2,256')).toEqual([61, 2256]);
    expect(v('6.1–17.6 and 31-60 days')).toEqual([6.1, 17.6, 31, 60]);
    expect(v('Rs 4 lakh, 2.4L and 12k')).toEqual([400000, 240000, 12000]);
    expect(v('Q4, x2, 2027 and 1 Jan')).toEqual([]);
  });
  it('a marker after the full stop belongs to that sentence', () => {
    expect(sentences('Lifetime 1.76 transactions. [Q4]\nNext line [Q2].')).toEqual(['Lifetime 1.76 transactions. [Q4]', 'Next line [Q2].']);
  });
});

describe('matching a written number to its source', () => {
  it('accepts rounding to the precision written, fractions as percentages and simple derivations', () => {
    expect(matchesSource(n('about 45'), [45.28])).toBe(true);
    expect(matchesSource(n('61%'), [0.613])).toBe(true);
    expect(matchesSource(n('~6,600'), [6634])).toBe(true);
    expect(matchesSource(n('28% lower'), [6.62, 9.19])).toBe(true);
    expect(matchesSource(n('2x'), [36, 72])).toBe(true);
  });
  it('rejects what the rows do not say', () => {
    expect(matchesSource(n('23%'), [0.181])).toBe(false);
    expect(matchesSource(n('7,000'), [6634])).toBe(false);
    expect(matchesSource(n('28.5%'), [16855, 16945, 45.28])).toBe(false);
  });
});

// A small campaign: one bucket, one query Q1 with rows, a manager answer.
const camp = {
  buckets: [{ id: 'lapsed', name: 'Lapsed', priority: 1, rule: [{ entity: 'Signal', conditions: [{ attribute: 'days_since_last_txn', operator: 'Greater than', value: '60' }] }], journey: [{ id: 's1', kind: 'send', name: 'Nudge', copy: 'x', rationale: 'Leads with the offer.' }] }],
  budgetCap: 400000,
} as unknown as CampaignObject;
let k = 0;
const entry = (e: Record<string, unknown>) => ({ id: `c${++k}`, at: new Date().toISOString(), source: 'agent', text: '', ...e });
const ctx = (...extra: Record<string, unknown>[]): CampaignContext =>
  ({
    entries: [
      entry({ kind: 'research', topic: 'query: Q1 Lifetime transactions by band', source: 'data', data: { qid: 'Q1', rows: [{ band: '180+', avg_txns: 1.7647 }, { band: '91-180', avg_txns: 6.1435 }, { band: 'active', avg_txns: 17.5997 }] } }),
      entry({ kind: 'answer', topic: 'Spend', source: 'manager', text: 'Cheapest first. Offer budget up to Rs 4 lakh.' }),
      ...extra.map(entry),
    ],
  }) as unknown as CampaignContext;

describe('the check', () => {
  it('passes cited figures that are in the rows', () => {
    const r = citationProblems(camp, ctx({ kind: 'bucket', bucketId: 'lapsed', topic: 'why stuck', text: 'Only 1.76 lifetime transactions, against 6.1-17.6 for the other bands [Q1].' }), YES, true);
    expect(r.errors).toEqual([]);
    expect(r.stats).toMatchObject({ cited: 3, matched: 3, mismatched: 0 });
  });
  it('flags a citation to nothing, and a figure its source does not contain', () => {
    const r = citationProblems(
      camp,
      ctx(
        { kind: 'bucket', bucketId: 'lapsed', topic: 'why stuck', text: 'Utilisation is 28.5% for both groups [Q1].' },
        { kind: 'note', topic: 'campaign strategy', text: '## Buckets\n- Lapsed: 1.76 transactions [Q9].' },
      ),
      YES,
      true,
    );
    expect(r.errors.join(' ')).toMatch(/"28.5%" is not in \[Q1\]/);
    expect(r.errors.join(' ')).toMatch(/cites \[Q9\], but there is no query Q9/);
  });
  it('warns, never errors, on a data number with no source; campaign facts are never flagged', () => {
    const r = citationProblems(
      camp,
      ctx({ kind: 'bucket', bucketId: 'lapsed', topic: 'rationale', text: 'They logged in 45 days ago on average. Up to 3 messages, within the Rs 4 lakh cap, for people quiet over 60 days.' }),
      YES,
      true,
    );
    expect(r.errors).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/"45" has no source/);
  });
  it('[M] is checked against the manager\'s answers', () => {
    expect(citationProblems(camp, ctx({ kind: 'note', topic: 'n', text: 'Budget is Rs 4 lakh [M].' }), YES, true).errors).toEqual([]);
    expect(citationProblems(camp, ctx({ kind: 'note', topic: 'n', text: 'Budget is Rs 6 lakh [M].' }), YES, true).errors.join(' ')).toMatch(/"6 lakh" is not in \[M\]/);
  });
  it('[M] covers what the manager wrote in the brief and chat, not only answers', () => {
    const r = citationProblems(camp, ctx({ kind: 'note', topic: 'n', text: 'Keep expected spend under 40,000 [M].' }), YES, true, ['Get lapsed cardholders to spend.', 'Keep expected spend under Rs 40,000 please.']);
    expect(r.errors).toEqual([]);
  });
  it('without data there are no uncited-number warnings', () => {
    expect(citationProblems(camp, ctx({ kind: 'note', topic: 'n', text: 'They logged in 45 days ago.' }), YES, false).warnings).toEqual([]);
  });
});

describe('query ids', () => {
  it('are never reused, so an older citation keeps pointing at its own query', () => {
    expect(nextQid(ctx())).toBe('Q2');
    expect(nextQid({ entries: [] } as unknown as CampaignContext)).toBe('Q1');
  });
  it.runIf(existsSync(warehousePath('yesbank')))('run_sql_query files each query under its own id, even with the same purpose', () => {
    const env: ToolEnv = { tenant: YES, availableChannels: ['SMS'], goalStatement: '', sessionId: 's', lookupCache: new Map(), warehouseBank: 'yesbank' };
    const a = runToolCall('run_sql_query', { sql: 'SELECT COUNT(*) AS n FROM customers', purpose: 'Count' }, initialState(), env);
    const b = runToolCall('run_sql_query', { sql: 'SELECT COUNT(*) AS n FROM customers WHERE is_active = 1', purpose: 'Count' }, a.state, env);
    const ids = b.state.context.entries.filter((e) => e.kind === 'research').map((e) => (e.data as { qid: string }).qid);
    expect(ids).toEqual(['Q1', 'Q2']);
    expect(JSON.parse(b.forModel).cite).toBe('[Q2]');
  });
});

describe('splits: the main agent tests and splits itself', () => {
  it('the prompt says to test a split idea with its own cited queries; no helper, no split ideas in the schema', async () => {
    const { systemPrompt } = await import('../../server/agent/prompt');
    const { STEP_DEF } = await import('../../server/agent/journeySchema');
    const p = systemPrompt(true, true);
    expect(p).toMatch(/TEST IT FIRST with your own queries/);
    expect(p).not.toMatch(/a helper tests the idea/);
    expect(JSON.stringify(STEP_DEF)).not.toMatch(/splitIdea/);
  });
});
