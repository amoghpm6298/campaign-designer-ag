// A compiler throw must not end the conversation.
//
// THE LIVE FAILURE. A manager sent "Confirmed. Build this campaign." and got
// "Cannot read properties of undefined (reading 'replace')" — a raw
// TypeError in the transcript, no canvas, and nothing to do next. The cause
// was one field: `build_campaign` requires neither `name` nor `describe`, the
// model omitted both, and on a real tenant every send falls through to
// `proposeMessaging`, which dereferenced `describe`.
//
// That hole is fixed in `blueprint.ts` and `templateSelect.ts`, and covered
// by `missingTemplate.test.ts`. THIS file is the structural half, and it
// deliberately does not test a particular hole.
//
// The build is the one place where an unbounded amount of model-authored
// data meets application code, and the tool schema cannot require every
// field the compiler reads. So there will be another one. What is asserted
// here is what happens when it is hit: one sentence, the provider's own text
// kept beside it, and a conversation the manager can carry on.
//
// The compiler is mocked rather than fed a known-bad payload on purpose. A
// payload that throws today gets fixed tomorrow and takes the test with it —
// this way the guard is tested, not the hole.
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('../../server/blueprint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/blueprint')>()),
  buildFromBlueprint: () => {
    throw new TypeError("Cannot read properties of undefined (reading 'replace')");
  },
}));

const { orchestrateStream } = await import('../../server/orchestrator');
const { seedKnowledgeBase } = await import('../../server/knowledge');
const { newBrief, recordDimensions, recordSuccessCriteria } = await import('../../server/discovery');
const { discovered } = await import('./support/findings');

const sse = (events: Record<string, unknown>[]) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

const settled = () => {
  let b = discovered(newBrief('Get new cardholders activated.'));
  b = recordDimensions(b, [
    { name: 'Days since the card was issued', rationale: 'Early silence may differ from late.', status: 'retained', basis: 'user' },
  ]);
  return recordSuccessCriteria(b, ['More new cardholders setting a PIN within two weeks.']);
};

const OLD = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.ANTHROPIC_API_KEY = OLD ?? 'test-key-not-real';
});

async function confirm() {
  const bodies = [
    sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'b1', name: 'build_campaign', input: {} } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify({
            campaignName: 'Activate new cardholders',
            description: 'Fourteen days.',
            goal: null,
            entry: { kind: 'audience', entity: 'Card', conditions: [] },
            steps: [
              {
                kind: 'send',
                name: 'Opening',
                objective: ['activate'],
                stage: 'first-touch',
                describe: 'Show them how to set the PIN.',
                copy: 'Set your PIN in two minutes.',
                channelPreference: ['WHATSAPP'],
                barrier: 'cost-perception',
              },
              { kind: 'exit', reason: 'Window closed.' },
            ],
          }),
        },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 80 } },
    ]),
    sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Built.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } },
    ]),
  ];
  let i = 0;
  vi.stubGlobal('fetch', async () => {
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return new Response(new TextEncoder().encode(body), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  const gen = orchestrateStream({
    sessionId: 'build-throw',
    tenantId: 'TEN-IBL',
    knowledge: seedKnowledgeBase(),
    discoveryRounds: 3,
    brief: settled(),
    intent: 'confirm',
    confirmedBlueprint: null,
    session: { state: 'AWAITING_STRATEGY_CONFIRMATION', strategyVersion: 1, confirmation: null },
    messages: [
      { role: 'user', content: 'Get new cardholders activated.' },
      { role: 'assistant', content: 'Here is the plan.' },
      { role: 'user', content: 'Confirmed. Build this campaign.' },
    ],
  } as never);
  let out = await gen.next();
  while (!out.done) out = await gen.next();
  return out.value as unknown as Record<string, unknown>;
}

describe('when the compiler throws', () => {
  it('does not put a raw TypeError in the transcript', async () => {
    const res = await confirm();
    expect(String(res.reply)).not.toMatch(/Cannot read properties|TypeError/);
    expect(String(res.reply)).toMatch(/could not be built/);
  });

  it('keeps the provider\'s own text, rather than swallowing it', async () => {
    // The standing rule: the raw error is kept everywhere, beside the
    // sentence rather than instead of it.
    const res = await confirm();
    expect(String(res.errorDetail)).toMatch(/Cannot read properties of undefined/);
  });

  it('leaves the conversation where it was, so the manager can carry on', async () => {
    const res = await confirm();
    expect(res.brief).toBeTruthy();
    expect(res.session).toBeTruthy();
  });

  it('does not claim a journey it does not have', async () => {
    const res = await confirm();
    expect(res.graph).toBeNull();
    expect(res.campaign).toBeNull();
    expect(res.designGenerated).toBe(false);
    expect(res.exportable).toBe(false);
  });
});
