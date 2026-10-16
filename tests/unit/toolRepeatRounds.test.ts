// A repeated lookup must not cost the user their answer.
//
// THE DEFECT, measured across five recorded runs with per-round event data.
// When every tool call in a round was a cache repeat, the orchestrator sent
// the next round with tool_choice 'none' and a "stop calling tools"
// instruction. That round came back with a thinking block, no text and
// stop_reason end_turn — an empty response the user saw as a failure.
//
//   df2 t1, df2 t2, osdiag t2   no all-repeat round   -> readable answer
//   att2, att3                  one all-repeat round  -> EMPTY response
//
// The empty rounds spent 14 and 25 thinking tokens against max_tokens 16,000,
// so neither a thinking budget nor truncation explains them. Both failures had
// exactly ONE all-repeat round.
//
// The fix relies on the tool result's own "already called this" message for a
// single repeat, and keeps withdrawal as a bounded fallback at two consecutive
// repeat rounds. These tests drive the real orchestrator with a scripted API,
// so the request actually sent is what is asserted.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { orchestrateStream } from '../../server/orchestrator';
import { seedKnowledgeBase } from '../../server/knowledge';

const OBJECTIVE = 'I want to increase OS-to-EMI conversions. Design a drip campaign for this.';

const sse = (events: Record<string, unknown>[]) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

/** A turn that asks for one named tool. */
const toolTurn = (id: string, name: string) =>
  sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } },
  ]);

/** A turn that answers. Minimal but well-formed, so the gate can run. */
const answerTurn = () =>
  sse([
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'text',
        text: JSON.stringify({
          action: 'ask',
          rationale: 'A readable answer after the repeated lookup.',
          questions: ['How would you judge success for this campaign?'],
          dimensions: [{ name: 'Audience', rationale: 'Who enters.', status: 'open', basis: 'none' }],
        }),
      },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 90 } },
  ]);

/** Replays `bodies` in order, recording every request that was sent. */
function script(bodies: string[]) {
  const sent: { toolChoice: unknown; toolCount: number; systemHasStop: boolean; raw: string }[] = [];
  let i = 0;
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    const req = JSON.parse(init.body);
    sent.push({
      toolChoice: req.tool_choice ?? null,
      toolCount: (req.tools ?? []).length,
      systemHasStop: /STOP CALLING TOOLS/.test(
        typeof req.system === 'string' ? req.system : JSON.stringify(req.system ?? ''),
      ),
      raw: init.body,
    });
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return new Response(new TextEncoder().encode(body), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  return sent;
}

const knowledge = seedKnowledgeBase();

async function run() {
  const gen = orchestrateStream({
    sessionId: 'repeat',
    tenantId: 'TEN-IBL',
    knowledge,
    discoveryRounds: 0,
    messages: [{ role: 'user', content: OBJECTIVE }],
  } as never);
  let out = await gen.next();
  const toolCalls: string[] = [];
  while (!out.done) {
    const e = out.value as { type: string; title?: string };
    if (e.type === 'model.tool_call.completed') toolCalls.push(e.title ?? '');
    out = await gen.next();
  }
  return { res: out.value as Record<string, unknown>, toolCalls };
}

const OLD = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.ANTHROPIC_API_KEY = OLD ?? 'test-key-not-real';
});

describe('one round of repeated lookups still lets the model answer', () => {
  it('does not withdraw tool use after a single all-repeat round', async () => {
    // Round 1 fetches a tool. Round 2 asks for the SAME tool, so every call in
    // that round is a cache repeat. Round 3 is where the old code sent
    // tool_choice 'none' and got nothing back.
    const sent = script([
      toolTurn('t1', 'list_event_types'),
      toolTurn('t2', 'list_event_types'),
      answerTurn(),
    ]);
    const { res, toolCalls } = await run();

    expect(toolCalls).toHaveLength(2); // the repeat is still executed and reported
    expect(sent).toHaveLength(3);
    // THE REGRESSION: the round after the repeat must be a normal request.
    expect(sent[2].toolChoice).toBeNull();
    expect(sent[2].toolCount).toBeGreaterThan(0);
    expect(sent[2].systemHasStop).toBe(false);
    // ...and a readable answer comes back rather than an empty turn.
    expect(res.phase).not.toBe('error');
    expect(String(res.reply)).not.toMatch(/no text at all/i);
    expect(res.questions as string[]).toHaveLength(1);
  });

  it('answers an identical repeat with a pointer, not a second copy of the data', async () => {
    const sent = script([toolTurn('t1', 'list_event_types'), toolTurn('t2', 'list_event_types'), answerTurn()]);
    await run();
    const third = JSON.parse(sent[2].raw);
    const history = JSON.stringify(third.messages);
    // It is told where the answer already is, and which round it came from.
    expect(history).toMatch(/You already called list_event_types with these exact arguments in round 1/);
    expect(history).toMatch(/read it there/);
    expect(history).toMatch(/Calling it again cannot return anything different/);

    // THE POINT OF THE CHANGE: the payload is sent once, not twice. Re-sending
    // it made asking again cost the model nothing and read like a fresh
    // lookup, which is how two rounds a turn went on re-reading the same data.
    const payload: string = JSON.parse(sent[1].raw).messages.at(-1).content[0].content;
    const marker = payload.slice(Math.floor(payload.length / 2), Math.floor(payload.length / 2) + 40);
    expect(marker.length, 'payload too short to sample').toBe(40);
    // Count over the tool_result strings themselves, not the escaped JSON.
    const contents: string[] = [];
    for (const m of third.messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) if (b?.type === 'tool_result' && typeof b.content === 'string') contents.push(b.content);
    }
    expect(contents.filter((c) => c.includes(marker))).toHaveLength(1);
  });

  it('a stray repeat between useful rounds does not escalate', async () => {
    // fresh -> repeat -> fresh -> answer. The counter must reset on the fresh
    // round, so withdrawal never triggers.
    const sent = script([
      toolTurn('t1', 'list_event_types'),
      toolTurn('t2', 'list_event_types'),
      toolTurn('t3', 'list_channels'),
      answerTurn(),
    ]);
    const { res } = await run();
    expect(sent).toHaveLength(4);
    for (const r of sent) expect(r.toolChoice).toBeNull();
    expect(res.phase).not.toBe('error');
  });
});

describe('repeated lookups are still bounded', () => {
  it('withdraws tool use after TWO consecutive all-repeat rounds', async () => {
    // fresh, repeat, repeat -> the third request is where the bound bites.
    const sent = script([
      toolTurn('t1', 'list_event_types'),
      toolTurn('t2', 'list_event_types'),
      toolTurn('t3', 'list_event_types'),
      answerTurn(),
    ]);
    await run();
    expect(sent[1].toolChoice).toBeNull(); // after 1 repeat: normal
    expect(sent[2].toolChoice).toBeNull(); // still normal; the 2nd repeat happens here
    // After two consecutive all-repeat rounds the fallback engages.
    expect(sent[3].toolChoice).toEqual({ type: 'none' });
    expect(sent[3].systemHasStop).toBe(true);
    // Definitions still travel, which is what keeps the history coherent.
    expect(sent[3].toolCount).toBeGreaterThan(0);
  });

  it('cannot loop forever: a model that only ever repeats is stopped', async () => {
    // Every turn asks for the same tool and never answers.
    const sent = script([toolTurn('t1', 'list_event_types')]);
    const { res } = await run();
    // Bounded by MAX_TOOL_ROUNDS, not by the repeat counter alone.
    expect(sent.length).toBeLessThanOrEqual(8);
    expect(res.phase).toBe('error');
    expect(String(res.reply)).toMatch(/spent all of its lookups/i);
    // State survives, so the user can retry.
    expect(res.brief).not.toBeNull();
    expect(res.session).not.toBeNull();
  });

  it('a spent budget still withdraws tool use, unchanged', async () => {
    const sent = script([toolTurn('t1', 'list_event_types')]);
    await run();
    const last = sent[sent.length - 1];
    expect(last.toolChoice).toEqual({ type: 'none' });
    expect(last.systemHasStop).toBe(true);
  });
});
