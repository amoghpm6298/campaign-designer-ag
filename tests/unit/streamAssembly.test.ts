// Phase 5.1: the stream is reassembled correctly, and an empty answer is
// reported as an empty answer.
//
// THE DEFECTS these lock down, both found by live runs and both invisible to
// every test that existed:
//
//  1. Thinking blocks were STRIPPED from the assistant turn before it went
//     back through the tool loop, so the conversation lost content the model
//     had produced and a later round came back empty.
//  2. The caller rebuilt the turn's text by concatenating streamed deltas.
//     A text block that arrives COMPLETE on content_block_start emits no
//     delta, so its text sat in `content` and was invisible — a real answer
//     reported as "the model returned no text at all".
//
// The API is faked here, deliberately: protocol handling must be provable
// without spending a live call, and a live call could not reproduce either
// case on demand anyway.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { streamClaude, extractJson } from '../../server/anthropic';

/** Builds an SSE body from a list of events, exactly as the API frames them. */
function sse(events: Record<string, unknown>[]): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/** Replaces fetch with one that replays a scripted stream. */
function mockStream(events: Record<string, unknown>[]) {
  const body = sse(events);
  vi.stubGlobal('fetch', async () =>
    new Response(new TextEncoder().encode(body), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
}

const start = (index: number, block: Record<string, unknown>) => ({ type: 'content_block_start', index, content_block: block });
const delta = (index: number, d: Record<string, unknown>) => ({ type: 'content_block_delta', index, delta: d });
const stop = (index: number) => ({ type: 'content_block_stop', index });
const finish = (reason: string) => ({ type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 10 } });

async function collect(events: Record<string, unknown>[]) {
  mockStream(events);
  const texts: string[] = [];
  const toolUses: { name: string }[] = [];
  let done: { content: unknown[]; text: string; stopReason?: string } | undefined;
  let diagnostics: { blockTypes: string[]; textChars: number; textFromDeltas: number } | undefined;
  for await (const chunk of streamClaude({ system: 's', messages: [{ role: 'user', content: 'u' }] })) {
    if (chunk.text) texts.push(chunk.text);
    if (chunk.toolUse) toolUses.push(chunk.toolUse);
    if (chunk.diagnostics) diagnostics = chunk.diagnostics;
    if (chunk.done) done = chunk.done;
  }
  return { texts, toolUses, done: done!, diagnostics: diagnostics! };
}

const OLD_KEY = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.ANTHROPIC_API_KEY = OLD_KEY ?? 'test-key-not-real';
});

describe('text survives however the API chooses to send it', () => {
  it('assembles text that arrives as deltas', async () => {
    const { texts, done, diagnostics } = await collect([
      start(0, { type: 'text', text: '' }),
      delta(0, { type: 'text_delta', text: '{"action":' }),
      delta(0, { type: 'text_delta', text: '"propose"}' }),
      stop(0),
      finish('end_turn'),
    ]);
    expect(texts.join('')).toBe('{"action":"propose"}');
    expect(done.text).toBe('{"action":"propose"}');
    expect(diagnostics.textFromDeltas).toBe(20);
  });

  it('assembles text that arrives COMPLETE, with no delta at all', async () => {
    // The second defect, isolated. Before the fix `done.text` was built from
    // deltas, so this turn looked empty and the user was told the model said
    // nothing — while its answer sat in the content block.
    const { texts, done, diagnostics } = await collect([
      start(0, { type: 'text', text: '{"action":"propose"}' }),
      stop(0),
      finish('end_turn'),
    ]);
    expect(done.text).toBe('{"action":"propose"}');
    expect(diagnostics.textChars).toBe(20);
    expect(diagnostics.textFromDeltas).toBe(0);
    // ...and it still reaches the caller for live rendering.
    expect(texts.join('')).toBe('{"action":"propose"}');
  });

  it('assembles text split across several blocks', async () => {
    const { done } = await collect([
      start(0, { type: 'text', text: 'a' }),
      stop(0),
      start(1, { type: 'text', text: '' }),
      delta(1, { type: 'text_delta', text: 'b' }),
      stop(1),
      finish('end_turn'),
    ]);
    expect(done.text).toBe('ab');
  });
});

describe('thinking blocks follow the API contract', () => {
  it('reassembles a thinking block completely, with its signature', async () => {
    // The ORIGINAL 400 — "each thinking block must contain thinking" — was
    // caused by dropping these deltas, leaving {type:'thinking',thinking:''}.
    const { done } = await collect([
      start(0, { type: 'thinking', thinking: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'private reasoning' }),
      delta(0, { type: 'signature_delta', signature: 'sig-abc' }),
      stop(0),
      start(1, { type: 'text', text: '{"ok":true}' }),
      stop(1),
      finish('end_turn'),
    ]);
    const thinking = done.content.find((b) => (b as { type: string }).type === 'thinking') as Record<string, unknown>;
    expect(thinking.thinking).toBe('private reasoning');
    expect(thinking.signature).toBe('sig-abc');
  });

  it('round-trips the thinking block instead of dropping it', async () => {
    // Dropping it is what malformed the conversation across tool rounds.
    const { done } = await collect([
      start(0, { type: 'thinking', thinking: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'reasoning' }),
      stop(0),
      start(1, { type: 'tool_use', id: 't1', name: 'list_channels', input: {} }),
      delta(1, { type: 'input_json_delta', partial_json: '{}' }),
      stop(1),
      finish('tool_use'),
    ]);
    expect((done.content as { type: string }[]).map((b) => b.type)).toEqual(['thinking', 'tool_use']);
  });

  it('never yields thinking to the caller, and never counts it as text', async () => {
    const { texts, done, diagnostics } = await collect([
      start(0, { type: 'thinking', thinking: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'SECRET REASONING' }),
      stop(0),
      finish('end_turn'),
    ]);
    expect(texts).toEqual([]);
    expect(done.text).toBe('');
    expect(diagnostics.textChars).toBe(0);
    // The diagnostics record the TYPE and nothing else.
    expect(diagnostics.blockTypes).toEqual(['thinking']);
    expect(JSON.stringify(diagnostics)).not.toContain('SECRET');
  });
});

describe('tool rounds', () => {
  it('reports a tool-only turn without mistaking it for an empty answer', async () => {
    // A turn that asks for a tool is a VALID intermediate response. The
    // orchestrator continues the loop on it; only a turn with neither text
    // nor tools is a dead end.
    const { toolUses, done } = await collect([
      start(0, { type: 'tool_use', id: 't1', name: 'list_event_types', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: '{}' }),
      stop(0),
      finish('tool_use'),
    ]);
    expect(toolUses).toHaveLength(1);
    expect(done.stopReason).toBe('tool_use');
    expect(done.text).toBe('');
  });

  it('parses a tool input that arrives in several fragments', async () => {
    const { toolUses } = await collect([
      start(0, { type: 'tool_use', id: 't1', name: 'list_audience_attributes', input: {} }),
      delta(0, { type: 'input_json_delta', partial_json: '{"ent' }),
      delta(0, { type: 'input_json_delta', partial_json: 'ity":"Account"}' }),
      stop(0),
      finish('tool_use'),
    ]);
    expect(toolUses[0]).toMatchObject({ name: 'list_audience_attributes', input: { entity: 'Account' } });
  });

  it('delivers the final text that follows the tool rounds', async () => {
    const { done } = await collect([
      start(0, { type: 'thinking', thinking: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'r' }),
      stop(0),
      start(1, { type: 'text', text: '' }),
      delta(1, { type: 'text_delta', text: '{"action":"propose"}' }),
      stop(1),
      finish('end_turn'),
    ]);
    expect(done.text).toBe('{"action":"propose"}');
    expect(extractJson(done.text, done.stopReason).ok).toBe(true);
  });
});

describe('a failed turn is never reported as a successful one', () => {
  it('names an empty response as empty, not as malformed JSON', async () => {
    const { done } = await collect([finish('end_turn')]);
    const parsed = extractJson(done.text, done.stopReason);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error).toMatch(/no text at all/i);
      expect(parsed.error).toMatch(/end_turn/);
      expect(parsed.error).not.toMatch(/parseable/i);
    }
  });

  it('names a truncation as a truncation', async () => {
    const parsed = extractJson('{"action":"prop', 'max_tokens');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/ran out of output tokens/i);
  });

  it('names genuinely malformed text as malformed', async () => {
    const parsed = extractJson('here is my plan, no JSON at all', 'end_turn');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/did not return parseable JSON/i);
  });

  it('a thinking-only turn fails loudly rather than passing as an answer', async () => {
    const { done } = await collect([
      start(0, { type: 'thinking', thinking: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'reasoned but said nothing' }),
      stop(0),
      finish('end_turn'),
    ]);
    const parsed = extractJson(done.text, done.stopReason);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.raw).toBe('');
  });

  it('a malformed SSE frame does not kill the run', async () => {
    mockStream([start(0, { type: 'text', text: 'ok' }), stop(0), finish('end_turn')]);
    // Inject a frame that is not JSON at all, ahead of the valid ones.
    const good = sse([start(0, { type: 'text', text: 'ok' }), stop(0), finish('end_turn')]);
    vi.stubGlobal('fetch', async () =>
      new Response(new TextEncoder().encode(`event: junk\ndata: {not json\n\n${good}`), { status: 200 }),
    );
    let done: { text: string } | undefined;
    for await (const chunk of streamClaude({ system: 's', messages: [{ role: 'user', content: 'u' }] })) {
      if (chunk.done) done = chunk.done;
    }
    expect(done?.text).toBe('ok');
  });
});
