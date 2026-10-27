// FOUR SCREENS, NOT ONE WORD FOR THREE SITUATIONS.
//
// MEASURED, `eval/runs/ui-s-1792984906680`.
//
// Turn 1: three questions, printed twice — once as the model's own numbered
// prose, once as the response's `questions` list under it.
//
// Turn 2: success, converters and the barrier on the record; `questions: []`
// because the model wrote "I have enough"; purchase channel filed as its own
// `assumption`. `propose_strategy` was off, correctly, because `turnPhase`
// was still `asking`.
//
// Turns 3 and 4: after a diary entry ending "nothing else", ingest wrote that
// a probe had been closed which was never asked. They then proposed a real
// journey — ticket split, wording test, READ against not-read, last chance on
// every tail — and `decide(brief).blocks` was EMPTY. The turn was still held:
// `evaluateDiscovery` wanted a third dimension row ("I have only looked at 2
// angle(s) so far", `questions: []` on turn 4), and `cadence-unnamed` counted
// every experiment arm and read caption in `touches` as its own path and
// demanded two sends each.
//
// Phase `discovery`, no questions, no Confirm, essay that reads like a plan.
// Brief-open, plan-held and "the model wrote an essay" were all one screen.
// That is the lie this file pins shut.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { orchestrateStream } from '../../server/orchestrator';
import { seedKnowledgeBase } from '../../server/knowledge';
import { evaluateDiscovery } from '../../server/discovery';
import { decide, turnPhase, cadenceBlocks, blocksFor, otherAxesProbed } from '../../server/gate';
import { noteClosedOtherAxes, probeWasAsked, seenAxes, type WorkingBrief } from '../../server/discovery';
import { receive, outstanding } from '../../server/record';
import { outputToolsForPhase } from '../../server/outputTools';

// Module scope: the Plan reply is asserted PRESENT in one describe and
// ABSENT in another, so one definition serves both.
const PLAN_SENTENCE = /The plan itself has not gone up yet/;

const liveBrief = (turn: 2 | 4): WorkingBrief =>
  JSON.parse(
    readFileSync(new URL(`./support/liveBriefs/ui-s-1792984906680.turn-${turn}.brief.json`, import.meta.url), 'utf8'),
  ) as WorkingBrief;

describe('BRIEF — the record is open, so there is a question', () => {
  const b = () => liveBrief(2);

  it('is the live shape: findings filed, one axis seen, the agent talking to itself about another', () => {
    expect(b().successCriteria?.length).toBeGreaterThan(0);
    expect(b().converters?.basis).toBe('user');
    expect((b().barriers ?? []).length).toBe(1);
    expect(b().dimensions?.map((d) => [d.name, d.status, d.basis])).toEqual([
      ['transaction amount', 'retained', 'user'],
      ['purchase channel (online checkout vs in-store/POS swipe)', 'deferred', 'assumption'],
    ]);
  });

  it('is NOT closed, and the one thing open is the probe', () => {
    expect(blocksFor(b()).map((x) => x.code)).toEqual(['unprobed-other-axes']);
    expect(turnPhase(b(), { isBuildTurn: false, limitReached: false })).toBe('asking');
    // `propose_strategy` is off, which is why the live turn could not propose.
    expect(outputToolsForPhase('asking').map((t) => t.name)).not.toContain('propose_strategy');
  });

  it('an ASSUMPTION row is not an answer to it', () => {
    // "I have enough" plus a row the agent deferred on its own is the agent
    // talking to itself. It does not close the search, and it does not
    // authorise a POS question after a plan exists — once the brief is closed
    // that idea is a limitation in the writeup.
    expect(seenAxes(b()).map((d) => d.name)).toEqual(['transaction amount']);
    expect(otherAxesProbed(b())).toBe(false);
    expect(probeWasAsked(b())).toBe(false);
  });

  it('"nothing else" does not close a probe nobody asked', () => {
    // THE TURN-2 PIN. `questions` was `[]` on that turn, so the next
    // message's wording cannot be an answer to anything. The matcher is
    // unchanged — no phrase was taught — the question has to have existed.
    expect(b().questions?.filter((q) => q.addressedInRound === undefined)).toEqual([]);
    const after = noteClosedOtherAxes(receive(b(), 'nothing else').brief, 'nothing else');
    expect(after.facts?.some((f) => f.statement.startsWith('They have closed the question of a second pattern'))).toBe(
      false,
    );
    expect(otherAxesProbed(after)).toBe(false);
    expect(blocksFor(after).map((x) => x.code)).toContain('unprobed-other-axes');
  });

  it('the Brief screen can never have an empty ask while a block stands', () => {
    const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    // The model's questions where it asked the right thing, the block reasons
    // where it did not. `questions: []` on an open record is unconstructable.
    expect(orch).toMatch(/const briefQuestions = briefClosed/);
    expect(orch).toMatch(/decision\.blocks\.slice\(0, 3\)\.map\(\(b\) => b\.reason\)/);
    expect(orch).toMatch(/questions: briefQuestions,/);
  });

  it('and the bubble does not restate the list', () => {
    // Turn 1: the model's prose WAS the three questions, and the response
    // carried them too. The list survives — it is what the client offers an
    // answer box for — and the enumerated tail is cut from the prose.
    const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    expect(orch).toMatch(/const withoutNumberedTail = \(text: string\): string =>/);
    expect(orch).toMatch(/const prose = briefQuestions\.length \? withoutNumberedTail\(heldProse\) : heldProse;/);
  });
});

describe('REVISE — the brief is closed and the plan needs a change', () => {
  const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
  // FROM WHERE `briefClosed` IS COMPUTED, not from the `if`: the record's
  // own answer is read just above the branch, which is the point — the plan
  // checks must not reach it.
  const held = orch.slice(
    orch.indexOf('  const briefClosed = phaseNow()'),
    orch.indexOf('  // Discovery is complete.'),
  );

  it('is its own phase, decided by the record rather than by the plan checks', () => {
    expect(held).toMatch(/const briefClosed = phaseNow\(\) !== 'asking';/);
    // And Revise only when there is something to revise — `planOrRevise`
    // says `planning` when no shaped path is on file.
    expect(held).toMatch(/phase: briefClosed \? planOrRevise\(filedPath\) : 'discovery',/);
  });

  it('carries the path, no questions, and nothing that means approved', () => {
    expect(held).toMatch(/pendingBlueprint: filedPath,/);
    expect(held).toMatch(/strategy: null,/);
    expect(held).toMatch(/blueprint: null,/);
    expect(held).not.toMatch(/awaiting-confirmation/);
  });

  it('keeps the plan tool on for the next turn', () => {
    // `turnPhase` reads the RECORD. A plan-hold must not flip the next turn
    // back to asking, or the model cannot send the fix.
    const b = liveBrief(4);
    expect(decide(b).blocks).toEqual([]);
    expect(turnPhase(b, { isBuildTurn: false, limitReached: false })).toBe('ready');
    expect(outputToolsForPhase('ready').map((t) => t.name)).toContain('propose_strategy');
  });

  it('Confirm is still only awaiting-confirmation, in the client', () => {
    const client = readFileSync(new URL('../../src/designer/CampaignDesigner.tsx', import.meta.url), 'utf8');
    expect(client).toMatch(/\{!busy && phase === 'awaiting-confirmation' && \(/);
    // And the numbered list is hidden on both plan phases the same way.
    expect(client).toMatch(/const planOnScreen = phase === 'awaiting-confirmation' \|\| phase === 'revising';/);
    expect(client).toMatch(/last\?\.questions\?\.length && !planOnScreen/);
  });
});

describe('APPROVE — this run would have reached it', () => {
  const b = () => liveBrief(4);
  const proposed = () => {
    const lp = b().lastProposal!;
    return { strategy: lp.strategy, openItems: [], blueprint: lp.blueprint } as never;
  };

  it('cadence reads the steps, so the over-split touch list no longer holds it', () => {
    // Six "paths" in the prose — two experiment arms, two read captions, an
    // "all still unconverted" and the high band — against a journey whose
    // smaller band already runs day 0 / 2 / 5.
    const paths = new Set((b().lastProposal!.strategy.touches ?? []).map((t: { path?: string }) => t.path));
    expect(paths.size).toBe(6);
    expect(cadenceBlocks(proposed())).toEqual([]);
  });

  it('the whole turn is approvable, with nothing typed', () => {
    const d = decide(b(), { proposed: proposed() });
    expect(d.blocks.map((x) => x.code), d.blocks.map((x) => x.reason).join(' | ')).toEqual([]);
    expect(d.proceed).toBe(true);
    expect(d.forcedBy).toBeUndefined();
  });

  it('and the brief itself was closed two turns earlier than the gate admitted', () => {
    expect(blocksFor(b())).toEqual([]);
    expect(outstanding(b())).toEqual([]);
  });
});

describe('the lock we are not retiring', () => {
  const send = (name: string) => ({
    kind: 'send',
    name,
    objective: ['emi'],
    stage: 'first-touch',
    describe: 'Say it can be split.',
    channelPreference: ['WHATSAPP'],
    barrier: 'b',
  });
  const bands = (high: unknown[], low: unknown[]) => ({
    campaignName: 'A',
    description: 'd',
    goal: null,
    entry: { kind: 'audience', entity: 'Card', conditions: [] },
    steps: [
      {
        kind: 'branch',
        label: 'Ticket band',
        entity: 'Transaction',
        attribute: 'Transaction Amount',
        paths: [
          { label: 'High ticket', operator: 'Greater than', value: '10000', steps: high },
          { label: 'Everyone else', operator: 'Less than', value: '10000', steps: low },
        ],
      },
    ],
  });

  it('one touch per band CONFIRMS: a who-split plus a clock is a campaign', () => {
    const plan = { strategy: { summary: 's', approach: [] }, blueprint: bands([send('High')], [send('Low')]) } as never;
    expect(cadenceBlocks(plan)).toEqual([]);
    // ASSERTED ON CADENCE, not on every rule. This synthetic plan declares no
    // test, so `trendBlocks` holds it for `nothing-tested` — a different rule
    // with its own reasoning, and one this slice does not touch. What matters
    // here is that the SEQUENCE is never the objection.
    const d = decide(liveBrief(4), { proposed: plan });
    expect(d.blocks.map((x) => x.code)).not.toContain('cadence-unnamed');
  });

  it('a band with nothing to send it still holds', () => {
    const plan = {
      strategy: { summary: 's', approach: [] },
      blueprint: bands([send('High')], [{ kind: 'exit', reason: 'Nothing for them.' }]),
    } as never;
    expect(cadenceBlocks(plan).map((x) => x.code)).toEqual(['cadence-unnamed']);
  });
});

// COMMENTARY CANNOT REOPEN THE BRIEF.
//
// MEASURED as a door rather than as this run's hold. `evaluateDiscovery`
// returned `ask_questions` the moment the model sent questions — before
// anything asked whether the record was closed — and the orchestrator's two
// `gate.outcome` returns fired at lines 2297 and 2330 while `briefClosed` was
// computed at 2407. **110 lines downstream.** The Brief/Revise split never
// saw them.
//
// So a POS leftover became question 1 after a plan existed, a numbered list
// appeared beside Approve, and `recordQuestions` wrote those strings as
// OUTSTANDING — which flips the next turn back to `asking` and strips
// `propose_strategy`. The brief reopened by bookkeeping, from a thought the
// manager never needed to answer.
//
// `request_evidence` was the same door, quieter: `discovery` with
// `questions: []`.
describe('an ask on a closed brief is commentary, not a question', () => {
  const knowledge = seedKnowledgeBase();
  const EMI = 'Customers are not converting eligible purchases to EMI. Get more of them converting.';
  const POS = 'Should purchases at merchants whose checkout cannot show an EMI option be treated differently?';

  const sse = (events: Record<string, unknown>[]) =>
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

  // `lead` is prose BEFORE the JSON, because that is the only place this exit
  // can read it: the reply composes `proseBefore(assistantText)`, which cuts
  // at the first `{`. A message that is nothing but a payload carries no
  // claim at all, so a fixture without a lead cannot tell Plan copy from
  // their own words.
  const turn = async (payload: unknown, brief: WorkingBrief, lead = '') => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        new TextEncoder().encode(
          sse([
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: `${lead ? `${lead}\n` : ''}${JSON.stringify(payload)}` },
            },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 200 } },
          ]),
        ),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const gen = orchestrateStream({
      sessionId: 'door',
      tenantId: 'TEN-IBL',
      knowledge,
      discoveryRounds: 2,
      brief,
      messages: [
        { role: 'user', content: EMI },
        { role: 'user', content: 'Yes, go on.' },
      ],
      session: { state: 'DISCOVERING', strategyVersion: 0, confirmation: null },
    } as never);
    let out = await gen.next();
    while (!out.done) out = await gen.next();
    return out.value as unknown as Record<string, unknown>;
  };

  const OLD = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.ANTHROPIC_API_KEY = OLD ?? 'test-key-not-real';
  });

  it('CLOSED + ask: not discovery, no list, nothing outstanding, still ready next turn', async () => {
    const before = liveBrief(4);
    expect(decide(before).blocks).toEqual([]);

    const res = await turn({ action: 'ask', questions: [POS], rationale: 'One more thing.' }, before);
    expect(res.phase).not.toBe('discovery');
    expect(res.questions).toEqual([]);

    // The strings are not on the record as questions waiting for a reply, so
    // the next turn is still `ready` and the plan tool is still on the list.
    const after = res.brief as WorkingBrief;
    expect(outstanding(after).map((q) => q.text)).not.toContain(POS);
    expect(after.questions?.some((q) => q.text === POS)).toBe(false);
    expect(decide(after).blocks.map((x) => x.code)).not.toContain('awaiting-reply');
    expect(turnPhase(after, { isBuildTurn: false, limitReached: false })).toBe('ready');
    expect(outputToolsForPhase('ready').map((t) => t.name)).toContain('propose_strategy');
  });

  it('and it draws the journey already on file rather than erroring', async () => {
    // The fall-through this replaces: "The agent did not produce a strategy.
    // Retry to force a proposal." A finished brief with a filed path is not
    // an error state.
    const res = await turn({ action: 'ask', questions: [POS] }, liveBrief(4), 'One more thing about the plan.');
    expect(res.phase).toBe('revising');
    expect(res.pendingBlueprint).toBeTruthy();
    expect(res.strategy ?? null).toBeNull();
    // AND THEIR RATIONALE SURVIVES. `length > 0` was satisfied by the Plan
    // sentence, so Plan copy on a FILED path would have passed this test —
    // the one thing Revise must not do. The journey exists here, so a
    // sentence about it is true, and their words are the better copy.
    expect(String(res.reply ?? '')).toMatch(/One more thing about the plan/);
    expect(String(res.reply ?? '')).not.toMatch(PLAN_SENTENCE);
  });

  it('CLOSED + ask + a real plan: Approve, with the ask as a flag', async () => {
    const lp = liveBrief(4).lastProposal!;
    const res = await turn(
      { action: 'propose', strategy: lp.strategy, blueprint: lp.blueprint, openItems: [] },
      liveBrief(4),
    );
    expect(res.phase).toBe('awaiting-confirmation');
    expect(res.questions).toEqual([]);
    expect(res.pendingBlueprint).toBeTruthy();
  });

  it('OPEN + ask is still the Brief screen', async () => {
    const before = liveBrief(2);
    expect(blocksFor(before).map((x) => x.code)).toEqual(['unprobed-other-axes']);

    const probe = 'Besides ticket size, have you seen anything else that splits who converts?';
    const res = await turn({ action: 'ask', questions: [probe] }, before);
    expect(res.phase).toBe('discovery');
    expect(res.questions).toEqual([probe]);
    // On screen AND on the record, which is what an open brief is for.
    expect(outstanding(res.brief as WorkingBrief).map((q) => q.text)).toContain(probe);
    expect(outputToolsForPhase('asking').map((t) => t.name)).not.toContain('propose_strategy');
  });

  it('the gate itself refuses to call it Brief', () => {
    const asked = {
      brief: liveBrief(4),
      modelAction: 'ask' as const,
      modelQuestions: [POS],
      modelEvidence: [],
      openItems: [],
      forced: false,
      maxRounds: 8,
    };
    expect(evaluateDiscovery({ ...asked, briefClosed: true }).outcome).not.toBe('ask_questions');
    expect(evaluateDiscovery({ ...asked, briefClosed: true }).questions).toEqual([]);
    // The text is kept, as a flag on the plan.
    expect(evaluateDiscovery({ ...asked, briefClosed: true }).openItems.map((i) => i.question)).toContain(POS);
    // And an OPEN brief is untouched.
    expect(evaluateDiscovery({ ...asked, brief: liveBrief(2), briefClosed: false }).outcome).toBe('ask_questions');
  });
});

// THE TOOL-ONLY "I HAVE ENOUGH" EXIT.
//
// MEASURED, `eval/runs/ui-s-1792989364193` turn 2. The manager answered the
// three brief questions. The agent filed them through `record_findings` and
// `record_dimensions`, wrote "Everything I need is now on record", and never
// asked the probe. `decide(brief)` was `unprobed-other-axes`. This branch
// printed the completeness sentence with `questions: []` because the
// fill-from-blocks path lived only on a held propose.
describe('filing the diary does not close an open brief', () => {
  const knowledge = seedKnowledgeBase();
  const EMI = 'Customers are not converting eligible purchases to EMI. Get more of them converting.';
  const ENOUGH =
    'Everything I need is now on record: the goal is raw count of conversions, the one confirmed pattern is ticket size, the barrier is pure awareness. I will bring back a 7-day journey.';

  const sse = (events: Record<string, unknown>[]) =>
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

  const writeRound = (tool: string, input: unknown) =>
    sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `tu-${tool}`, name: tool, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 60 } },
    ]);
  const proseRound = (prose: string) =>
    sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: prose } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 90 } },
    ]);

  const OLD = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.ANTHROPIC_API_KEY = OLD ?? 'test-key-not-real';
  });

  it('puts the probe on the screen and on the record, not the completeness sentence', async () => {
    const before = liveBrief(2);
    expect(blocksFor(before).map((x) => x.code)).toEqual(['unprobed-other-axes']);

    const bodies = [
      writeRound('record_findings', {
        successCriteria: before.successCriteria,
        converters: before.converters,
        barriers: before.barriers,
      }),
      proseRound(ENOUGH),
    ];
    let i = 0;
    vi.stubGlobal('fetch', async () => {
      const body = bodies[Math.min(i, bodies.length - 1)];
      i += 1;
      return new Response(new TextEncoder().encode(body), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const gen = orchestrateStream({
      sessionId: 'enough',
      tenantId: 'TEN-IBL',
      knowledge,
      discoveryRounds: 1,
      brief: before,
      messages: [
        { role: 'user', content: EMI },
        { role: 'user', content: '1. most number of transactions converted 2. txn size 10k+ convert more 3. they dont know if txn is eligible for emi or not' },
      ],
      session: { state: 'DISCOVERING', strategyVersion: 0, confirmation: null },
    } as never);
    let out = await gen.next();
    while (!out.done) out = await gen.next();
    const res = out.value as unknown as Record<string, unknown>;

    expect(res.phase).toBe('discovery');
    expect(res.questions as string[]).not.toEqual([]);
    expect((res.questions as string[]).join(' ')).toMatch(/anything else you have noticed that splits who acts/i);
    expect(String(res.reply ?? '')).not.toMatch(/Everything I need is now on record/);
    expect(String(res.reply ?? '')).toMatch(/anything else you have noticed that splits who acts/i);
    expect(outstanding(res.brief as WorkingBrief).map((q) => q.text).join(' ')).toMatch(
      /anything else you have noticed that splits who acts/i,
    );
    expect(turnPhase(res.brief as WorkingBrief, { isBuildTurn: false, limitReached: false })).toBe('asking');
  });
});

// EVERY REMAINING WAY A MANAGER GETS A DIARY AND NOTHING TO DO.
//
// Door 1 (tools + essay on an open record) is covered above. These are its
// siblings, each of which returned `phase: 'discovery'` from a different
// place:
//
//  - the SAME exit on a CLOSED record: "waiting for your answer" to someone
//    with nothing left to answer, and any journey already on file hidden,
//    because the client only draws on a plan phase;
//  - unparsed-but-readable prose: `discovery` with no `questions` field at
//    all;
//  - the two post-plan refusals (barrier coverage, experiment claims): a plan
//    existed, one of its own checks refused it, and the manager was put back
//    on Brief.
describe('the remaining diary doors', () => {
  const knowledge = seedKnowledgeBase();
  const EMI = 'Customers are not converting eligible purchases to EMI. Get more of them converting.';

  const sse = (events: Record<string, unknown>[]) =>
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const toolRound = (tool: string, input: unknown) =>
    sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `t-${tool}`, name: tool, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 60 } },
    ]);
  const proseRound = (prose: string) =>
    sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: prose } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 90 } },
    ]);
  /** Long enough to count as readable: the branch errors on a short scrap. */
  const UNPARSED =
    'Here is my thinking in full. The window is seven days, the awareness gap is the thing to attack, and I would rather talk it through than send you a form right now.';

  const run = async (bodies: string[], brief: WorkingBrief) => {
    let i = 0;
    vi.stubGlobal('fetch', async () => {
      const body = bodies[Math.min(i, bodies.length - 1)];
      i += 1;
      return new Response(new TextEncoder().encode(body), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const gen = orchestrateStream({
      sessionId: 'doors',
      tenantId: 'TEN-IBL',
      knowledge,
      discoveryRounds: 2,
      brief,
      messages: [
        { role: 'user', content: EMI },
        { role: 'user', content: 'Yes, go on.' },
      ],
      session: { state: 'DISCOVERING', strategyVersion: 0, confirmation: null },
    } as never);
    let out = await gen.next();
    while (!out.done) out = await gen.next();
    return out.value as unknown as Record<string, unknown>;
  };

  const OLD = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.ANTHROPIC_API_KEY = OLD ?? 'test-key-not-real';
  });

  it('tools + essay on a CLOSED record is Revise, not Brief and not an error', async () => {
    const before = liveBrief(4);
    expect(decide(before).blocks).toEqual([]);
    const res = await run(
      [
        toolRound('record_dimensions', {
          dimensions: [{ name: 'Transaction ticket size', rationale: 'Still the axis.', status: 'retained', basis: 'user', note: 'Theirs.' }],
        }),
        proseRound('Noted. I will bring the journey back with the wording test attached.'),
      ],
      before,
    );
    expect(res.phase).toBe('revising');
    expect(res.questions ?? []).toEqual([]);
    expect(res.pendingBlueprint).toBeTruthy();
    expect(String(res.reply ?? '')).not.toMatch(/did not produce a strategy/);
    // And the next turn can still send the plan.
    expect(turnPhase(res.brief as WorkingBrief, { isBuildTurn: false, limitReached: false })).toBe('ready');
  });

  it('unreadable-to-the-parser prose on an OPEN record still asks', async () => {
    const before = liveBrief(2);
    const res = await run([proseRound(UNPARSED)], before);
    expect(res.phase).toBe('discovery');
    expect(res.questions as string[]).not.toEqual([]);
    expect(outstanding(res.brief as WorkingBrief).length).toBeGreaterThan(0);
  });

  it('and on a CLOSED record is Revise with the path, not Brief', async () => {
    const res = await run(
      [proseRound(UNPARSED)],
      liveBrief(4),
    );
    expect(res.phase).toBe('revising');
    expect(res.questions ?? []).toEqual([]);
    expect(res.pendingBlueprint).toBeTruthy();
  });

  it('the post-plan refusals are Revise in the source, with the path drawn', () => {
    const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    for (const marker of ['Reworking the campaign', 'Reworking the experiment']) {
      const at = orch.indexOf(marker);
      expect(at, marker).toBeGreaterThan(-1);
      const block = orch.slice(at, at + 1400);
      expect(block, marker).toMatch(/phase: 'revising',/);
      expect(block, marker).not.toMatch(/phase: 'discovery',/);
      expect(block, marker).toMatch(/pendingBlueprint: shapedBlueprint\(blueprint as never\)/);
    }
  });

  it('no return anywhere pairs discovery with an empty ask', () => {
    // The shape of every door in this file: `phase: 'discovery'` beside
    // `questions: []`. A Brief screen with nothing to answer is the diary.
    const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    const lines = orch.split('\n');
    const offenders: string[] = [];
    lines.forEach((l, i) => {
      if (!/^\s*phase: 'discovery',\s*$/.test(l)) return;
      const window = lines.slice(i, i + 14).join('\n');
      if (!/questions: \[\],/.test(window)) return;
      // ONE EXEMPTION, AND IT IS NOT A DIARY: the evidence request carries its
      // ask in `evidenceRequests`, which the client renders with its own "we
      // do not have that" reply. It is also reachable only while the record is
      // open — `!briefClosed` guards it — so it cannot appear beside a plan.
      if (/evidenceRequests: gate\.evidence,/.test(window)) return;
      offenders.push(`line ${i + 1}`);
    });
    expect(offenders).toEqual([]);
  });
});

// PLAN — THE BRIEF IS CLOSED AND THERE IS NOTHING ON FILE YET.
//
// MEASURED, `eval/runs/ui-s-1792991223125` turn 3. The record was finished:
// count, ticket size, awareness, and the probe closed with "not really".
// `decide(brief).blocks` was empty, `turnPhase` was `ready`,
// `propose_strategy` was on the list. The agent called `record_findings` and
// `record_dimensions` and wrote *"I've laid out the 7-day plan above."*
//
// The response was `phase: 'revising'`, `pendingBlueprint: null`,
// `questions: []`, no Confirm. An empty canvas under a sentence claiming a
// journey that was never sent. **Revise with nothing to revise is the lie.**
describe('PLAN — a closed brief with no path is not Revise', () => {
  const knowledge = seedKnowledgeBase();
  const EMI = 'Customers are not converting eligible purchases to EMI. Get more of them converting.';
  const CLAIMED = "I've logged the findings and closed out the segmentation question. I've laid out the 7-day plan above.";

  const live = (): WorkingBrief =>
    JSON.parse(
      readFileSync(new URL('./support/liveBriefs/ui-s-1792991223125.turn-3.brief.json', import.meta.url), 'utf8'),
    ) as WorkingBrief;

  const sse = (events: Record<string, unknown>[]) =>
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const toolRound = (tool: string, input: unknown) =>
    sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `p-${tool}`, name: tool, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 60 } },
    ]);
  const proseRound = (prose: string) =>
    sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: prose } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 90 } },
    ]);

  // Every request body, in order, so a test can assert what the model was
  // actually SENT and not only what came back. The correction only works if
  // it reaches the wire as a `tool_result` against its own `tool_use`.
  const sent: Record<string, unknown>[] = [];
  const emitted: Record<string, unknown>[] = [];
  const run = async (bodies: string[]) => {
    let i = 0;
    sent.length = 0;
    vi.stubGlobal('fetch', async (_url: string, init?: { body?: string }) => {
      try {
        sent.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      } catch {
        sent.push({});
      }
      const body = bodies[Math.min(i, bodies.length - 1)];
      i += 1;
      return new Response(new TextEncoder().encode(body), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const gen = orchestrateStream({
      sessionId: 'plan',
      tenantId: 'TEN-IBL',
      knowledge,
      discoveryRounds: 2,
      brief: live(),
      messages: [
        { role: 'user', content: EMI },
        { role: 'user', content: 'not really' },
      ],
      session: { state: 'DISCOVERING', strategyVersion: 0, confirmation: null },
    } as never);
    // The yielded values are the activity events. They were discarded, so
    // nothing could assert on what a failure reported.
    emitted.length = 0;
    let out = await gen.next();
    while (!out.done) {
      if (out.value) emitted.push(out.value as Record<string, unknown>);
      out = await gen.next();
    }
    return out.value as unknown as Record<string, unknown>;
  };

  const OLD = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.ANTHROPIC_API_KEY = OLD ?? 'test-key-not-real';
  });

  it('is the live shape: record settled, nothing on file', () => {
    const b = live();
    expect(decide(b).blocks).toEqual([]);
    expect(turnPhase(b, { isBuildTurn: false, limitReached: false })).toBe('ready');
    expect(b.lastProposal ?? null).toBeNull();
    expect(outputToolsForPhase('ready').map((t) => t.name)).toContain('propose_strategy');
  });

  it('THE PIN: never revising with a null path, and never claims a plan', async () => {
    // Every round answers with the same tools-and-prose turn, including the
    // forced `propose_strategy` call — so this walks the worst case, where the
    // model will not send a journey however directly it is asked.
    const res = await run([
      // ONE READY ROUND IS ENOUGH, SINCE 2026-10-26. A round that records and
      // does not propose ends the loop, so the prose round these scripts used
      // to spend never happens: the forced propose is the very next call. On
      // `eval/runs/ui-s-1793017853714` those two unforced rounds were spent
      // asking about prior EMI on a record that was already closed.
      toolRound('record_findings', { successCriteria: live().successCriteria, converters: live().converters, barriers: live().barriers }),
    ]);

    expect(res.pendingBlueprint ?? null).toBeNull();
    expect(res.phase).not.toBe('revising');
    expect(res.phase).not.toBe('awaiting-confirmation');
    expect(res.phase).toBe('planning');
    // Not Brief either: the record is finished, so there is nothing to ask.
    expect(res.phase).not.toBe('discovery');
    expect(res.questions ?? []).toEqual([]);
    // And not the old failure text.
    expect(String(res.reply ?? '')).not.toMatch(/did not produce a strategy/);
    // THE SENTENCE MUST NOT SURVIVE. It claims a journey nobody sent.
    expect(String(res.reply ?? '')).not.toMatch(/laid out/i);
    expect(String(res.reply ?? '')).not.toMatch(/plan above/i);
    // The next turn is still the plan's turn.
    expect(turnPhase(res.brief as WorkingBrief, { isBuildTurn: false, limitReached: false })).toBe('ready');
  });

  it('and when the forced call DOES send a journey, it is Approve', async () => {
    // RE-CITED TO THIS BRIEF'S OWN BARRIER. The journey is borrowed from the
    // other run, and `propose_strategy` refuses an architecture citing a
    // barrier id that is not on THIS record — the check working, and the
    // reason my first fixture came back `planning`.
    const mine = live().barriers![0].id;
    const borrowed = liveBrief(4).lastProposal!;
    const lp = JSON.parse(
      JSON.stringify(borrowed).replace(/"eligibility-awareness"/g, JSON.stringify(mine)),
    ) as typeof borrowed;
    const res = await run([
      toolRound('record_findings', { successCriteria: live().successCriteria, converters: live().converters, barriers: live().barriers }),
      toolRound('propose_strategy', { ...lp.strategy, blueprint: lp.blueprint }),
      // A model ends its turn with text; without this the round loop never
      // exits and the run dies on "spent all of its lookups" — a fixture
      // fault, not a product one.
      proseRound('That is the plan.'),
    ]);
    expect(res.phase).toBe('awaiting-confirmation');
    expect(res.pendingBlueprint).toBeTruthy();
    expect(res.questions ?? []).toEqual([]);
  });

  it('THE FORCED CALL IS WHAT SAVES THE TURN, not the round loop', async () => {
    // AND THIS IS THE TEST I FIRST GOT WRONG. The Approve case above feeds
    // `propose_strategy` as the SECOND round, so the round loop collects it
    // and the turn would reach Confirm whether or not anything was forced —
    // disabling `readyWithNoJourney` left it green.
    //
    // Here the loop ENDS with prose and no plan, which is the live shape. The
    // only way a journey can arrive is the forced call after the loop.
    const mine = live().barriers![0].id;
    const borrowed = liveBrief(4).lastProposal!;
    const lp = JSON.parse(JSON.stringify(borrowed).replace(/"eligibility-awareness"/g, JSON.stringify(mine))) as typeof borrowed;
    const res = await run([
      toolRound('record_findings', { successCriteria: live().successCriteria, converters: live().converters, barriers: live().barriers }),
      toolRound('propose_strategy', { ...lp.strategy, blueprint: lp.blueprint }),
    ]);
    expect(res.phase).toBe('awaiting-confirmation');
    expect(res.pendingBlueprint).toBeTruthy();
    expect(String(res.reply ?? '')).not.toMatch(/laid out/i);
  });

  // A REFUSED FORCED PROPOSE GETS THE ONE CORRECTION THE ROUND LOOP GIVES.
  //
  // MEASURED, `eval/runs/ui-s-1792996412937` turn 3: rounds filed findings and
  // wrote an essay, the force fired, the model CALLED `propose_strategy`, and
  // `applyOutputTool` refused it for having no journey. The refusal text named
  // exactly what to fix and went out as `model.tool_call.failed` — never as a
  // `tool_result` — so the model never read it. "No plan came back", Plan
  // sentence, no Confirm.
  const refusedThenGood = () => {
    const mine = live().barriers![0].id;
    const borrowed = liveBrief(4).lastProposal!;
    const lp = JSON.parse(JSON.stringify(borrowed).replace(/"eligibility-awareness"/g, JSON.stringify(mine))) as typeof borrowed;
    // THE FIRST FORCE IS THE REFUSAL — a plan with no journey, which is what
    // the live model sent. This is the half that makes the test mean anything:
    // with a good first force, the correction can be disabled and the turn
    // still reaches Confirm, which is the sibling test above.
    return { noJourney: { ...lp.strategy }, withPath: { ...lp.strategy, blueprint: lp.blueprint } };
  };

  it('THE CORRECTION LANDS: refused force, then the same plan with a path', async () => {
    const { noJourney, withPath } = refusedThenGood();
    const res = await run([
      toolRound('record_findings', { successCriteria: live().successCriteria, converters: live().converters, barriers: live().barriers }),
      toolRound('propose_strategy', noJourney),
      toolRound('propose_strategy', withPath),
    ]);
    expect(res.phase).toBe('awaiting-confirmation');
    expect(res.pendingBlueprint).toBeTruthy();
    expect(res.questions ?? []).toEqual([]);
    // Not the Plan sentence: a plan went up.
    expect(String(res.reply ?? '')).not.toMatch(PLAN_SENTENCE);
    expect(String(res.reply ?? '')).not.toMatch(/laid out/i);

    // AND IT REACHED THE WIRE, which the response alone cannot show. A
    // `tool_result` whose `tool_use` is missing from the history is rejected
    // by the real API, so dropping the assistant block would lose the turn
    // rather than correct it — and the fetch stub would never notice.
    const last = sent[sent.length - 1] as { messages: { role: string; content: unknown }[] };
    const blocks = last.messages.flatMap((m) =>
      Array.isArray(m.content) ? (m.content as { type?: string; tool_use_id?: string; id?: string; content?: string }[]) : [],
    );
    // THE LAST PAIR, not the first: round 1's `record_findings` result is also
    // in this history, and matching on `find` pinned that instead — green, and
    // about the wrong call.
    const uses = blocks.filter((b) => b.type === 'tool_use');
    const use = uses[uses.length - 1];
    expect(use).toBeTruthy();
    const result = blocks.find((b) => b.type === 'tool_result' && b.tool_use_id === use.id);
    expect(result).toBeTruthy();
    expect(String(result!.content)).toMatch(/no journey in it/i);
    expect(String(result!.content)).toMatch(/do not start over and do not go back to discovery/);
  });

  it('and when the corrected force STILL sends no journey, it is Plan', async () => {
    const { noJourney } = refusedThenGood();
    const res = await run([
      toolRound('record_findings', { successCriteria: live().successCriteria, converters: live().converters, barriers: live().barriers }),
      toolRound('propose_strategy', noJourney),
      toolRound('propose_strategy', noJourney),
    ]);
    // ONE correction, then the truth. Nothing is synthesised to make a plan
    // exist — the grep below holds the force block to that.
    expect(res.phase).toBe('planning');
    expect(res.pendingBlueprint ?? null).toBeNull();
    expect(String(res.reply ?? '')).toMatch(PLAN_SENTENCE);
    expect(String(res.reply ?? '')).not.toMatch(/laid out/i);
    expect(turnPhase(res.brief as WorkingBrief, { isBuildTurn: false, limitReached: false })).toBe('ready');
  });

  // THE FORCED CORRECTION IS THE UNFORCED ONE — COMPARED, NOT GREPPED.
  //
  // A grep that `PROPOSE_CORRECTION` appears in the force block proves only
  // that the identifier is nearby. These two cases run the SAME refusal down
  // both paths and compare the `tool_result` that actually reached the wire.
  const correctionSentTo = (res: { sent: Record<string, unknown>[] }) => {
    const last = res.sent[res.sent.length - 1] as { messages: { role: string; content: unknown }[] };
    const blocks = last.messages.flatMap((m) =>
      Array.isArray(m.content) ? (m.content as { type?: string; tool_use_id?: string; id?: string; content?: string }[]) : [],
    );
    const uses = blocks.filter((b) => b.type === 'tool_use');
    const use = uses[uses.length - 1];
    const result = blocks.find((b) => b.type === 'tool_result' && b.tool_use_id === use?.id);
    return { use, result, calls: res.sent.length };
  };

  it('the UNFORCED refusal and the FORCED refusal send the same correction', async () => {
    const { noJourney, withPath } = refusedThenGood();

    // UNFORCED: the refusal happens inside the round loop, so the correction
    // is appended with the rest of that round's results.
    const unforced = await run([
      toolRound('propose_strategy', noJourney),
      toolRound('propose_strategy', withPath),
      proseRound('That is the plan.'),
    ]);
    const u = correctionSentTo({ sent: [...sent] });
    expect(unforced.phase).toBe('awaiting-confirmation');

    // FORCED: the rounds end with prose and no plan, so the plan is asked for
    // directly — and the first forced call is refused.
    const forced = await run([
      toolRound('record_findings', { successCriteria: live().successCriteria, converters: live().converters, barriers: live().barriers }),
      toolRound('propose_strategy', noJourney),
      toolRound('propose_strategy', withPath),
    ]);
    const f = correctionSentTo({ sent: [...sent] });
    expect(forced.phase).toBe('awaiting-confirmation');

    // THE SAME STRING, not merely both containing the word. The error text is
    // identical because the refusal is identical, so the whole content is.
    expect(f.result).toBeTruthy();
    expect(u.result).toBeTruthy();
    expect(String(f.result!.content)).toBe(String(u.result!.content));
    expect(String(f.result!.content)).toMatch(/no journey in it/i);
    expect(String(f.result!.content)).toMatch(/do not start over and do not go back to discovery/);
    // And the result is matched to its own tool_use, or the API rejects it.
    expect(f.result!.tool_use_id).toBe(f.use!.id);
  });

  it('ONE extra forced call, and the second empty journey stays Plan', async () => {
    const { noJourney } = refusedThenGood();
    const res = await run([
      toolRound('record_findings', { successCriteria: live().successCriteria, converters: live().converters, barriers: live().barriers }),
      toolRound('propose_strategy', noJourney),
      toolRound('propose_strategy', noJourney),
    ]);
    // ONE round, then the force, then exactly one correction round: three
    // model calls. It was four while a ready turn could spend a second
    // unforced round; that round is gone, and a third FORCED attempt would
    // still be a loop.
    expect(sent).toHaveLength(3);
    expect(res.phase).toBe('planning');
    expect(res.pendingBlueprint ?? null).toBeNull();
  });

  it('a refused propose says WHAT was refused, not just that it was', async () => {
    // MEASURED, `eval/runs/ui-s-1793017853714` turn 3: two
    // `model.tool_call.failed` events for `propose_strategy`, both carrying
    // `{ tool, kind }` and no input. A refusal with no body cannot be read
    // afterwards — there is no way to see which path was rejected, which is
    // how the wrong correction went unnoticed for two attempts.
    const { noJourney } = refusedThenGood();
    await run([
      toolRound('record_findings', { successCriteria: live().successCriteria, converters: live().converters, barriers: live().barriers }),
      toolRound('propose_strategy', noJourney),
      toolRound('propose_strategy', noJourney),
    ]);
    const failed = emitted.filter(
      (e) => e.type === 'model.tool_call.failed' && (e.data as { tool?: string } | undefined)?.tool === 'propose_strategy',
    );
    expect(failed.length, 'the forced propose was refused').toBeGreaterThan(0);
    for (const e of failed) {
      expect((e.data as { sent?: unknown }).sent, 'the refused payload is on the event').toBeTruthy();
    }
  });

  it('ONE ready round that does not propose, then the force', async () => {
    // MEASURED, `eval/runs/ui-s-1793017853714` turn 3. The record was closed —
    // ticket size retained, converters known, the barrier recorded — and the
    // turn spent round 1 recording findings and asking about prior EMI in the
    // bubble, then round 2 on two hundred characters of "tell me or I will go
    // to the plan". Plan is not a questionnaire.
    const { withPath } = refusedThenGood();
    const res = await run([
      toolRound('record_findings', { successCriteria: live().successCriteria, converters: live().converters, barriers: live().barriers }),
      // The SECOND call is the forced propose. If a second unforced round were
      // still allowed this body would be consumed as prose and the turn would
      // end on Plan.
      toolRound('propose_strategy', withPath),
    ]);
    expect(sent, 'one round, then the force').toHaveLength(2);
    expect(res.phase).toBe('awaiting-confirmation');
    expect(res.pendingBlueprint).toBeTruthy();
  });

  it('but a round of lookups alone is not that force', async () => {
    // Naming a real event, attribute or channel is the work a ready turn is
    // supposed to do before it commits to one, so that round continues.
    const { withPath } = refusedThenGood();
    const res = await run([
      toolRound('list_audience_attributes', {}),
      toolRound('propose_strategy', withPath),
      proseRound('That is the plan.'),
    ]);
    expect(res.phase).toBe('awaiting-confirmation');
    // Three calls: the lookup round, the propose round, and the prose that ends
    // the loop. The propose arrived inside the loop, so nothing was forced.
    expect(sent.length).toBeGreaterThan(2);
  });

  it('the correction is stated once, and the force block invents nothing', () => {
    const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    // ONE DEFINITION of the text, and one of the append that carries it.
    expect(orch).toMatch(/const PROPOSE_CORRECTION =/);
    expect(orch.match(/do not start over and do not go back to discovery/g) ?? []).toHaveLength(1);
    expect(orch.match(/\$\{PROPOSE_CORRECTION\}/g) ?? []).toHaveLength(1);
    expect(orch).toMatch(/export const toolResultBlock = \(/);
    expect(orch).toMatch(/const appendToolExchange = \(/);
    const block = orch.slice(orch.indexOf('const readyWithNoJourney ='), orch.indexOf('// --- interpret the answer'));
    // The force block CALLS the append; it does not write a second one.
    expect(block).toMatch(/appendToolExchange\(forced, outcomes, 'ready'\)/);
    expect(block).not.toMatch(/role: 'assistant'/);
    expect(block).not.toMatch(/type: 'tool_result'/);
    // AT MOST ONE EXTRA CALL, and only for a refusal that filed no path.
    expect(block).toMatch(/attempt < 2/);
    expect(block).toMatch(/attempt > 0 \|\| !refused \|\| landed \|\| !forced\.length/);
    // Still nothing invented on either attempt.
    expect(block).not.toMatch(/steps: \[/);
    expect(block).not.toMatch(/campaignName:/);
  });

  it('the forced propose mirrors the forced build, and invents nothing', () => {
    const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    const block = orch.slice(orch.indexOf('const readyWithNoJourney ='), orch.indexOf('// --- interpret the answer'));
    expect(block).toMatch(/toolChoice: \{ type: 'tool', name: 'propose_strategy' \}/);
    expect(block).toMatch(/outputToolsForPhase\('ready'\)/);
    // Through the one boundary, and nothing synthesised.
    expect(block).toMatch(/applyOutputTool\(brief, tu\.name, tu\.input\)/);
    expect(block).not.toMatch(/steps: \[/);
    expect(block).not.toMatch(/campaignName:/);
    // Not on a build turn, and not while the record is open.
    expect(block).toMatch(/!isBuildTurn && phaseNow\(\) === 'ready'/);
  });

  it('Revise still needs a path, stated once', () => {
    const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    expect(orch).toMatch(/const planOrRevise = \(path: unknown\): 'planning' \| 'revising' =>/);
    expect(orch).toMatch(/shapedBlueprint\(path as never\) \? 'revising' : 'planning'/);
  });

  it('the client shows no Confirm and no canvas on planning', () => {
    const client = readFileSync(new URL('../../src/designer/CampaignDesigner.tsx', import.meta.url), 'utf8');
    // Confirm is still exactly one phase.
    expect(client).toMatch(/\{!busy && phase === 'awaiting-confirmation' && \(/);
    // The preview is driven by the path, and `planning` has none — so nothing
    // is drawn without touching `planOnScreen`.
    expect(client).toMatch(/previewFromBlueprint\(pendingBlueprint\), \[pendingBlueprint\]/);
  });
});

// ONE PLAN REPLY, EVERY EXIT — AND THE HOLD SURVIVES IT.
//
// The Plan sentence was stripped on ONE door (tools-and-prose). The others
// still printed whatever the model wrote, including "I've laid out the 7-day
// plan above" on an empty canvas. Three doors, one lie.
//
// THE APPLICATION DECIDES FROM STATE. `closedReply` asks whether the record is
// settled and whether a shaped path is on file; it matches no phrase. The live
// sentence appears below only as a FIXTURE.
describe('the Plan reply is one rule, shared', () => {
  const knowledge = seedKnowledgeBase();
  const EMI = 'Customers are not converting eligible purchases to EMI. Get more of them converting.';
  /** Live turn-3 prose, verbatim. Fed in, never grepped for in production. */
  const CLAIMED =
    "I've logged the findings and closed out the segmentation question. I've laid out the 7-day plan above. Let me know if you want anything changed.";
  const noPath = (): WorkingBrief =>
    JSON.parse(
      readFileSync(new URL('./support/liveBriefs/ui-s-1792991223125.turn-3.brief.json', import.meta.url), 'utf8'),
    ) as WorkingBrief;

  const sse = (events: Record<string, unknown>[]) =>
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const jsonTurn = (payload: unknown) =>
    sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: JSON.stringify(payload) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 120 } },
    ]);
  const textTurn = (text: string) =>
    sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 90 } },
    ]);

  const run = async (bodies: string[], brief: WorkingBrief) => {
    let i = 0;
    vi.stubGlobal('fetch', async () => {
      const body = bodies[Math.min(i, bodies.length - 1)];
      i += 1;
      return new Response(new TextEncoder().encode(body), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const gen = orchestrateStream({
      sessionId: 'planreply',
      tenantId: 'TEN-IBL',
      knowledge,
      discoveryRounds: 2,
      brief,
      messages: [
        { role: 'user', content: EMI },
        { role: 'user', content: 'not really' },
      ],
      session: { state: 'DISCOVERING', strategyVersion: 0, confirmation: null },
    } as never);
    let out = await gen.next();
    while (!out.done) out = await gen.next();
    return out.value as unknown as Record<string, unknown>;
  };

  const OLD = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.ANTHROPIC_API_KEY = OLD ?? 'test-key-not-real';
  });

  it('JSON ask on a ready turn: Plan, and the rationale does not survive', async () => {
    // `ask_questions` is off the ready tool list — JSON in the message is not,
    // so this is how an ask still arrives on a settled record.
    const res = await run(
      [jsonTurn({ action: 'ask', rationale: CLAIMED, questions: ['Should POS purchases be treated differently?'] })],
      noPath(),
    );
    expect(res.phase).toBe('planning');
    expect(res.pendingBlueprint ?? null).toBeNull();
    expect(res.questions ?? []).toEqual([]);
    expect(String(res.reply)).toMatch(PLAN_SENTENCE);
    expect(String(res.reply)).not.toMatch(/laid out/i);
    expect(turnPhase(res.brief as WorkingBrief, { isBuildTurn: false, limitReached: false })).toBe('ready');
  });

  it('unparsed readable prose on a ready turn: same screen, same rule', async () => {
    const res = await run([textTurn(CLAIMED)], noPath());
    expect(res.phase).toBe('planning');
    expect(String(res.reply)).toMatch(PLAN_SENTENCE);
    expect(String(res.reply)).not.toMatch(/laid out/i);
    expect(res.questions ?? []).toEqual([]);
  });

  it('a HELD turn keeps the hold and loses the claim', async () => {
    // A caption-only propose: the record is settled, the payload is refused
    // for having no real steps, and their prose says the plan is above.
    // Both halves matter — the claim dies, the block survives.
    const captions = {
      action: 'propose',
      strategy: {
        summary: 'Catch them while the purchase is fresh.',
        approach: ['Everyone eligible enters.'],
        strategyOptions: [{ option: 'Experimentation', verdict: 'used', why: 'Cost framing versus deadline framing.' }],
        architectures: [
          { name: 'Catch the moment', barrier: noPath().barriers![0].id, audience: 'All eligible', timing: 'On posting', lever: 'message', journey: 'branch-on-response', chosen: true },
          { name: 'Statement date', barrier: noPath().barriers![0].id, audience: 'The same', timing: 'Later', lever: 'timing', journey: 'linear' },
        ],
        touches: [
          { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Open.', ifStillUnconverted: 'If unread, sooner.' },
          { day: 2, channel: 'SMS', path: 'all', purpose: 'Close.', ifStillUnconverted: 'If read and nothing, stop.' },
        ],
        assumptions: [],
        unknowns: [],
      },
      // Captions, not steps: refused, so nothing is approvable.
      blueprint: { campaignName: 'A', description: 'd', goal: null, entry: { kind: 'audience', entity: 'Card', conditions: [] }, steps: ['Day 0 WhatsApp'] },
      rationale: CLAIMED,
    };
    // PROSE FIRST, THEN THE JSON, in one text block. `proseBefore` cuts at the
    // first `{`, so a message that is nothing but JSON carries no claim at all
    // — my first fixture fed only the payload and the held door had no prose
    // to drop, which made the revert pass. The live shape is a sentence and
    // then the structure.
    const res = await run([textTurn(`${CLAIMED}\n${JSON.stringify(captions)}`), textTurn(CLAIMED)], noPath());

    expect(res.phase).toBe('planning');
    expect(res.pendingBlueprint ?? null).toBeNull();
    expect(res.strategy ?? null).toBeNull();
    // THE CLAIM DIES.
    expect(String(res.reply)).not.toMatch(/laid out/i);
    // AND THE HOLD STAYS. A Plan sentence on its own is a polite dead end:
    // true about the canvas, silent about the thing to change.
    expect(String(res.reply).length).toBeGreaterThan(PLAN_SENTENCE.source.length);
    // PINNED ON THE BLOCK'S OWN REASON, not on a word any plan-ish sentence
    // would contain. `/journey|fork|steps|path/` is satisfied by PLAN_REPLY
    // itself, so swapping the whole reply for the Plan copy — dropping the
    // hold — left this test green. The reason text is the one thing only
    // `renderBlocks` can put here.
    expect(String(res.reply)).toContain('there is nothing for them to approve except the description of one');
  });

  it('the rule is stated once, and reads state rather than words', () => {
    const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    expect(orch).toMatch(/const closedReply = \(path: unknown, theirProse: string, refused/);
    // AND IT READS STATE, NOT WORDS. Asserted on the helper's body rather
    // than by sweeping the file: "the plan above" appears legitimately in the
    // BUILD-turn instruction, where the plan genuinely is above because the
    // manager approved it. A file-wide phrase ban caught that honest sentence,
    // which is why this is scoped.
    const helper = orch.slice(orch.indexOf('const closedReply = ('), orch.indexOf('const proseBefore = ('));
    expect(helper).toMatch(/planOrRevise\(path\)/);
    for (const matching of ['.test(theirProse', '.includes(', '.match(', 'laid out', 'above']) {
      expect(helper, matching).not.toContain(matching);
    }
    // And the forced-call instruction no longer teaches the lie either.
    expect(orch).not.toMatch(/do not say it is above/i);
  });
});

// BRIEF LISTS THE QUESTIONS ONCE.
describe('a numbered list is not restated in the bubble', () => {
  const knowledge = seedKnowledgeBase();
  const EMI = 'Customers are not converting eligible purchases to EMI. Get more of them converting.';
  const THREE = [
    'When you say more conversions, do you mean the count or the value?',
    'Have you noticed any pattern in which customers already convert an eligible purchase on their own?',
    'What do you think is stopping the rest?',
  ];
  const RESTATED = `Three things I need from you before I can design this properly:

1. **What "more conversions" actually means** — count or value?

2. **Which customers already convert** — any pattern you have seen?

3. **What is stopping the rest** — cost, awareness, something else?`;

  const sse = (events: Record<string, unknown>[]) =>
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const toolRound = (tool: string, input: unknown) =>
    sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `b-${tool}`, name: tool, input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 60 } },
    ]);
  const textTurn = (text: string) =>
    sse([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 90 } },
    ]);

  const OLD = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.ANTHROPIC_API_KEY = OLD ?? 'test-key-not-real';
  });

  const firstTurn = async (bodies: string[]) => {
    let i = 0;
    vi.stubGlobal('fetch', async () => {
      const body = bodies[Math.min(i, bodies.length - 1)];
      i += 1;
      return new Response(new TextEncoder().encode(body), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    const gen = orchestrateStream({
      sessionId: 'brieflist',
      tenantId: 'TEN-IBL',
      knowledge,
      discoveryRounds: 0,
      messages: [{ role: 'user', content: EMI }],
      session: { state: 'UNDERSTANDING_GOAL', strategyVersion: 0, confirmation: null },
    } as never);
    let out = await gen.next();
    while (!out.done) out = await gen.next();
    return out.value as unknown as Record<string, unknown>;
  };

  it('asked through the tool and restated as prose: the bubble keeps only the lead-in', async () => {
    const res = await firstTurn([
      toolRound('ask_questions', { questions: THREE.map((text) => ({ text, impact: 'shaping' })) }),
      textTurn(RESTATED),
    ]);
    expect(res.phase).toBe('discovery');
    expect((res.questions as string[]).length).toBeGreaterThan(0);
    // The lead-in survives; the enumeration does not.
    expect(String(res.reply)).toMatch(/Three things I need from you/);
    expect(String(res.reply)).not.toMatch(/^\s*\d[.)]\s/m);
  });

  it('THE RECORD IS CAPPED TOO, not only the response list', async () => {
    // MEASURED, live turn 1: three asked, a fourth injected, the response
    // sliced to three — and the fourth stayed OUTSTANDING on the brief, so the
    // next turn waited for an answer nobody had been shown.
    //
    // THREE QUESTIONS THAT COVER NEITHER FINDING, so the inject genuinely
    // fires. My first fixture used the three that include the converters ask
    // in its own words — which the gap matcher now recognises, so nothing was
    // injected, nothing exceeded three, and removing the cap left the test
    // green. A cap test needs something to cap.
    const NO_FINDINGS = [
      'When you say more conversions, do you mean the count or the value?',
      'Is the seven-day window the same for every eligible purchase?',
      'Do you want a holdout so we can read the lift?',
    ];
    const res = await firstTurn([
      toolRound('ask_questions', { questions: NO_FINDINGS.map((text) => ({ text, impact: 'shaping' })) }),
      textTurn('Three things before I design this.'),
    ]);
    const brief = res.brief as WorkingBrief;
    expect((res.questions as string[]).length).toBeLessThanOrEqual(3);
    // The assertion the old slice would have passed without: the BRIEF.
    const recorded = brief.questions ?? [];
    expect(recorded).toHaveLength(3);
    expect(outstanding(brief)).toHaveLength(3);
    // WHICH THREE, and this is the half a length check cannot see. An
    // inject-then-`slice(0, 3)` drops the INJECTED question — the converters
    // ask, fourth in line — and still records exactly three. That is the
    // original defect with a tidy brief: the gate blocks on converters, so
    // the question it blocks on is the one that has to survive the cap.
    expect(recorded.some((q) => /Who tends to do this already/i.test(q.text))).toBe(true);
    expect(recorded.filter((q) => q.author === 'app')).toHaveLength(1);
    // And a scoreboard question is what gives way, not a finding.
    expect(recorded.map((q) => q.text)).not.toContain(NO_FINDINGS[2]);
  });

  it('does not ask who-converts twice when they asked it in their own words', async () => {
    // `\bwho\b` was the whole test, so "which customers already convert" did
    // not count and the canonical sentence went out as a fourth question
    // about the same gap. Count-versus-value says "convert" and names no
    // subject, so it is still not the converters ask.
    const res = await firstTurn([
      toolRound('ask_questions', { questions: THREE.map((text) => ({ text, impact: 'shaping' })) }),
      textTurn('Three things before I design this.'),
    ]);
    const asked = (res.brief as WorkingBrief).questions!.map((q) => q.text);
    expect(asked.filter((t) => /Who tends to do this already/.test(t))).toHaveLength(0);
    // Both findings are still in the three.
    expect(asked.some((t) => /which customers already convert/i.test(t))).toBe(true);
    expect(asked.some((t) => /stopping the rest/i.test(t))).toBe(true);
  });

  it('their own words count when the subject is "cardholders", not only "customers"', async () => {
    // The matcher names cardholders, purchases, segment, cohort and profile.
    // Only "customers" was pinned, so dropping any of the others stayed
    // green — and a bank's campaign manager says cardholders at least as
    // often. One phrasing per noun is not worth it; this is the one the live
    // vocabulary actually turns on.
    const OWN_WORDS = 'Which cardholders are already converting an eligible purchase on their own?';
    // THE THIRD IS NOT THE BARRIER, deliberately. `THREE[2]` asks what is
    // stopping the rest, so with it in the list BOTH findings are covered and
    // no inject could fire whatever the matcher did — which is why the
    // sibling test above cannot see a suppressed inject and this one has to.
    const NON_FINDING = 'Is the seven-day window the same for every eligible purchase?';
    const res = await firstTurn([
      toolRound('ask_questions', {
        questions: [
          { text: THREE[0], impact: 'shaping' },
          { text: OWN_WORDS, impact: 'shaping' },
          { text: NON_FINDING, impact: 'shaping' },
        ],
      }),
      textTurn('Three things before I design this.'),
    ]);
    const asked = (res.brief as WorkingBrief).questions!.map((q) => q.text);
    expect(asked).toHaveLength(3);
    expect(asked).toContain(OWN_WORDS);
    expect(asked.filter((t) => /Who tends to do this already/i.test(t))).toHaveLength(0);
    // AND THE BARRIER DOES NOT ARRIVE IN ITS PLACE. The barrier IS still
    // missing from the record here, so this is the assertion that keeps the
    // behaviour honest: `nextCustomerQuestion` offers ONE gap per turn and
    // converters is first, so a converters ask they phrased themselves
    // SUPPRESSES the inject — it does not promote the barrier. Both findings
    // staying in the three would be a change to that function, not to the
    // matcher or the cap, and without this pin that change reads as the spec
    // this slice failed to deliver.
    expect(asked.filter((t) => /In your own words/i.test(t))).toHaveLength(0);
    // And the gap is genuinely open, which is what stops the line above from
    // being vacuously true: nothing on the record answers the barrier.
    expect((res.brief as WorkingBrief).barriers ?? []).toHaveLength(0);
  });
});
