// The chat bubble is a colleague, not the lab notebook.
//
// All of this comes from one four-turn PIN-activation run, where the parts
// written BY the application read worse than the parts written by the model.
//
//   Turn 1: "I've sent these two questions to the campaign manager."
//     Written to the manager, about the manager, in the third person.
//
//   Turn 3: "I have put up two possible groups to go after and I am waiting
//     to hear which one you would back." Then, underneath:
//       What I am working through:
//       - Acquisition channel or offer type at sign-up — set aside: ...
//       - Credit limit assigned: Manager states higher assigned credit limit
//         correlates with faster activation; a real candidate segmentation
//         axis for dosage/intensity.
//     Three bullets that are not the two groups, in our vocabulary rather
//     than theirs, with "set aside" as a status and "Manager states" as the
//     voice.
//
//   The activity panel, meanwhile: "Agent thinking", "6 lookups" on a turn
//     that looked nothing up, and a Details panel that opened into raw JSON
//     with no sentence anywhere in it.
//
// The record is not the problem and is not hidden. It stays on the brief and
// in the `discovery.questions` event's `data`. What changed is that it is no
// longer pasted into the conversation.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { orchestrateStream } from '../../server/orchestrator';
import { seedKnowledgeBase } from '../../server/knowledge';
import { blocksFor, blockDelta, renderBlocks, decide } from '../../server/gate';
import { applyOutputTool } from '../../server/outputTools';
import { newBrief, recordAnswer, recordConverters, recordDimensions, recordQuestions, type WorkingBrief } from '../../server/discovery';
import { detailsText, friendlyEvent } from '../../src/designer/status';
import { asking } from './support/prompts.ts';
// PINS REMOVED, NOT LOST: 3 rule(s) this file asserted have no
// counterpart in any of the three manuals. Every one is listed in
// `server/promptHomeless.md` under this filename, with the tests that
// went with them. Do not re-add a pin here without putting the rule
// back in a manual first.

const SYSTEM = asking();

// --------------------------------------------------------- A1. the reply

/**
 * A brief with a full dimension ledger and a gate that will hold: the exact
 * shape that produced turn 3.
 */
const withLedger = (): WorkingBrief => {
  let b = recordQuestions(newBrief('I want more new cardholders to activate their cards.'), [
    { text: 'What does activation mean to you?', impact: 'shaping' },
  ]);
  b = recordAnswer(b, 'PIN set. We measure how many new cardholders activate.');
  b = recordConverters(b, {
    shape: 'No converter pattern the manager trusts yet.',
    basis: 'user',
    knowledge: 'none-yet',
    candidates: [
      { segment: 'Welcome-offer sign-ups', restsOn: 'the acquisition incentive at sign-up', why: 'A reward tied to first use is its own reason to act.' },
      { segment: 'Existing product holders', restsOn: 'an existing relationship with the bank', why: 'Familiarity removes first-time friction.' },
    ],
  });
  return recordDimensions(b, [
    { name: 'Acquisition channel or offer type at sign-up', rationale: 'Could identify a group that self-activates.', status: 'deferred', basis: 'assumption', note: 'Not available as an attribute.' },
    { name: 'Assigned credit limit', rationale: 'Higher limits may activate faster.', status: 'retained', basis: 'user' },
  ]);
};

const sse = (events: Record<string, unknown>[]) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

const proseTurn = (text: string) =>
  sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 90 } },
  ]);

/** A propose turn the gate will refuse, with prose in front of it. */
const proposeTurn = (prose: string) =>
  sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: `${prose}\n${JSON.stringify({ action: 'propose', strategy: { summary: 's', approach: [], assumptions: [], unknowns: [] } })}` } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 200 } },
  ]);

function script(bodies: string[]) {
  let i = 0;
  vi.stubGlobal('fetch', async () => {
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return new Response(new TextEncoder().encode(body), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
}

const knowledge = seedKnowledgeBase();

async function run(brief: WorkingBrief) {
  const gen = orchestrateStream({
    sessionId: 'voice',
    tenantId: 'TEN-IBL',
    knowledge,
    discoveryRounds: brief.rounds,
    brief,
    session: { state: 'AWAITING_USER_ANSWER', strategyVersion: 0, confirmedAt: null },
    messages: [
      { role: 'user', content: 'I want more new cardholders to activate their cards.' },
      { role: 'assistant', content: 'One question first.' },
      { role: 'user', content: 'PIN set. We measure how many new cardholders activate.' },
    ],
  } as never);
  let out = await gen.next();
  const events: { type: string; title?: string; detail?: string; data?: unknown }[] = [];
  while (!out.done) {
    events.push(out.value as never);
    out = await gen.next();
  }
  return { res: out.value as unknown as Record<string, unknown>, events };
}

const OLD = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.ANTHROPIC_API_KEY = OLD ?? 'test-key-not-real';
});

describe('a held proposal does not dump the ledger into the reply', () => {
  it('holds the proposal, so this fixture reproduces the turn', async () => {
    script([proposeTurn('A plan for activation.')]);
    const { res } = await run(withLedger());
    expect(res.phase).toBe('discovery');
    expect(res.strategy).toBeNull();
  });

  it('contains none of the ledger vocabulary', async () => {
    script([proposeTurn('A plan for activation.')]);
    const { res } = await run(withLedger());
    const reply = String(res.reply);
    for (const banned of ['What I am working through', 'set aside', '(retained)', 'Correct anything that is wrong here']) {
      expect(reply, banned).not.toContain(banned);
    }
  });

  it('keeps the model\'s own prose, and does not stop at it', async () => {
    // Prose first, then what is still needed. Never the prose alone: on a
    // held propose turn the prose usually announces the plan, and printing
    // that by itself says a plan is settled on the turn it was refused.
    script([proposeTurn('Here is what I would build for activation.')]);
    const { res } = await run(withLedger());
    const reply = String(res.reply);
    expect(reply).toContain('Here is what I would build for activation.');
    expect(reply.length).toBeGreaterThan('Here is what I would build for activation.'.length + 20);
  });

  it('keeps the ledger on the brief and in the activity data', async () => {
    script([proposeTurn('A plan.')]);
    const { res, events } = await run(withLedger());
    const brief = res.brief as WorkingBrief;
    expect(brief.dimensions?.map((d) => d.name)).toContain('Assigned credit limit');
    // The event carries the dimensions that are still OPEN, which is the
    // subset a reader of the activity panel can act on. The full ledger —
    // including the retained and deferred ones — stays on the brief above.
    const discovery = events.find((e) => e.type === 'discovery.questions');
    expect(discovery, 'the held turn must still report its reasoning somewhere').toBeTruthy();
    expect(Object.keys(discovery!.data as object)).toContain('openDimensions');
  });
});

describe('a held reply is never empty', () => {
  // THE INVARIANT THE LEDGER WAS STANDING IN FOR. It was added after an e2e
  // failure where a refused turn rendered neither a question nor a
  // confirmation gate, leaving the user nothing to act on. Dropping it is
  // only safe because `renderBlocks` always has something to say while the
  // gate holds — so that is asserted rather than assumed.
  const states: { name: string; brief: WorkingBrief }[] = [
    { name: 'nothing asked yet', brief: newBrief('o') },
    { name: 'a question outstanding', brief: recordQuestions(recordAnswer(newBrief('o'), 'first'), [{ text: 'And who are they?', impact: 'shaping' }]) },
    { name: 'the full ledger state', brief: withLedger() },
  ];

  for (const { name, brief } of states) {
    it(`says something when the gate holds: ${name}`, () => {
      const decision = decide(brief);
      expect(decision.proceed, 'fixture must actually be held').toBe(false);
      expect(decision.blocks.length).toBeGreaterThan(0);
      const rendered = renderBlocks(blockDelta(decision.blocks, []), decision.advice);
      expect(rendered.trim().length).toBeGreaterThan(0);
    });
  }

  it('still says something when every block is carried from last turn', () => {
    // The delta is what makes a repeat turn readable, and an all-carried
    // delta is where an empty reply would hide.
    const brief = withLedger();
    const blocks = blocksFor(brief);
    const rendered = renderBlocks(blockDelta(blocks, blocks.map((b) => b.code)), []);
    expect(rendered.trim().length).toBeGreaterThan(0);
  });

  it('never puts the model-facing fix in a carried line', () => {
    // `clears.how` is addressed to the MODEL: "Record who converts, or that
    // nobody knows plus two candidate segments resting on different things."
    // The multi-carried line used to join those. `reason` is the half written
    // for the manager, and both branches now use it.
    const brief = recordAnswer(newBrief('o'), 'go on then');
    const blocks = blocksFor(brief);
    expect(blocks.length).toBeGreaterThan(1);
    const rendered = renderBlocks(blockDelta(blocks, blocks.map((b) => b.code)), []);
    for (const b of blocks) expect(rendered).not.toContain(b.clears.how);
  });
});

// ------------------------------------------------------ A2. the tool result

describe('a tool result does not teach the third person', () => {
  it('does not tell the model the manager will see the questions', () => {
    // A tool result is the last thing the model reads before writing, so its
    // register is the register that comes back. This one said "The manager
    // will see them" and the reply came back "I've sent these two questions
    // to the campaign manager".
    const out = applyOutputTool(newBrief('o'), 'ask_questions', {
      questions: [{ text: 'What does activation mean to you?', impact: 'shaping' }],
    });
    expect(out.ok).toBeTruthy();
    expect(out.ok).not.toMatch(/manager/i);
    expect(out.ok).toMatch(/asking them directly/);
  });

  it('keeps every other output tool out of the third person too', () => {
    const findings = applyOutputTool(recordAnswer(newBrief('o'), 'they think it is too expensive'), 'record_findings', {
      converters: { shape: 'big spenders', basis: 'user', knowledge: 'known' },
    });
    expect(findings.ok).not.toMatch(/\bthe manager\b/i);
    const dims = applyOutputTool(newBrief('o'), 'record_dimensions', {
      dimensions: [{ name: 'Days since issue', rationale: 'r', status: 'open', basis: 'none' }],
    });
    expect(dims.ok).not.toMatch(/\bthe manager\b/i);
  });
});

describe('the prompt bans the phrases the run actually produced', () => {
  // Honesty, not enforcement — this project has found repeatedly that prompt
  // rules produce honest output and not changed behaviour. The structural
  // halves are the tool result above and the dropped ledger.

  it('bans our own vocabulary, in the terms the manual uses', () => {
    // WAS a list of four literal tokens the live run produced — '"set aside"
    // as a status', '"(retained)"', '"fork"', '"dosage"'. No manual names
    // them. What survives is the general rule they were instances of, which
    // the Discovery manual states more directly than the old ban did.
    expect(asking()).toMatch(/Do not narrate your own bookkeeping — statuses, round scope, what you have retained or set aside/);
    expect(asking()).toMatch(/Those are this system talking to itself/);
    expect(asking()).toMatch(/Do not say you have “sent questions to the campaign manager\.”/);
    // And the one place the old tokens are still forbidden by construction:
    // `renderBlocks` prints a block's manager-facing `reason`, never the
    // `how` written for the model.
    expect(asking()).toMatch(/Name things in ordinary words/);
  });

  it('allows a double-check and forbids a re-ask', () => {
    expect(asking()).toMatch(/A question that double-checks something is welcome/);
    expect(asking()).toMatch(/Reprinting a question they have already answered is not/);
  });
});

// --------------------------------------------------- B. activity and logs

describe('every activity row has a sentence, with the JSON kept', () => {
  it('uses the detail when there is one', () => {
    expect(detailsText({ type: 'model.tool_call.completed', title: 'Recording what you told me about customers', detail: 'Recorded who converts; 2 barrier(s).' }))
      .toBe('Recorded who converts; 2 barrier(s).');
  });

  it('falls back to the title when there is no detail', () => {
    // The case the Details panel used to render as JSON alone.
    expect(detailsText({ type: 'discovery.questions', title: 'Discovery continues' })).toBe('Discovery continues');
  });

  it('falls back to the event name when there is neither', () => {
    expect(detailsText({ type: 'validation.completed' })).toBe('Validation result');
  });

  it('is never empty, for any shape of event', () => {
    for (const e of [{}, { title: '  ' }, { detail: '' }, { title: '', detail: '   ', type: 'run.started' }]) {
      expect(detailsText(e).trim().length, JSON.stringify(e)).toBeGreaterThan(0);
    }
  });
});

describe('the activity titles are the phase, in sentences', () => {
  it('opens by reading the brief rather than "Gathering context"', async () => {
    script([proseTurn('One question first.')]);
    const { events } = await run(withLedger());
    const titles = events.map((e) => e.title);
    expect(titles).toContain('Reading your brief and bank context');
    expect(titles).not.toContain('Gathering context');
  });

  it('says what it is writing, not that it is thinking', async () => {
    script([proseTurn('One question first.')]);
    const { events } = await run(withLedger());
    const titles = events.filter((e) => e.type === 'model.started').map((e) => e.title);
    expect(titles.length).toBeGreaterThan(0);
    // The recovery title is on this list deliberately: a prose-only turn with
    // no tool calls is unusable, and the retry gets its own row. It is still a
    // sentence about what happened rather than "Agent continuing".
    for (const t of titles) {
      expect(['Writing a reply', 'Drafting the plan', 'Building the journey', 'That reply came back empty, asking again'], String(t)).toContain(t);
    }
    expect(titles).not.toContain('Agent thinking');
    expect(titles).not.toContain('Agent continuing');
  });

  it('ends by naming what it is waiting for', async () => {
    script([proposeTurn('A plan.')]);
    const { events } = await run(withLedger());
    expect(events.filter((e) => e.type === 'run.completed').map((e) => e.title)).toContain('Waiting for your answer');
  });
});

describe('a lookup is a lookup, and an output tool is not', () => {
  it('stamps the kind on every tool event', async () => {
    // Stage cannot carry this: `requested` and `started` are emitted as
    // 'understanding' whatever the tool, and only `completed` differs. The
    // client counted tool events and reported "6 lookups" on a discovery
    // turn with no lookup tools available at all.
    script([
      sse([
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a1', name: 'ask_questions', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ questions: [{ text: 'Which cards count as new?' }] }) } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } },
      ]),
      proseTurn('One more thing.'),
    ]);
    const { events } = await run(withLedger());
    const toolEvents = events.filter((e) => e.type.startsWith('model.tool_call'));
    expect(toolEvents.length).toBeGreaterThan(0);
    for (const e of toolEvents) {
      expect((e.data as { kind?: string }).kind, e.type).toBe('output');
    }
    // Which is what makes the count zero on a turn that looked nothing up.
    const lookups = toolEvents.filter((e) => (e.data as { kind?: string }).kind === 'lookup');
    expect(lookups).toHaveLength(0);
  });
});

describe('Logs and the Design panel name the same event the same way', () => {
  it('keeps friendlyEvent as a fallback for events with no title', () => {
    // Both surfaces prefer `event.title`. `friendlyEvent` sees only the type,
    // so it cannot tell "Drafting the plan" from "Writing a reply" — keeping
    // two maps in step by hand is how the two tabs came to disagree.
    const logs = readFileSync(new URL('../../src/designer/RunLogsView.tsx', import.meta.url), 'utf8');
    expect(logs).toMatch(/e\.title\?\.trim\(\) \|\| friendlyEvent\(e\.type\)/);
    expect(friendlyEvent('validation.completed')).toBe('Validation result');
    expect(friendlyEvent('something.unmapped')).toBe('something unmapped');
  });

  it('shows the sentence above the JSON in both panels', () => {
    const logs = readFileSync(new URL('../../src/designer/RunLogsView.tsx', import.meta.url), 'utf8');
    const designer = readFileSync(new URL('../../src/designer/CampaignDesigner.tsx', import.meta.url), 'utf8');
    for (const [name, src] of [['logs', logs], ['designer', designer]] as const) {
      expect(src, name).toMatch(/detailsText\(e(vent)?\)/);
      // And the JSON is still there. Hiding it was never the fix.
      expect(src, name).toMatch(/JSON\.stringify\(e(vent)?\.data, null, 1\)/);
    }
  });
});

describe('the streaming placeholder is not a scavenged JSON fragment', () => {
  it('no longer digs fields out of a partial payload', () => {
    // The model writes prose and puts structure in tool calls, so there is no
    // JSON in the text stream. The brace slice also truncated any sentence
    // containing one.
    const src = readFileSync(new URL('../../src/designer/CampaignDesigner.tsx', import.meta.url), 'utf8');
    expect(src).not.toContain('"summary"\\s*:\\s*"');
    expect(src).not.toMatch(/function stripJson/);
    // The old fallback string survives in the comment explaining why it went,
    // so this asserts on the CODE rather than the file.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('Working on the campaign strategy');
    expect(src).toMatch(/Drafting the plan…/);
    expect(src).toMatch(/Writing a reply…/);
  });
});
