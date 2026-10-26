// Confirm crashed, every time, for every conversation.
//
// THE LIVE FAILURE. The manager pressed "Confirm and generate" and got two
// agent bubbles:
//
//   Illegal state transition AWAITING_STRATEGY_CONFIRMATION -> CONFIGURATION_INCOMPLETE.
//   The connection closed before the run finished.
//
// Two defects, one in each half of the stack.
//
// THE SERVER. Generation is two hops — `AWAITING_STRATEGY_CONFIRMATION ->
// GENERATING_CAMPAIGN -> (EXPORT_ELIGIBLE | CONFIGURATION_INCOMPLETE)`. The
// `isBuildTurn` tail took one, and `AWAITING_STRATEGY_CONFIRMATION` legally
// reaches only `GENERATING_CAMPAIGN` — the table calls it "the only door into
// generation" — so `transition` threw. The refinement path had the same skip
// and hid it by assigning the state as a bare string: no throw, and a built
// campaign that never passed through generation. The table is not what was
// wrong; widening it would delete the guarantee it exists to give.
//
// WHY NO TEST CAUGHT IT, and the part worth remembering. There IS a confirm
// path that has always had both hops — the short-circuit guarded by
// `intent === 'confirm' && req.confirmedBlueprint`. Every existing test
// supplies `confirmedBlueprint` directly and therefore walks that one. The
// real client cannot: it sends `confirmedBlueprint: pendingBlueprint`, and a
// propose turn returns `pendingBlueprint: null` BY DESIGN, so the guard never
// passes in the app and every live Confirm fell through to the broken tail.
// A test that passes `confirmedBlueprint` here would prove the path that was
// never in question. This one sends null.
//
// THE CLIENT. `stream.ts` set `sawResult` only on a result frame, so an error
// frame called `onError` and left it false — and when the socket closed the
// fallback fired a second time. That is the second bubble: one real failure,
// one invented, and the invented one read last.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { orchestrateStream, renderBuildSummary, renderStrategy } from '../../server/orchestrator';
import { seedKnowledgeBase } from '../../server/knowledge';
import { canTransition } from '../../server/campaignState';
import { cadenceBlocks } from '../../server/gate';
import { outputToolsForPhase } from '../../server/outputTools';
import { saysBuildNow } from '../../server/record';
import { longestSendPath } from '../../server/journeySummary';
import { newBrief, recordConverters, recordDimensions, recordSuccessCriteria } from '../../server/discovery';
import { decide } from '../../server/gate';
import { discovered, WHY_THEY_DO_NOT } from './support/findings';

const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
const stream = readFileSync(new URL('../../src/designer/stream.ts', import.meta.url), 'utf8');

const sse = (events: Record<string, unknown>[]) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

/**
 * The journey arrives the way the live agent sends it: a `build_campaign`
 * tool call, not a `confirmedBlueprint` on the request.
 *
 * The entry is an audience with no template ids anywhere, which is what makes
 * the build land on CONFIGURATION_INCOMPLETE rather than EXPORT_ELIGIBLE —
 * the outcome the live crash was reporting.
 */
const buildTurn = (steps: unknown[]) =>
  sse([
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'b1', name: 'build_campaign', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify({
          campaignName: 'Activate new cardholders',
          description: 'Fourteen days from issuance.',
          goal: null,
          entry: {
            kind: 'audience',
            entity: 'Card',
            conditions: [{ attribute: 'Status', operator: 'Equals', value: 'Active' }],
          },
          steps,
        }),
      },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 200 } },
  ]);

/**
 * The send, citing the barrier the fixture brief recorded.
 *
 * Without the citation `checkBarrierCoverage` refuses the build and the turn
 * never reaches the tail under test — the check working, and worth knowing:
 * this crash sits BEHIND the design audits, which is part of why it survived.
 */
const send = {
  kind: 'send',
  name: 'Opening nudge',
  objective: ['activate', 'pin'],
  stage: 'first-touch',
  describe: 'Show them the two steps to set a PIN.',
  copy: 'Your card is ready. Set your PIN in two minutes.',
  channelPreference: ['WHATSAPP'],
  barrier: 'cost-perception',
};

/** Complete: every path ends, nothing outstanding but bank ids. */
const COMPLETE = [send, { kind: 'exit', reason: 'Fourteen days are up.' }];

/**
 * Incomplete: a fork that never says what it checks.
 *
 * `{ kind: 'condition' }` with neither delivery outcomes nor an attribute is
 * a step the agent started and did not finish, so the journey reaches the
 * canvas with its configuration unfinished and `exportable` false — the
 * outcome the live crash was reporting when it threw.
 */
const UNFINISHED = [
  send,
  { kind: 'condition', label: 'Did they read it?', yes: [{ ...send, name: 'Follow-up' }], no: [{ kind: 'exit', reason: 'Done.' }] },
];

/**
 * The turn that produced the live failure: a lookup, a record, and prose.
 *
 * This is what a Confirm looked like when it went wrong — the model checked
 * the attribute catalogue, wrote findings down, said "The journey is built"
 * and never called `build_campaign`. Both tool calls matter:
 *
 *  - the LOOKUP is why the empty-round recovery could not fire. It was gated
 *    on `!toolUses.length`, and build turns are allowed to look things up.
 *  - the RECORD is why the turn was not treated as a failure either:
 *    `recordedViaTools` makes prose a success, which is the shape we ask for.
 *
 * The barrier id matches the fixture's, because `recordBarriers` replaces the
 * list and a send citing a barrier that is no longer recorded is refused by
 * `checkBarrierCoverage` before any of this is reached.
 */
const lookupAndRecordTurn = () =>
  sse([
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'l1', name: 'list_audience_attributes', input: {} },
    },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
    { type: 'content_block_stop', index: 0 },
    {
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'r1', name: 'record_findings', input: {} },
    },
    {
      type: 'content_block_delta',
      index: 1,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify({
          barriers: [
            {
              id: 'cost-perception',
              statement: 'Customers believe converting to EMI is expensive.',
              basis: 'user-belief',
              lever: 'message',
              quote: WHY_THEY_DO_NOT,
            },
          ],
        }),
      },
    },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 120 } },
  ]);

const proseTurn = (text: string) =>
  sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 60 } },
  ]);

function script(bodies: string[]) {
  let i = 0;
  vi.stubGlobal('fetch', async () => {
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return new Response(new TextEncoder().encode(body), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
}

const knowledge = seedKnowledgeBase();

/**
 * A brief that has finished discovery, because a Confirm follows one.
 *
 * Without it the gate holds this turn before the build tail is reached and
 * the test proves nothing about the crash — which is itself worth knowing:
 * `isBuildTurn` does not bypass the gate.
 */
const settled = () => {
  let b = discovered(newBrief('Get new cardholders activated.'));
  b = recordDimensions(b, [
    { name: 'Days since the card was issued', rationale: 'Early silence may differ from late.', status: 'retained', basis: 'user' },
  ]);
  return recordSuccessCriteria(b, ['More new cardholders setting a PIN within two weeks.']);
};

/** A Confirm exactly as the client sends one: no `confirmedBlueprint`. */
async function confirm(steps: unknown[] = COMPLETE, withBrief?: unknown) {
  script([buildTurn(steps), proseTurn('Built.')]);
  const gen = orchestrateStream({
    sessionId: 'confirm-crash',
    tenantId: 'TEN-IBL',
    knowledge,
    discoveryRounds: 3,
    brief: withBrief ?? settled(),
    intent: 'confirm',
    // THE WHOLE POINT. The client has nothing to send here, because a propose
    // turn carries no blueprint. Supplying one takes the short-circuit and
    // tests a path the app never walks.
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

const OLD = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.ANTHROPIC_API_KEY = OLD ?? 'test-key-not-real';
});

describe('the fixture is a real post-discovery Confirm', () => {
  it('has a brief the gate lets through, so the build tail is reached', () => {
    // `isBuildTurn` does NOT bypass the gate. An unsatisfied brief holds the
    // turn in discovery and the crash never gets a chance to happen.
    expect(decide(settled()).proceed).toBe(true);
  });
});

describe('the state machine still forbids the skip', () => {
  it('allows only generation out of a confirmation', () => {
    // If this ever loosens, the fix below is decoration: the point is that a
    // campaign cannot exist without having been generated.
    expect(canTransition('AWAITING_STRATEGY_CONFIRMATION', 'GENERATING_CAMPAIGN')).toBe(true);
    expect(canTransition('AWAITING_STRATEGY_CONFIRMATION', 'CONFIGURATION_INCOMPLETE')).toBe(false);
    expect(canTransition('AWAITING_STRATEGY_CONFIRMATION', 'EXPORT_ELIGIBLE')).toBe(false);
    expect(canTransition('GENERATING_CAMPAIGN', 'CONFIGURATION_INCOMPLETE')).toBe(true);
    expect(canTransition('GENERATING_CAMPAIGN', 'EXPORT_ELIGIBLE')).toBe(true);
  });
});

describe('a live Confirm reaches a built campaign without throwing', () => {
  it('does not throw, and does not report an illegal transition', async () => {
    const res = await confirm();
    expect(String(res.reply ?? '')).not.toMatch(/Illegal state transition/);
    expect(res.phase).not.toBe('error');
  });

  it('lands on CONFIGURATION_INCOMPLETE, having passed through generation', async () => {
    // The outcome the live crash was reporting. A fork with a path that goes
    // nowhere leaves the configuration unfinished, so the build is not
    // exportable.
    const res = await confirm(UNFINISHED);
    const session = res.session as { state: string; confirmation: unknown };
    expect(res.exportable).toBe(false);
    expect(session.state).toBe('CONFIGURATION_INCOMPLETE');
    // Reaching that state from AWAITING_STRATEGY_CONFIRMATION is only legal
    // via GENERATING_CAMPAIGN, so arriving here at all proves the hop.
    expect(canTransition('AWAITING_STRATEGY_CONFIRMATION', session.state as never)).toBe(false);
    expect(res.graph, 'a journey still reaches the canvas').toBeTruthy();
    expect(session.confirmation).toBeTruthy();
  });

  it('takes the same hop to the complete outcome', async () => {
    // Both doors out of GENERATING_CAMPAIGN, so neither can regress to one
    // hop while the other stays covered.
    const res = await confirm(COMPLETE);
    const session = res.session as { state: string };
    expect(res.exportable).toBe(true);
    expect(session.state).toBe('EXPORT_ELIGIBLE');
    expect(canTransition('AWAITING_STRATEGY_CONFIRMATION', session.state as never)).toBe(false);
  });

  it('actually built the journey, rather than failing quietly', async () => {
    const res = await confirm();
    expect(res.graph).toBeTruthy();
    expect(res.campaign).toBeTruthy();
  });

  it('takes both hops in source, on the build tail and on a refinement', () => {
    // The refinement path assigned the state as a bare string, which skipped
    // the throw AND the state. Both go through `transition` now.
    const hops = orch.match(/transition\(session\.state, 'GENERATING_CAMPAIGN'\)/g) ?? [];
    expect(hops.length, 'confirm short-circuit, build tail, refinement').toBe(3);
    expect(orch).not.toMatch(/state: out\.exportable \? 'EXPORT_ELIGIBLE' : 'CONFIGURATION_INCOMPLETE'/);
    expect(orch).toMatch(/state: transition\(session\.state, out\.exportable \? 'EXPORT_ELIGIBLE' : 'CONFIGURATION_INCOMPLETE'\)/);
  });
});

describe('an error frame ends the run, so one failure is reported once', () => {
  it('treats error as terminal, not only result', () => {
    expect(stream).toMatch(/let sawTerminal = false;/);
    // Code only: the comment above it names the field it replaced, which is
    // the record of why this exists.
    const code = stream.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/sawResult/);
    // Both doors set it.
    const errorBranch = stream.slice(stream.indexOf("kind === 'error'"), stream.indexOf("kind === 'error'") + 160);
    expect(errorBranch).toMatch(/sawTerminal = true;/);
  });

  it('fires the fallback only when NEITHER frame arrived', () => {
    expect(stream).toMatch(/if \(!sawTerminal\) handlers\.onError\('The connection closed before the run finished\.'\)/);
  });

  it('keeps the fallback, because a silent stream must not read as success', () => {
    expect(stream).toMatch(/A stream that ends without a terminal frame is a failure/);
  });
});

// A campaign with no messages was never built.
//
// THE LIVE FAILURE, the same Confirm as above once it stopped throwing:
//
//   "Built the journey: 0 message steps, 4 steps in total. It is on the
//    canvas now."
//
// Under a canvas holding an entry, an experiment and two exits. Twelve
// designed steps had been dropped by the compiler and the summary announced a
// success. The compiler bugs are fixed, which makes this a safety net rather
// than the main event — it stays because the rule does: never say a thing was
// built when it was not.
describe('the build summary does not claim a canvas it has not got', () => {
  const report = {
    outcome: 'passed' as const,
    checks: [],
    unverifiedHardConstraints: [],
  };
  const summary = (nodes: Record<string, { type: string }>, over: Record<string, unknown> = {}) =>
    renderBuildSummary(
      null,
      { graph: { nodes }, issues: [], sendProposals: [], ...over } as never,
      report as never,
      0,
      false,
    );

  it('says so plainly when nothing was messaged', () => {
    const out = summary({ a: { type: 'ENTRY_SEGMENT' }, b: { type: 'RANDOM_SPLIT' }, c: { type: 'EXIT' }, d: { type: 'EXIT' } });
    expect(out).not.toMatch(/on the canvas now/i);
    expect(out).toMatch(/did not produce any message steps/i);
  });

  it('still says it was built when it was', () => {
    const out = summary({ a: { type: 'ENTRY_SEGMENT' }, b: { type: 'SEND' }, c: { type: 'EXIT' } });
    expect(out).toMatch(/on the canvas now/i);
    expect(out).toMatch(/1 message step/);
  });

  it('shows what the platform could not express, rather than dropping it silently', () => {
    // `limitations` was computed, returned, and never rendered — so a journey
    // that quietly filtered on less than was asked for looked complete. It is
    // also the capability backlog, which only works if somebody reads it.
    const out = summary(
      { a: { type: 'ENTRY_SEGMENT' }, b: { type: 'SEND' } },
      { limitations: [{ attribute: 'PIN Set', note: 'Card has no such attribute.' }] },
    );
    expect(out).toMatch(/Platform cannot express yet/);
    expect(out).toMatch(/PIN Set/);
  });
});

// A plan with no named sends is not a plan a manager can approve.
//
// THE LIVE FAILURE, 2026-10-22. A fourteen-day activation proposal described
// "a staggered multi-touch sequence over the full 14 days, spaced by
// read/response rather than a fixed clock" and listed not one message. The
// manager approved a cadence they could not see, and the build turn then
// invented it from that sentence. Under-dosing is invisible in prose: three
// touches and nine read the same.
//
// NO WINDOW IS PARSED to decide this. There is no structured window on the
// brief — "14 days" lives only inside free text — and reading a number out of
// prose to RAISE a block would break the rule the application runs on
// (`record.ts`: a judgement about someone's words may only ever release a
// block, never create one). The requirement is unconditional instead, and the
// tool schema carries most of it with `minItems: 2`.
describe('a proposal has to name its sends', () => {
  const plan = (touches?: unknown[]) => ({
    strategy: {
      summary: 'Fourteen days from issuance.',
      approach: [],
      assumptions: [],
      unknowns: [],
      ...(touches ? { touches } : {}),
    },
  });
  const touch = (day: number, path = 'all') => ({
    day,
    channel: 'WhatsApp',
    path,
    purpose: 'Prompt the PIN.',
    ifStillUnconverted: 'Try SMS next.',
  });

  it('refuses a plan that describes a cadence and names none of it', () => {
    const blocks = cadenceBlocks(plan() as never);
    expect(blocks.map((b) => b.code)).toEqual(['cadence-unnamed']);
    expect(blocks[0].reason).toMatch(/does not say when the messages go out/);
  });

  it('refuses a single touch on the main path', () => {
    expect(cadenceBlocks(plan([touch(0)]) as never).map((b) => b.code)).toEqual(['cadence-unnamed']);
  });

  it('accepts a real sequence, with a lighter named path beside it', () => {
    // Four on the primary path at days 0, 3, 7 and 13, and two for the group
    // that mostly acts unprompted. The lighter path is NAMED rather than
    // assumed, which is the rule segmentation already runs on.
    const touches = [
      touch(0), touch(3), touch(7), touch(13),
      touch(2, 'High limit'), touch(10, 'High limit'),
    ];
    expect(cadenceBlocks(plan(touches) as never)).toEqual([]);
  });

  it('refuses a thin path hiding behind a busier one', () => {
    // REVERSED, 2026-10-22, and the assertion it replaces was the live
    // failure written down as a rule. It read "measures the BUSIEST path, so
    // a light path cannot stand in for the cadence" and expected this exact
    // mix to PASS.
    //
    // Read against the run: "High limit" is the cohort that mostly activates
    // unprompted, and it got two nudges. "Everyone else" — the people the
    // campaign exists for — got one send, and because the busier path
    // satisfied the gate, nothing ever looked at them.
    const touches = [touch(0, 'High limit'), touch(10, 'High limit'), touch(0, 'Everyone else')];
    const blocks = cadenceBlocks(plan(touches) as never);
    expect(blocks.map((b) => b.code)).toEqual(['cadence-unnamed']);
    // Named, so the manager knows WHICH group is being under-served.
    expect(blocks[0].reason).toMatch(/"Everyone else"/);
    expect(blocks[0].reason).not.toMatch(/High limit/);
  });

  it('refuses a thin LIGHT path too, when the main one is fine', () => {
    // The mirror case. Lighter still means a mid-window touch and a last
    // chance; a single row is not a sequence whichever group it belongs to.
    const touches = [touch(0), touch(3), touch(7), touch(13), touch(2, 'High limit')];
    const blocks = cadenceBlocks(plan(touches.map((t, i) => (i < 4 ? { ...t, path: 'Everyone else' } : t))) as never);
    expect(blocks.map((b) => b.code)).toEqual(['cadence-unnamed']);
    expect(blocks[0].reason).toMatch(/"High limit"/);
  });

  it('accepts two real sequences side by side', () => {
    const touches = [
      touch(0, 'Everyone else'), touch(3, 'Everyone else'), touch(7, 'Everyone else'), touch(13, 'Everyone else'),
      touch(2, 'High limit'), touch(10, 'High limit'),
    ];
    expect(cadenceBlocks(plan(touches) as never)).toEqual([]);
  });

  it('never demands two sends for a holdout, because a holdout is not a path', () => {
    // `touches` lists customer-facing sends, so an arm that is deliberately
    // not messaged contributes no rows and cannot be caught by this rule.
    const touches = [touch(0), touch(3), touch(13)];
    expect(cadenceBlocks(plan(touches) as never)).toEqual([]);
  });

  it('names what would clear it, like every other block', () => {
    const [block] = cadenceBlocks(plan() as never);
    expect(block.clears).toMatchObject({ field: 'touches' });
    expect(block.clears.how).toMatch(/day, channel, path/);
  });

  it('is not re-litigated on the turn that builds the approved plan', () => {
    // `building` is true on Confirm and refinement. Refusing there is both
    // useless and insulting: there is nothing the manager can do about a
    // missing field from the build turn, and the moment to say so was before
    // they agreed.
    const brief = settled();
    expect(decide(brief, { proposed: plan() as never, building: true }).blocks.map((b) => b.code))
      .not.toContain('cadence-unnamed');
    expect(decide(brief, { proposed: plan() as never }).blocks.map((b) => b.code))
      .toContain('cadence-unnamed');
  });

  it('shows the manager the sequence, not just a timing sentence', () => {
    const out = renderStrategy({
      summary: 'Fourteen days from issuance.',
      approach: [],
      assumptions: [],
      unknowns: [],
      touches: [touch(0), touch(3), touch(7), touch(13), touch(2, 'High limit')],
    } as never);
    expect(out).toMatch(/\*\*The sequence\*\*/);
    for (const day of [0, 3, 7, 13]) expect(out, `day ${day}`).toContain(`Day ${day}, WhatsApp`);
    // The lighter path is visible as its own group, so "they get fewer" is a
    // claim the manager can check rather than take on trust.
    expect(out).toMatch(/\*High limit\*/);
    expect(out).toMatch(/If it does not land: Try SMS next\./);
  });
});

// What a customer experiences is ONE route, so that is what gets compared.
//
// The first version of this check compared the number of approved touches
// against every SEND node in the graph. Those are not the same measure: a
// two-arm wording experiment builds the same skeleton twice, so four approved
// touches become eight SEND nodes and the banner reported a four-message
// shortfall on a perfectly correct build. A banner that cries drift when
// nothing drifted teaches people to ignore it, which is worse than no banner.
describe('Confirm compares path density, not totals', () => {
  /** A linear chain of n sends, as the reducer would wire it. */
  const chain = (n: number) => {
    const nodes: Record<string, { type: string }> = { root: { type: 'ENTRY_SEGMENT' } };
    const edges: { from: string; to: string | null }[] = [];
    let prev = 'root';
    for (let i = 0; i < n; i++) {
      nodes[`s${i}`] = { type: 'SEND' };
      edges.push({ from: prev, to: `s${i}` });
      prev = `s${i}`;
    }
    return { rootId: 'root', nodes, edges };
  };

  const summaryFor = (touches: unknown[], graph: unknown) =>
    renderBuildSummary(
      { summary: 's', approach: [], assumptions: [], unknowns: [], touches } as never,
      { graph, issues: [], sendProposals: [] } as never,
      { outcome: 'passed', checks: [], unverifiedHardConstraints: [] } as never,
      0,
      false,
    );

  it('reports a genuine shortfall instead of coercing the graph', () => {
    const out = summaryFor([{ day: 0 }, { day: 3 }, { day: 7 }], chain(1));
    expect(out).toMatch(/names 3 messages on its fullest path and the journey was built with 1/);
    expect(out).toMatch(/which ones are missing/);
  });

  it('does NOT cry drift when an experiment repeats the same skeleton', () => {
    // Four approved touches; two arms, each send-wait-send-wait-send-wait-send.
    // Eight SEND nodes, longest path four. That is agreement.
    const nodes: Record<string, { type: string }> = {
      root: { type: 'ENTRY_SEGMENT' },
      split: { type: 'RANDOM_SPLIT' },
    };
    const edges: { from: string; to: string | null }[] = [
      { from: 'root', to: 'split' },
    ];
    for (const arm of ['a', 'b']) {
      let prev = 'split';
      for (let i = 0; i < 4; i++) {
        nodes[`${arm}s${i}`] = { type: 'SEND' };
        edges.push({ from: prev, to: `${arm}s${i}` });
        prev = `${arm}s${i}`;
        if (i < 3) {
          nodes[`${arm}w${i}`] = { type: 'PAUSE' };
          edges.push({ from: prev, to: `${arm}w${i}` });
          prev = `${arm}w${i}`;
        }
      }
    }
    const out = summaryFor([{ day: 0 }, { day: 3 }, { day: 7 }, { day: 13 }], { rootId: 'root', nodes, edges });
    expect(Object.values(nodes).filter((n) => n.type === 'SEND')).toHaveLength(8);
    expect(out).not.toMatch(/on its longest path/);
  });

  it('still reports when four approved touches became one linear send', () => {
    const out = summaryFor([{ day: 0 }, { day: 3 }, { day: 7 }, { day: 13 }], chain(1));
    expect(out).toMatch(/names 4 messages on its fullest path and the journey was built with 1/);
  });

  it('says nothing when they agree', () => {
    expect(summaryFor([{ day: 0 }, { day: 3 }], chain(2))).not.toMatch(/on its longest path/);
  });

  it('measures the FULLEST path of the plan, not the total rows', () => {
    // Six rows, but no single customer gets more than four.
    const touches = [
      { day: 0, path: 'Everyone else' }, { day: 3, path: 'Everyone else' },
      { day: 7, path: 'Everyone else' }, { day: 13, path: 'Everyone else' },
      { day: 2, path: 'High limit' }, { day: 10, path: 'High limit' },
    ];
    expect(summaryFor(touches, chain(4))).not.toMatch(/on its longest path/);
  });

  it('does not recount a tail two branches share', () => {
    // Fan-in is real here — the builder has a "Reused in N places" badge for
    // it. A walk that recounted the shared ending would inflate the density
    // and report drift that is not there.
    const nodes = {
      root: { type: 'ENTRY_SEGMENT' },
      split: { type: 'SPLIT' },
      yes: { type: 'SEND' },
      no: { type: 'SEND' },
      shared: { type: 'SEND' },
    };
    const edges = [
      { from: 'root', to: 'split' },
      { from: 'split', to: 'yes' },
      { from: 'split', to: 'no' },
      { from: 'yes', to: 'shared' },
      { from: 'no', to: 'shared' },
    ];
    expect(longestSendPath({ rootId: 'root', nodes, edges })).toBe(2);
  });

  it('terminates on a cycle rather than hanging the turn', () => {
    const nodes = { root: { type: 'ENTRY_SEGMENT' }, a: { type: 'SEND' }, b: { type: 'SEND' } };
    const edges = [
      { from: 'root', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ];
    expect(longestSendPath({ rootId: 'root', nodes, edges })).toBeGreaterThan(0);
  });

  it('ignores the application\'s own goal terminal', () => {
    const nodes = { root: { type: 'ENTRY_SEGMENT' }, s: { type: 'SEND' }, g: { type: 'GOAL_EXIT' } };
    const edges = [{ from: 'root', to: 's' }, { from: 's', to: 'g' }];
    expect(longestSendPath({ rootId: 'root', nodes, edges })).toBe(1);
  });
});

// "I cannot build this. My role stops at proposing."
//
// THE LIVE FAILURE, after the compiler crash was fixed. The manager pressed
// Confirm and the agent replied that it could not build, that its role
// stopped at proposing, and that the tool was not available to it. No
// canvas. The compiler never ran.
//
// It was reading exactly what we sent. On that one turn it received, all at
// once:
//
//   - `tool_choice: 'none'` — a rule written to stop catalogue re-fetches,
//     which also forbade `build_campaign`;
//   - `propose_strategy`, whose own description says "Do not call
//     build_campaign in the same turn";
//   - a prompt line asking it to "Return ONLY {action:'propose', blueprint}"
//     as text rather than call the tool;
//   - a SYSTEM prompt saying deterministic code builds the graph.
//
// Four instructions, three of them saying do not build. The honest reading
// of that is the reply it gave.
describe('a Confirm turn can actually build', () => {
  const orchSrc = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');

  it('never forbids every tool on a build turn', () => {
    // The withdrawal is about LOOKUPS. A build turn keeps its one tool.
    expect(orchSrc).toMatch(/const withdrawLookups = stopLookingUp && !isBuildTurn;/);
    expect(orchSrc).toMatch(/toolChoice: withdrawLookups\s*\?\s*\{ type: 'none' \}/);
  });

  it('forces the build once there is nothing left to look up', () => {
    // A turn whose entire purpose is to build has nothing else to decide.
    expect(orchSrc).toMatch(/\{ type: 'tool', name: 'build_campaign' \}/);
  });

  it('keeps lookups available until they are exhausted, then drops only them', () => {
    // The output tools always travel. Sending a history of tool_use and
    // tool_result blocks with NO tools attached made the model answer with
    // an empty turn and killed three evaluation scenarios — that is the
    // failure this must not reintroduce.
    expect(orchSrc).toMatch(/\.\.\.\(stopLookingUp \? \[\] : toolsForPhase\(phase !== 'asking' \|\| designSeen\)\)/);
    expect(orchSrc).toMatch(/\.\.\.outputToolsForPhase\(phase\),/);
  });

  it('does not offer to propose the plan the manager already approved', () => {
    const confirmTools = outputToolsForPhase('build').map((t) => t.name);
    expect(confirmTools).not.toContain('propose_strategy');
    expect(confirmTools).toContain('build_campaign');
    // The record tools stay: a build turn still finds things worth writing
    // down, and losing them would empty the record on the last turn.
    expect(confirmTools).toContain('record_findings');
    // And proposing belongs to the READY turn — not to an asking turn, where
    // offering a plan tool in order to refuse it cost two live conversations.
    expect(outputToolsForPhase('ready')).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'propose_strategy' })]),
    );
    expect(outputToolsForPhase('ready').map((t) => t.name)).not.toContain('build_campaign');
    expect(outputToolsForPhase('asking').map((t) => t.name)).not.toContain('build_campaign');
    expect(outputToolsForPhase('asking').map((t) => t.name)).not.toContain('propose_strategy');
  });

  it('asks for the tool, not for a blueprint pasted into the message', () => {
    expect(orchSrc).toMatch(/CALL build_campaign NOW/);
    expect(orchSrc).toMatch(/never tell them the build is unavailable to you/);
    expect(orchSrc).not.toMatch(/Return ONLY \{"action":"propose","strategy"/);
  });

  it('recovers a build turn by building, not by explaining', () => {
    // MOVED out of the empty-round recovery, 2026-10-22. That recovery was
    // gated on `!toolUses.length`, so a Confirm that looked anything up — which
    // build turns are allowed to do — could never reach it.
    expect(orchSrc).toMatch(/if \(isBuildTurn && !toolBlueprint\) \{/);
    expect(orchSrc).toMatch(/Your previous turn did not build the campaign/);
    expect(orchSrc).toMatch(/toolChoice: \{ type: 'tool', name: 'build_campaign' \},/);
  });

  it('APPLIES what the forced build returns, which the old one did not', () => {
    // THE DEFECT THIS PINS. The previous forced build read `chunk.text` and
    // `chunk.done` and then broke out of the loop. `chunk.toolUse` was never
    // collected, so the `build_campaign` call it had just forced was discarded
    // unread and `toolBlueprint` stayed null. It forced a build and threw the
    // result away, which is indistinguishable from never having asked.
    //
    // Three things have to be true together, so the block cannot half-work:
    // collect the tool use, run it through the one boundary that turns model
    // output into application state, and keep the blueprint.
    const block = orchSrc.slice(
      orchSrc.indexOf('if (isBuildTurn && !toolBlueprint) {'),
      orchSrc.indexOf('// A PLAN THE MANAGER ACTUALLY APPROVED'),
    );
    expect(block).toMatch(/if \(chunk\.toolUse\) forced\.push\(chunk\.toolUse\);/);
    // THE HANDLER TAKES NO PHASE, and no longer needs one: `propose_strategy`
    // is simply absent from a turn that may not propose, so there is nothing
    // left for it to decide from the brief.
    expect(block).toMatch(/applyOutputTool\(brief, tu\.name, tu\.input\)/);
    expect(block).toMatch(/if \(applied\.blueprint\) toolBlueprint = applied\.blueprint;/);
  });

  it('never dresses a failed build as a success', () => {
    // An approved plan with no journey is an error return, not the discovery
    // pane and not a graph. The live symptom was the opposite: the model's
    // "The journey is built…" printed beside the brief, with no graph in the
    // response at all.
    const block = orchSrc.slice(
      orchSrc.indexOf('// AN APPROVED PLAN THAT PRODUCED NO JOURNEY IS A FAILURE'),
      orchSrc.indexOf('// THE RECORD MOVED, SO THE TURN WORKED.'),
    );
    expect(block).toMatch(/phase: 'error'/);
    expect(block).toMatch(/graph: null/);
    expect(block).toMatch(/The journey could not be built from the approved plan/);
    expect(block).not.toMatch(/phase: 'discovery'/);
  });

  it('does not let the gate throw away an approved build', () => {
    // The second half of the same failure. The forced build gets a journey;
    // `if (!decision.proceed)` sat in front of the build tail and could still
    // discard it — and did, on a live Confirm, over `belief-untested`.
    expect(orchSrc).toMatch(/if \(!decision\.proceed && !approvedPlan\) \{/);
    // Narrow by construction: a typed "Confirmed. Build this campaign." during
    // discovery has no approved plan behind it and is still held.
    expect(orchSrc).toMatch(/\(req\.intent \?\? 'converse'\) === 'confirm' \|\| isRefinement \|\| session\.state === 'AWAITING_STRATEGY_CONFIRMATION'/);
    // NOT `req.confirmedStrategy`. The client reads `next.pendingStrategy` off
    // the response, no response has ever carried that field, so what it posts
    // back is always empty. Keying the branch on it would have made it a no-op
    // in the app while passing any test that supplied the field by hand.
    expect(orchSrc).not.toMatch(/approvedPlan = isBuildTurn && \(!!req\.confirmedStrategy/);
    // And the cost is carried, not dropped: a skipped refusal that said
    // nothing would lose the gap on the one turn that produces a campaign.
    expect(orchSrc).toMatch(/if \(!decision\.proceed && approvedPlan\) \{/);
    expect(orchSrc).toMatch(/designWarnings: \[\.\.\.\(strategy\.designWarnings \?\? \[\]\), \.\.\.carried\]/);
  });

  it('treats the typed sentence exactly like the button', async () => {
    // The button posts `intent: 'confirm'` AND the words. Someone who types
    // the words — reasonably, since they are on screen in their own
    // transcript — sent no intent, and the turn quietly became a
    // conversation about a plan they had just approved.
    expect(saysBuildNow('Confirmed. Build this campaign.')).toBe(true);
    expect(saysBuildNow('  confirmed. build this campaign.  ')).toBe(true);
    // NOT a loose match. `saysProceed` is deliberately generous because a
    // false positive there costs a stated assumption; starting a BUILD on a
    // loose match is a different risk entirely.
    expect(saysBuildNow('do not build it yet')).toBe(false);
    expect(saysBuildNow('go ahead')).toBe(false);
    expect(orchSrc).toMatch(/isRefinement \|\| saysBuildNow\(latestUserText\)/);
  });

  it('builds on the typed sentence with no intent set', async () => {
    script([buildTurn(COMPLETE), proseTurn('Built.')]);
    const gen = orchestrateStream({
      sessionId: 'typed-confirm',
      tenantId: 'TEN-IBL',
      knowledge,
      discoveryRounds: 3,
      brief: settled(),
      // No `intent` at all — this is the composer, not the button.
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
    const res = out.value as unknown as Record<string, unknown>;
    expect(res.graph, 'the typed sentence must reach the compiler').toBeTruthy();
    expect((res.session as { state: string }).state).toBe('EXPORT_ELIGIBLE');
  });
});

// One track, because they said one track.
//
// THE LIVE FAILURE. On an EMI campaign the manager said every eligible
// purchase, one track, do not split. Confirm refused:
//
//   "Nobody could say which customers convert today, so this campaign has to
//    find out… Separate the candidate segments"
//
// and asked "Which groups should this campaign treat differently, so we can
// see who actually converts?" — the exact question discovery was rewritten
// never to ask, arriving at the moment the manager has least power to refuse
// it.
//
// `mustLearnAudience` is true whenever converters are not `known`, and
// `checkAudienceLearning` then refused any flat journey. A design rule that
// overrules an explicit instruction is not a rule; it is the application
// designing the campaign. It also contradicts the segmentation principle
// outright — a dimension changes the PATH, and they had said there is no
// dimension.
//
// The cost is real and is still reported. It is a limitation now, not a veto.
describe('an unknown audience is a limitation, not a refusal', () => {
  const unknownConverters = () => {
    let b = settled();
    b = recordConverters(b, {
      shape: 'Nobody can say which customers convert today.',
      basis: 'user',
      knowledge: 'unknown',
      candidates: [
        { segment: 'Large-ticket buyers', restsOn: 'purchase size', why: 'A bigger balance costs more to carry.' },
        { segment: 'Helpline callers', restsOn: 'called the helpline', why: 'They already asked about repayment.' },
      ],
    });
    return b;
  };

  it('builds the one-track journey they asked for', async () => {
    const res = await confirm(COMPLETE, unknownConverters());
    expect(res.graph, 'a flat journey must still reach the canvas').toBeTruthy();
    expect(res.phase).not.toBe('discovery');
  });

  it('never asks which groups to treat differently', async () => {
    // The question itself is the defect. Discovery does not ask the manager
    // to pick a targeting group out of guesses, and Confirm must not either.
    const res = await confirm(COMPLETE, unknownConverters());
    const asked = ((res.questions ?? []) as string[]).join(' ');
    expect(asked).not.toMatch(/treat differently/i);
    expect(String(res.reply)).not.toMatch(/Separate the candidate segments/i);
  });

  it('still says what the flat journey costs', async () => {
    // Downgrading the guard must not delete the finding: a campaign that
    // cannot tell its audiences apart returns one undifferentiated number.
    const res = await confirm(COMPLETE, unknownConverters());
    const brief = res.brief as { verdicts?: { warnings?: string[] }[] };
    const onBrief = (brief.verdicts ?? []).flatMap((v) => v.warnings ?? []).join(' ');
    expect(onBrief, 'recorded on the brief').toMatch(/convert/i);
    // And SHOWN. A cost recorded where nobody reads it has been dropped.
    const shown = ((res.strategy as { designWarnings?: string[] })?.designWarnings ?? []).join(' ');
    expect(shown, 'printed under "What this design cannot do"').toMatch(/convert/i);
  });

  it('the source no longer returns discovery for an audience gap', () => {
    const orchSrc = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    expect(orchSrc).not.toMatch(/Which groups should this campaign treat differently/);
    expect(orchSrc).toMatch(/A FLAT JOURNEY IS A COST, NOT A REFUSAL/);
  });
});

// ---------------------------------------------------------------------------
// 2026-10-22 — the Confirm that looked things up, wrote prose, and built
// nothing.
//
// THE LIVE FAILURE, and it is a different one from the crash above. The model
// replied "The journey is built…" and the left pane stayed on "What I have so
// far". No graph in the response. The activity panel showed lookups.
// Underneath the sentence, gate text: "That settled one of the things I was
// waiting on", plus a `belief-untested` block about a PIN/app dimension the
// manager had explicitly rejected.
//
// The canvas draws `res.graph` and there was none, because the compiler never
// ran. A real build says "It is on the canvas now" from `renderBuildSummary`;
// the agent's own prose is not evidence that a campaign exists.
// ---------------------------------------------------------------------------

/** A Confirm with a scripted sequence of model turns. */
async function confirmScripted(bodies: string[], brief?: unknown) {
  script(bodies);
  const gen = orchestrateStream({
    sessionId: 'confirm-prose',
    tenantId: 'TEN-IBL',
    knowledge,
    discoveryRounds: 3,
    brief: brief ?? settled(),
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

/** The exact prose that was accepted as a built campaign. Deliberately not
 *  containing any wording `renderBuildSummary` produces, so a test cannot
 *  pass by finding the model's sentence and calling it the summary. */
const FALSE_SUCCESS = 'The journey is built and running from today.';

describe('a Confirm that looks things up and forgets to build still builds', () => {
  it('ends with a graph, not with the brief pane', async () => {
    const res = await confirmScripted([
      lookupAndRecordTurn(),
      proseTurn(FALSE_SUCCESS),
      buildTurn(COMPLETE),
      proseTurn('Built.'),
    ]);
    expect(res.graph, 'the journey has to reach the canvas').toBeTruthy();
    expect(res.phase).not.toBe('discovery');
    expect(res.stage).not.toBe('discovery');
    expect(res.campaign).toBeTruthy();
  });

  it('does not pass the model prose off as the build', async () => {
    const res = await confirmScripted([
      lookupAndRecordTurn(),
      proseTurn(FALSE_SUCCESS),
      buildTurn(COMPLETE),
      proseTurn('Built.'),
    ]);
    // The reply is the application's own account of what it built. The
    // model's claim is not it.
    expect(String(res.reply ?? '')).not.toBe(FALSE_SUCCESS);
    expect(String(res.reply ?? '')).toMatch(/canvas/i);
  });

  it('reports a failure, not a success, when no journey comes back at all', async () => {
    // The forced build is asked for and the model still does not call the
    // tool. There is nothing to compile, so the honest answer is the one the
    // compiler's own failure gives — never a graph and never the brief pane.
    const res = await confirmScripted([
      lookupAndRecordTurn(),
      proseTurn(FALSE_SUCCESS),
      proseTurn('I cannot do that.'),
      proseTurn('I cannot do that.'),
    ]);
    expect(res.phase).toBe('error');
    expect(res.graph ?? null).toBeNull();
    expect(String(res.reply ?? '')).toMatch(/could not be built from the approved plan/);
    expect(res.brief, 'the record survives a failure').toBeTruthy();
  });

  it('builds through a block the gate would have refused, and says what it cost', async () => {
    // The second half of the live failure. `success-unsettled` stands in for
    // `belief-untested`: both are blocks that were raised on the propose turn,
    // and refusing on the Confirm leaves the manager with an approval that
    // did nothing and nothing they can do about it.
    const held = discovered(newBrief('Get new cardholders activated.'));
    expect(decide(held).proceed, 'fixture must actually be held').toBe(false);
    const res = await confirmScripted(
      [lookupAndRecordTurn(), proseTurn(FALSE_SUCCESS), buildTurn(COMPLETE), proseTurn('Built.')],
      held,
    );
    expect(res.graph, 'an approved build is not thrown away by the gate').toBeTruthy();
    expect(res.phase).not.toBe('discovery');
    // And the cost is on the record rather than silently dropped.
    const verdicts = (res.brief as { verdicts?: { warnings: string[] }[] }).verdicts ?? [];
    const said = verdicts.flatMap((v) => v.warnings).join(' ');
    const reasons = decide(held).blocks.map((b) => b.reason);
    expect(reasons.length).toBeGreaterThan(0);
    expect(said, 'every block the gate stopped refusing must be stated').toContain(reasons[0]);
  });
});
