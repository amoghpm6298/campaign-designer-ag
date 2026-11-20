// ask_data: the analyst loop, with a scripted stand-in for the model.
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { investigate, runAskData, workbookFor } from '../../server/agent/askData';
import { initialState } from '../../server/agent/state';
import { resolveTenant } from '../../server/tenants';
import { warehousePath } from '../../server/warehouse';
import { runToolCall, toolsFor, type ToolEnv } from '../../server/agent/tools';

const hasYes = existsSync(warehousePath('yesbank'));
const env = (bank?: string): ToolEnv => ({ tenant: resolveTenant('TEN-YES')!, availableChannels: ['SMS'], goalStatement: 'x', sessionId: 's1', lookupCache: new Map(), ...(bank ? { warehouseBank: bank } : {}) });
/** A stand-in model that replies with the given JSON strings in turn, and records what it was told. */
const scripted = (replies: string[]) => {
  const seen: string[] = [];
  let i = 0;
  const call = async (_s: string, msgs: { content: string }[]) => {
    seen.push(msgs[msgs.length - 1].content);
    return replies[Math.min(i++, replies.length - 1)];
  };
  return { call, seen };
};

beforeEach(() => {
  process.env.CAMPAIGN_DIR = mkdtempSync(join(tmpdir(), 'cd-ask-'));
});

describe('ask_data', () => {
  it('is offered only with data access', () => {
    expect(toolsFor(true).map((t) => t.name)).toContain('ask_data');
    expect(toolsFor(false).map((t) => t.name)).not.toContain('ask_data');
  });

  it('refuses without a question or without data', async () => {
    expect((await runAskData({}, initialState(), env('yesbank'))).ok).toBe(false);
    expect((await runAskData({ question: 'x' }, initialState(), env())).forModel).toMatch(/no data access/);
  });

  it.runIf(hasYes)('runs the queries itself, records them, and returns a plain answer', async () => {
    const s = scripted([
      JSON.stringify({ action: 'query', purpose: 'Active customers', sql: 'SELECT COUNT(*) AS n FROM customers WHERE is_active = 1' }),
      JSON.stringify({ action: 'query', purpose: 'Bad table', sql: 'SELECT * FROM nope' }),
      JSON.stringify({ action: 'answer', answer: 'Yes: 45,966 of 50,000 customers are active. The data has no UPI history.' }),
    ]);
    const a = await investigate('Most customers are active', initialState(), env('yesbank'), s.call);
    expect(a.answer).toMatch(/^Yes: 45,966/);
    expect(a.queries).toHaveLength(2);
    expect(a.queries[0].rows?.[0]).toHaveProperty('n');
    expect(a.queries[1].error).toBeTruthy();
    // The analyst was briefed with the data's tables and the bank's signals.
    expect(s.seen[0]).toMatch(/# The data/);
    expect(s.seen[0]).toMatch(/spend_90d/);
    // and saw the failed query's error, so it can fix it.
    expect(s.seen[2]).toMatch(/Query failed/);
  });

  it.runIf(hasYes)('files the answer and its queries in the notebook as research', async () => {
    const s = scripted([
      JSON.stringify({ action: 'query', purpose: 'Count', sql: 'SELECT COUNT(*) AS n FROM customers' }),
      JSON.stringify({ action: 'answer', answer: 'There are 50,000 customers.' }),
    ]);
    const out = await runAskData({ question: 'How many customers are there?' }, initialState(), env('yesbank'), s.call);
    expect(out.ok).toBe(true);
    const note = out.state.context.entries.find((e) => e.kind === 'research')!;
    expect(note.topic).toMatch(/^ask: Q1 How many customers/);
    expect((note.data as { queries: { sql: string }[] }).queries[0].sql).toMatch(/COUNT/);
    // The main agent gets the answer AND the workbook: each query's purpose, SQL and the rows it returned.
    const reply = JSON.parse(out.forModel);
    expect(reply.answer).toBe('There are 50,000 customers.');
    expect(reply.workbook).toEqual([{ purpose: 'Count', sql: 'SELECT COUNT(*) AS n FROM customers', columns: ['n'], rows: [{ n: 50000 }] }]);
    expect(reply.filedAs).toBe('Q1');
    expect(reply.cite).toBe('[Q1]');
    const fetched = runToolCall('get_context', { kind: 'research', topic: note.topic }, out.state, env('yesbank'));
    expect(fetched.forModel).toMatch(/SELECT COUNT\(\*\) AS n FROM customers/);
    expect(fetched.forModel).toMatch(/"n":50000/);
  });

  it.runIf(hasYes)('stops at the hidden query limit and is told to answer', async () => {
    const q = JSON.stringify({ action: 'query', purpose: 'again', sql: 'SELECT 1 AS x' });
    const s = scripted([...Array(8).fill(q), JSON.stringify({ action: 'answer', answer: 'Stopped early.' })]);
    const a = await investigate('loop', initialState(), env('yesbank'), s.call);
    expect(a.queries).toHaveLength(8);
    expect(s.seen.some((m) => /Limit reached/.test(m))).toBe(true);
  });

  it('the workbook caps rows per query, and halves them until it fits', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ k: `row ${i}`, pad: 'x'.repeat(200) }));
    const wb = workbookFor([{ purpose: 'big', sql: 'SELECT …', columns: ['k', 'pad'], rows }]);
    expect(wb[0].rows!.length).toBeLessThanOrEqual(20);
    expect(wb[0].moreRows).toBe(true);
    expect(JSON.stringify(wb).length).toBeLessThanOrEqual(16_000);
    expect(workbookFor([{ purpose: 'oops', sql: 'SELECT x', error: 'no such column' }])[0]).toEqual({ purpose: 'oops', sql: 'SELECT x', error: 'no such column' });
  });

  it.runIf(hasYes)('sizes a bucket when asked: counted by code, filed as its sizing', async () => {
    const st = initialState();
    st.campaign.buckets = [{ id: 'old', name: 'Old cards', priority: 1, rule: [], journey: [] }] as never;
    const sql = "SELECT customer_id FROM customers WHERE is_active = 1 AND account_open_date < '2020-01-01'";
    const s = scripted([JSON.stringify({ action: 'query', purpose: 'Try it', sql: `SELECT COUNT(*) AS n FROM (${sql})` }), JSON.stringify({ action: 'answer', answer: 'Sized.', sizingSql: sql })]);
    const out = await runAskData({ question: 'How many have had the card since before 2020?', sizeBucket: 'old' }, st, env('yesbank'), s.call);
    const reply = JSON.parse(out.forModel);
    expect(reply.sized.customers).toBeGreaterThan(0);
    const sizing = out.state.context.entries.find((e) => e.kind === 'sizing' && e.bucketId === 'old')!;
    expect(sizing.data).toMatchObject({ sql, size: reply.sized.customers });
    expect((await runAskData({ question: 'x', sizeBucket: 'nope' }, st, env('yesbank'), s.call)).forModel).toMatch(/no bucket "nope"/);
  });
});
