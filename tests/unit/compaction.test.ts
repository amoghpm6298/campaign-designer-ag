// In-turn compaction (server/agent/compaction.ts), after the propensity agent's design.
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import {
  compactIfNeeded,
  compactionCutoff,
  contextWindow,
  estimateTokens,
  isTooLong,
  KEEP_ROUNDS,
  maskOldResults,
  summariseOldSteps,
  tailStart,
  type ApiMessage,
} from '../../server/agent/compaction';
import { AnthropicCallError } from '../../server/anthropic';
import { runToolCall, type ToolEnv } from '../../server/agent/tools';
import { initialState } from '../../server/agent/state';
import { resolveTenant } from '../../server/tenants';
import { warehousePath } from '../../server/warehouse';

/** A turn: the opening user message, then N rounds of one SQL call each, returning 30 rows. */
function turn(rounds: number): ApiMessage[] {
  const msgs: ApiMessage[] = [{ role: 'user', content: 'Design the campaign.' }];
  for (let r = 0; r < rounds; r++) {
    msgs.push({ role: 'assistant', content: [{ type: 'text', text: `Round ${r}` }, { type: 'tool_use', id: `t${r}`, name: 'run_sql_query', input: { sql: 'SELECT …', purpose: `p${r}` } }] });
    const rows = Array.from({ length: 30 }, (_, i) => ({ bucket: `b${i}`, n: 1000 + i, pad: 'x'.repeat(60) }));
    msgs.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${r}`, content: JSON.stringify({ columns: ['bucket', 'n', 'pad'], rows, truncated: false }) }] });
  }
  return msgs;
}

/** Every tool_result has its tool_use in the message just before it. */
function pairsIntact(msgs: ApiMessage[]): boolean {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const b of m.content as Record<string, unknown>[]) {
      if (b.type !== 'tool_result') continue;
      const prev = msgs[i - 1];
      if (!prev || prev.role !== 'assistant' || !(prev.content as Record<string, unknown>[]).some((x) => x.type === 'tool_use' && x.id === b.tool_use_id)) return false;
    }
  }
  return true;
}
const rowsOf = (m: ApiMessage) => JSON.parse(String((m.content as Record<string, unknown>[])[0].content)).rows.length;

describe('trigger and window', () => {
  it('cuts off at 75% of the model window unless set', () => {
    expect(contextWindow('claude-sonnet-5')).toBe(1_000_000);
    expect(compactionCutoff('claude-sonnet-5', {})).toBe(750_000);
    expect(compactionCutoff('claude-sonnet-5', { COMPACT_CUTOFF_TOKENS: '40000' })).toBe(40_000);
    expect(compactionCutoff('some-older-model', {})).toBe(150_000);
  });
  it('recognises the API refusing a prompt as too long, and nothing else', () => {
    expect(isTooLong(new AnthropicCallError('Anthropic API error 400: {"error":{"message":"prompt is too long: 1012345 tokens > 1000000 maximum"}}', 400))).toBe(true);
    expect(isTooLong(new AnthropicCallError('Anthropic API error 400: tools.0: bad schema', 400))).toBe(false);
    expect(isTooLong(new AnthropicCallError('Anthropic API error 529: overloaded', 529))).toBe(false);
  });
  it('under the cutoff nothing changes (same array back)', async () => {
    const msgs = turn(8);
    const r = await compactIfNeeded(msgs, { baseLen: 1, cutoff: 1e9, summarise: async () => 'x' });
    expect(r.tier).toBe(0);
    expect(r.messages).toBe(msgs);
  });
});

describe('tier 1: shorten old results', () => {
  it(`keeps the opening message and the last ${KEEP_ROUNDS} rounds verbatim; never splits a tool call from its result`, () => {
    const msgs = turn(9);
    expect(tailStart(msgs, 1, KEEP_ROUNDS)).toBe(1 + 2 * (9 - KEEP_ROUNDS));
    expect(tailStart(turn(KEEP_ROUNDS), 1, KEEP_ROUNDS)).toBeNull();
    const { messages, masked } = maskOldResults(msgs, 1, 1, false);
    expect(masked).toBe(9 - KEEP_ROUNDS);
    expect(messages[0]).toEqual(msgs[0]);
    expect(pairsIntact(messages)).toBe(true);
    // Old results keep one row and say where the rest are; the kept tail is untouched.
    expect(rowsOf(messages[2])).toBe(1);
    const old = JSON.parse(String((messages[2].content as Record<string, unknown>[])[0].content));
    expect(old._rows_omitted).toBe(29);
    expect(old._rows_note).toMatch(/filed in the notebook/);
    expect(rowsOf(messages[messages.length - 1])).toBe(30);
    // The input array is not mutated.
    expect(rowsOf(msgs[2])).toBe(30);
  });
  it('stops as soon as it is under the cutoff, oldest first', () => {
    const msgs = turn(9);
    const full = estimateTokens(msgs);
    const { messages, masked } = maskOldResults(msgs, 1, full - 10, false);
    expect(masked).toBe(1);
    expect(rowsOf(messages[2])).toBe(1);
    expect(rowsOf(messages[4])).toBe(30);
  });
  it('a large result without rows is cut to its start, with a pointer', () => {
    const msgs = turn(7);
    (msgs[2].content as Record<string, unknown>[])[0] = { type: 'tool_result', tool_use_id: 't0', content: 'y'.repeat(10_000) };
    const { messages } = maskOldResults(msgs, 1, 1, false);
    expect(String((messages[2].content as Record<string, unknown>[])[0].content)).toMatch(/^y{600}… \[older result shortened/);
  });
});

describe('tier 2: summarise older steps', () => {
  it('replaces the older part with one recap and keeps the tail from an assistant message', async () => {
    let seen = '';
    const msgs = turn(9);
    const r = await summariseOldSteps(msgs, 1, async (_s, text) => ((seen = text), 'Found 167 not activated (query: p3).'));
    expect(r.summarised).toBe(true);
    expect(r.messages).toHaveLength(1 + 1 + 2 * KEEP_ROUNDS);
    expect(String(r.messages[1].content)).toMatch(/^\[Summary of earlier steps in this turn\]\nFound 167/);
    expect(r.messages[2].role).toBe('assistant');
    expect(pairsIntact(r.messages)).toBe(true);
    // The recap's input carries the calls and (capped) results.
    expect(seen).toMatch(/TOOL CALL run_sql_query/);
    expect(seen).toMatch(/_rows_omitted/);
  });
  it('fails closed: an error or an empty recap changes nothing; forced, a placeholder stands in', async () => {
    const msgs = turn(9);
    expect((await summariseOldSteps(msgs, 1, async () => { throw new Error('down'); })).messages).toBe(msgs);
    expect((await summariseOldSteps(msgs, 1, async () => '  ')).summarised).toBe(false);
    const forced = await summariseOldSteps(msgs, 1, async () => '', true);
    expect(String(forced.messages[1].content)).toMatch(/were omitted.*get_campaign.*get_context/);
  });
  it('compactIfNeeded runs tier 2 only when tier 1 is not enough', async () => {
    const msgs = turn(9);
    const t1 = await compactIfNeeded(msgs, { baseLen: 1, cutoff: estimateTokens(msgs) - 10, summarise: async () => 'recap' });
    expect(t1.tier).toBe(1);
    const t2 = await compactIfNeeded(msgs, { baseLen: 1, cutoff: 10, summarise: async () => 'recap' });
    expect(t2.tier).toBe(2);
    expect(t2.after).toBeLessThan(t2.before);
  });
});

describe('the agent files its own queries', () => {
  it.runIf(existsSync(warehousePath('yesbank')))('run_sql_query files purpose, SQL and rows in the notebook', () => {
    process.env.CAMPAIGN_DIR = process.env.CAMPAIGN_DIR ?? '/tmp/cd-compaction-test';
    const env: ToolEnv = { tenant: resolveTenant('TEN-YES')!, availableChannels: ['SMS'], goalStatement: '', sessionId: 's', lookupCache: new Map(), warehouseBank: 'yesbank' };
    const out = runToolCall('run_sql_query', { sql: 'SELECT category, COUNT(*) AS n FROM transactions GROUP BY category ORDER BY n DESC', purpose: 'Spend categories' }, initialState(), env);
    expect(out.ok).toBe(true);
    const note = out.state.context.entries.find((e) => e.topic === 'query: Q1 Spend categories')!;
    expect((note.data as { qid: string }).qid).toBe('Q1');
    expect(JSON.parse(out.forModel).cite).toBe('[Q1]');
    expect(note.kind).toBe('research');
    expect((note.data as { sql: string; rows: unknown[] }).sql).toMatch(/GROUP BY category/);
    expect((note.data as { rows: unknown[] }).rows.length).toBeGreaterThan(3);
  });
});
