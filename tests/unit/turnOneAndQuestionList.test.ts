// Two defects from one live run, 2026-10-21. Both are about what the manager
// sees on screen rather than about what the agent knows.
//
// THE RUN, three turns, verbatim where quoted.
//
//   Turn 1, the agent: "I checked the channels and template availability."
//     Then three numbered questions. The manager had said what they wanted
//     and the first thing back was an inventory of the plumbing.
//
//   Turn 2, the manager: "1. Activation means setting the PIN 2. We measure
//     how many new cardholders activate"
//     The agent: "Confirmed so far: activation means setting the PIN, and
//     success is read as more cardholders activating."
//     Underneath, the client listed those same two questions again.
//
//   Turn 3: five numbered questions on screen, two of them ones the agent had
//     just said in writing were settled.
//
// DEFECT 1 is the question list: the discovery return sent `outstanding(brief)`
// — every question still open across the whole conversation — so the list only
// ever grew, and anything the record had not closed reappeared under the
// sentence saying it was closed. The brief rightly keeps the history; the
// client should show this turn's ask.
//
// DEFECT 2 is the opening move: `list_channels` and `check_template_availability`
// were the only two tools available before a plan is approved, so a model
// inclined to look something up first had exactly one thing it could look up.
// Turn one could not have been anything else.
//
// The two fixes are independent and both are structural — one changes what a
// return carries, the other what the first turn can reach. Neither is prompt
// wording, which is this project's standing lesson about what moves behaviour.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { orchestrateStream, MAX_QUESTIONS_PER_ROUND } from '../../server/orchestrator';
import { seedKnowledgeBase } from '../../server/knowledge';
import { toolsForPhase } from '../../server/agentTools';
import { newBrief, recordQuestions, type WorkingBrief } from '../../server/discovery';

const OBJECTIVE = 'I want more new cardholders to activate their cards.';

const sse = (events: Record<string, unknown>[]) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

/**
 * One round that writes to the record through a tool.
 *
 * THE SHAPE MATTERS. A tool call ends a round, not the turn: the result goes
 * back and the model speaks afterwards. So every case here is two rounds — a
 * write, then the prose the manager reads — which is the shape the live run
 * had and the shape Fix A has to be correct under.
 */
const writeRound = (tool: string, input: unknown) =>
  sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu-${tool}`, name: tool, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 60 } },
  ]);

/** The round that closes the turn: ordinary prose, no JSON payload. */
const proseRound = (prose: string) =>
  sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: prose } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 90 } },
  ]);

const askViaTool = (questions: { text: string; impact?: string }[], prose: string) => [
  writeRound('ask_questions', { questions }),
  proseRound(prose),
];

function script(bodies: string[]) {
  const sent: string[] = [];
  let i = 0;
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    sent.push(init.body);
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

async function run(brief: WorkingBrief | undefined, messages: { role: 'user' | 'assistant'; content: string }[]) {
  const gen = orchestrateStream({
    sessionId: 'turn-one',
    tenantId: 'TEN-IBL',
    knowledge,
    discoveryRounds: brief ? brief.rounds : 0,
    ...(brief ? { brief } : {}),
    messages,
  } as never);
  let out = await gen.next();
  while (!out.done) out = await gen.next();
  return out.value as unknown as Record<string, unknown>;
}

const OLD = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.ANTHROPIC_API_KEY = OLD ?? 'test-key-not-real';
});

describe('the client is shown this turn\'s questions, not the outstanding history', () => {
  /** Turn 2's starting point: two questions asked in turn 1. */
  const afterTurnOne = (): WorkingBrief =>
    recordQuestions(newBrief(OBJECTIVE), [
      { text: 'What does activation mean to you?', impact: 'shaping' },
      { text: 'How will you judge success?', impact: 'shaping' },
    ]);

  const turnTwo = () =>
    run(afterTurnOne(), [
      { role: 'user', content: OBJECTIVE },
      { role: 'assistant', content: 'Two questions first.' },
      { role: 'user', content: '1. Activation means setting the PIN 2. We measure how many new cardholders activate' },
    ]);

  it('lists only the question raised this turn', async () => {
    script(askViaTool([{ text: 'Which cards count as new?', impact: 'shaping' }], 'Confirmed so far.'));
    const res = await turnTwo();
    expect(res.questions[0]).toBe('Which cards count as new?');
    expect(res.questions).toContain(
      'Who tends to do this already today — is there any pattern you have noticed, even a rough one? "We do not track that" is a complete answer.',
    );
  });

  it('does not re-list a turn-1 question, even one the record left open', async () => {
    // THE LIVE SYMPTOM. Whether the record closed the earlier two does not
    // matter here — this assertion holds either way, which is the point. The
    // list is derived from what was asked now, so a bookkeeping gap can no
    // longer put an answered question back on screen.
    script(askViaTool([{ text: 'Which cards count as new?', impact: 'shaping' }], 'Confirmed so far.'));
    const res = await turnTwo();
    const shown = res.questions as string[];
    expect(shown).not.toContain('What does activation mean to you?');
    expect(shown).not.toContain('How will you judge success?');
  });

  it('keeps the whole history on the brief, because the brief is the record', async () => {
    // The fix must be a narrowing of the VIEW and nothing else. If it had
    // dropped questions from the brief instead, the gate would stop being
    // able to tell what is outstanding.
    script(askViaTool([{ text: 'Which cards count as new?', impact: 'shaping' }], 'Confirmed so far.'));
    const res = await turnTwo();
    const brief = res.brief as WorkingBrief;
    expect(brief.questions.map((q) => q.text)).toEqual(
      expect.arrayContaining([
        'What does activation mean to you?',
        'How will you judge success?',
        'Which cards count as new?',
      ]),
    );
  });

  it('does not fall back to the backlog when the turn raised nothing', async () => {
    // The old behaviour at its worst: a turn whose only content was a summary
    // still printed a numbered list, because `outstanding` was never empty.
    // RETARGETED 2026-10-26. Empty questions on an OPEN record are now
    // unrepresentable: if the model files a diary and asks nothing, the
    // application prints what the record still needs. What must not come
    // back is the TURN-1 backlog — those were answered in the user message.
    script([
      writeRound('record_dimensions', {
        dimensions: [{ name: 'Days since the card was issued', rationale: 'Early silence may differ from late.', status: 'open', basis: 'none' }],
      }),
      proseRound('Confirmed so far: activation means setting the PIN.'),
    ]);
    const before = afterTurnOne().questions.length;
    const res = await turnTwo();
    const shown = res.questions as string[];
    expect(shown).not.toContain('What does activation mean to you?');
    expect(shown).not.toContain('How will you judge success?');
    expect(shown.join(' ')).toMatch(/judge whether this worked|who does this today|stopping them/);
    const brief = res.brief as WorkingBrief;
    expect(brief.questions.length).toBeGreaterThanOrEqual(before);
  });

  it('caps the list at the same number the model is allowed to raise', async () => {
    // The cap used to be the only thing bounding a list that never shrank, so
    // four accumulated questions showed as four. It now bounds a single turn's
    // ask, where it agrees with the instruction the model is given.
    script(
      askViaTool(
        [
          { text: 'Which cards count as new?', impact: 'shaping' },
          { text: 'How soon after issue do you expect activation?', impact: 'shaping' },
          { text: 'Is there a cohort you care about most?', impact: 'shaping' },
        ],
        'Three more.',
      ),
    );
    const res = await turnTwo();
    expect((res.questions as string[]).length).toBeLessThanOrEqual(MAX_QUESTIONS_PER_ROUND);
  });
});

describe('turn one cannot be a channel inventory', () => {
  it('still gives discovery no lookup tools after the build turn was widened', () => {
    // RE-ASSERTED 2026-10-22. The orchestrator now sends
    // `toolsForPhase(designSeen || isBuildTurn)` so a Confirm can read the
    // catalogue. That expression must not leak into discovery, where both
    // operands are false — this is the invariant the widening had to preserve.
    const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    expect(orch).toMatch(/toolsForPhase\(phase !== 'asking' \|\| designSeen\)/);
    expect(orch).not.toMatch(/toolsForPhase\(true\)/);
    expect(toolsForPhase(false)).toEqual([]);
  });

  it('gives discovery no lookup tools at all', () => {
    // Deliberately exact rather than `not.toContain`. The set being EMPTY is
    // the claim: with any single tool available, a model that opens by looking
    // something up has one thing it can report, and the opening move is
    // decided by what we left switched on rather than by the conversation.
    expect(toolsForPhase(false).map((t) => t.name)).toEqual([]);
  });

  it('withholds specifically the two that produced the inventory', () => {
    const build = toolsForPhase(true).map((t) => t.name);
    for (const name of ['list_channels', 'check_template_availability']) {
      expect(build, `${name} must still exist after approval`).toContain(name);
      expect(toolsForPhase(false).map((t) => t.name), `${name} must not be reachable in discovery`).not.toContain(name);
    }
  });

  it('still tells the agent which channels exist, so nothing was lost', async () => {
    // The TOOL was withheld, not the fact — asserted on the request actually
    // sent, because that is the only place the agent reads from. If this ever
    // stops being true the agent would have to ask the manager which channels
    // their own bank has, which is worse than the inventory it replaced.
    const sent = script(askViaTool([{ text: 'What does activation mean to you?' }], 'One thing first.'));
    await run(undefined, [{ role: 'user', content: OBJECTIVE }]);
    const req = JSON.parse(sent[0]);
    // THE WHOLE REQUEST, which is what this test says it reads. The ternary
    // here used to fall back to the messages only when `system` was NOT a
    // string — and it always is — so the assertion was really "the channel
    // names are hardcoded in the method prompt". They belong in
    // `issuerContext`, which travels in the first user message: which
    // channels an issuer has is bank context, not method.
    const context = JSON.stringify(req.system) + JSON.stringify(req.messages);
    for (const channel of ['WHATSAPP', 'SMS', 'EMAIL', 'RCS']) {
      expect(context, `${channel} must be stated in the prompt`).toContain(channel);
    }
  });

  it('opens with questions rather than a lookup', async () => {
    const sent = script(askViaTool([{ text: 'What does activation mean to you?', impact: 'shaping' }], 'One thing first.'));
    const res = await run(undefined, [{ role: 'user', content: OBJECTIVE }]);
    // Two rounds and no more: the write, then the prose. Nothing was fetched
    // first, because there was nothing to fetch.
    expect(sent).toHaveLength(2);
    const tools: { name: string }[] = JSON.parse(sent[0]).tools ?? [];
    // Only output tools — the ones the model writes THROUGH, never reads from.
    expect(tools.map((t) => t.name)).not.toContain('list_channels');
    expect(tools.map((t) => t.name)).toContain('ask_questions');
    expect(res.questions[0]).toBe('What does activation mean to you?');
    expect(res.questions).toContain(
      'Who tends to do this already today — is there any pattern you have noticed, even a rough one? "We do not track that" is a complete answer.',
    );
  });
});
