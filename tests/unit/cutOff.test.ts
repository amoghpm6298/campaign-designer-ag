// A reply cut off at its length limit mid tool call (server/agent/loop.ts): the half-written calls never
// stay in the conversation (the API refuses tool calls without results), and the designer is asked to
// redo the work in smaller steps instead of the turn ending in an error.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const seen: unknown[][] = [];
vi.mock('../../server/anthropic', async () => {
  const actual = await vi.importActual<typeof import('../../server/anthropic')>('../../server/anthropic');
  let round = 0;
  return {
    ...actual,
    hasApiKey: () => true,
    resolveModel: () => 'claude-sonnet-5',
    async *streamClaude(opts: { messages: unknown[] }) {
      seen.push(JSON.parse(JSON.stringify(opts.messages)));
      round++;
      if (round === 1) {
        const call = { id: 'toolu_cut', name: 'edit_bucket', input: { id: 'b1' } };
        yield { toolUse: call };
        yield { done: { stopReason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 10 }, content: [{ type: 'text', text: 'Fixing all buckets…' }, { type: 'tool_use', ...call }], text: 'Fixing all buckets…' } };
      } else {
        yield { text: 'Done.' };
        yield { done: { stopReason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'Done.' }], text: 'Done.' } };
      }
    },
  };
});

beforeEach(() => {
  process.env.CAMPAIGN_DIR = mkdtempSync(join(tmpdir(), 'cd-cutoff-'));
});

describe('a reply cut off mid tool call', () => {
  it('is dropped from the conversation, and the designer is asked to redo it in smaller steps', async () => {
    const { agentStream } = await import('../../server/agent/loop');
    const gen = agentStream({ sessionId: 'cv-cutoff1', tenantId: 'TEN-DEMO', messages: [{ role: 'user', content: 'Hi' }] } as never);
    let r: IteratorResult<unknown, unknown>;
    do r = await gen.next();
    while (!r.done);
    const res = r.value as { error?: string; reply: string };
    expect(res.error).toBeUndefined();
    expect(seen).toHaveLength(2);
    const second = seen[1] as { role: string; content: unknown }[];
    // No tool_use is left without its result: the cut-off call was dropped.
    expect(JSON.stringify(second)).not.toMatch(/toolu_cut/);
    expect(JSON.stringify(second[second.length - 1])).toMatch(/cut off before your tool calls finished/);
    expect(res.reply).toMatch(/Done\./);
  });
});
