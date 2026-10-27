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
// real client cannot: it sends `confirmedBlueprint: pendingBlueprint`, and at
// the time a propose turn returned `pendingBlueprint: null`, so the guard never
// passed in the app and every live Confirm fell through to the broken tail.
// A test that passes `confirmedBlueprint` would prove the path that was never
// in question. This one sends null.
//
// ALL OF THE ABOVE IS HISTORY, LABELLED AS SUCH. Two things have changed
// since: a propose turn carries its path, so the client does post an echo and
// the short-circuit is reachable; and that short-circuit is now the ONE Confirm
// door. The button and a typed "Confirmed. Build this campaign." both compile
// `brief.lastProposal` there and return, and the echo is not read. The tail no
// longer runs for either of them.
//
// NOR FOR A REFINEMENT, which returns at its own `isRefinement` block. The one
// case left for the `isBuildTurn` hop below is the button's sentence TYPED
// while the session is not `AWAITING_STRATEGY_CONFIRMATION` — the door asks for
// the state a plan was actually approved from, and `isBuildTurn` does not.
// `approvedPlan` is false for it, which is why no report is merged there.
//
// THE CLIENT. `stream.ts` set `sawResult` only on a result frame, so an error
// frame called `onError` and left it false — and when the socket closed the
// fallback fired a second time. That is the second bubble: one real failure,
// one invented, and the invented one read last.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { orchestrateStream, renderBuildSummary, renderStrategy, stickyForPhase } from '../../server/orchestrator';
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

/** Returns how many model calls were actually made. A Confirm makes none. */
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
  return () => i;
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

/**
 * The path as it would be ON FILE, from the propose turn that put it up.
 *
 * WHY THIS FIXTURE CHANGED. These tests used to deliver the journey through a
 * `build_campaign` tool call on the Confirm turn itself, with
 * `confirmedBlueprint: null`, because when they were written a propose turn
 * carried no blueprint and the client had nothing to echo. Confirm now
 * compiles `brief.lastProposal` — the plan the application itself accepted and
 * put up for approval — so a Confirm with nothing on file is refused rather
 * than built from whatever arrives on the turn. The tool call stays in the
 * script: the model may still make it, and the point is that its output is not
 * what gets compiled.
 */
const PLAN_ON_FILE = {
  summary: 'Catch new cardholders while the card is still new.',
  approach: ['Everyone issued and not yet activated enters.'],
  architectures: [
    {
      name: 'Open early',
      barrier: 'cost-perception',
      audience: 'All new cardholders',
      timing: 'From issuance',
      lever: 'message',
      journey: 'linear',
      chosen: true,
    },
  ],
};

const filePath = (b: unknown, steps: unknown[]) => ({
  ...(b as Record<string, unknown>),
  lastProposal: {
    strategy: PLAN_ON_FILE,
    blueprint: {
      campaignName: 'Activate new cardholders',
      description: 'Fourteen days from issuance.',
      goal: null,
      entry: {
        kind: 'audience',
        entity: 'Card',
        conditions: [{ attribute: 'Status', operator: 'Equals', value: 'Active' }],
      },
      steps,
    },
    round: 1,
  },
});

/** A Confirm exactly as the client sends one: no `confirmedBlueprint`. */
async function confirm(steps: unknown[] = COMPLETE, withBrief?: unknown) {
  script([buildTurn(steps), proseTurn('Built.')]);
  const gen = orchestrateStream({
    sessionId: 'confirm-crash',
    tenantId: 'TEN-IBL',
    knowledge,
    discoveryRounds: 3,
    brief: filePath(withBrief ?? settled(), steps),
    intent: 'confirm',
    // STILL NULL, and still the point — just a different one. The client does
    // send an echo now, and the server does not read it: the journey comes off
    // the record. Leaving this null proves the compile does not depend on it.
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
    // TWO, NOT THREE, SINCE THE CONFIRM DOORS WERE MERGED. The Confirm
    // short-circuit used to take this hop and then build and return on its
    // own, which is exactly how the button and a typed yes came to produce
    // different campaigns. It now decides only whether a yes may build and
    // falls through, so the hop it used to take is the build tail's.
    expect(hops.length, 'the one Confirm door, the build tail and a refinement').toBe(3);
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
describe('cadence reads the who-groups on the steps', () => {
  // REWRITTEN 2026-10-26, and the rule it replaces is the one being retired.
  //
  // Every case below used to count rows in `touches` and demand two sends per
  // named path. MEASURED, `eval/runs/ui-s-1792984906680` turns 3 and 4: the
  // journey was a ticket-size branch with a wording experiment on the smaller
  // band, a READ against DELIVERED/DELETED fork inside each arm, and a last
  // chance on every tail — day 0 / 2 / 5 on the band the campaign is for —
  // and `touches` described it as SIX paths, two of them engagement arms and
  // two of them experiment arms. Counting captions as groups demanded two
  // sends per caption, so a journey that over-DESCRIBES itself was refused
  // for under-dosing, and the manager got no Confirm on a finished plan.
  //
  // THE PRODUCT LOCK, which this encodes rather than argues with: a who-split
  // plus a clock is a complete first campaign. One send per ticket band is
  // approvable. Forcing a mid-window and a last chance onto every band is the
  // application writing the sequence.
  //
  // So the only hold left is "nothing to approve": no shaped steps, or a
  // who-group the journey cuts out and never messages.
  const strategy = (touches?: unknown[]) => ({
    summary: 'Fourteen days from issuance.',
    approach: [],
    assumptions: [],
    unknowns: [],
    ...(touches ? { touches } : {}),
  });
  const send = (name: string) => ({
    kind: 'send',
    name,
    objective: ['activate'],
    stage: 'first-touch',
    describe: 'Prompt the PIN.',
    channelPreference: ['WHATSAPP'],
    barrier: 'cost-perception',
  });
  const path = (steps: unknown[]) => ({
    campaignName: 'A',
    description: 'd',
    goal: null,
    entry: { kind: 'audience', entity: 'Card', conditions: [] },
    steps,
  });
  /** A ticket-size branch: the arms are GROUPS of people. */
  const bands = (high: unknown[], low: unknown[]) =>
    path([
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
    ]);

  it('refuses a plan with no journey at all, because there is nothing to approve', () => {
    const blocks = cadenceBlocks({ strategy: strategy(), blueprint: null } as never);
    expect(blocks.map((b) => b.code)).toEqual(['cadence-unnamed']);
    expect(blocks[0].reason).toMatch(/does not say what actually goes out/);
    expect(blocks[0].clears.how).toMatch(/Put the journey in "blueprint"/);
  });

  it('refuses captions dressed as steps for the same reason', () => {
    expect(
      cadenceBlocks({ strategy: strategy(), blueprint: path(['Day 0 WhatsApp']) } as never).map((b) => b.code),
    ).toEqual(['cadence-unnamed']);
  });

  it('ACCEPTS one send per ticket band — the lock, stated as a test', () => {
    expect(cadenceBlocks({ strategy: strategy(), blueprint: bands([send('High')], [send('Low')]) } as never)).toEqual([]);
  });

  it('accepts a lighter band beside a fuller one', () => {
    const full = [send('Opening'), { kind: 'wait', durationHours: 48 }, send('Reminder'), { kind: 'wait', durationHours: 72 }, send('Last chance')];
    expect(cadenceBlocks({ strategy: strategy(), blueprint: bands([send('One touch')], full) } as never)).toEqual([]);
  });

  it('ignores touch rows entirely, however the plan over-splits them', () => {
    // The live shape: six "paths" in the prose, two of them experiment arms
    // and two of them read captions, against a journey that is a sequence.
    const overSplit = [
      { day: 0, channel: 'WhatsApp', path: 'Below ₹10,000 — functional framing', purpose: 'p', ifStillUnconverted: 'x' },
      { day: 0, channel: 'WhatsApp', path: 'Below ₹10,000 — benefit framing', purpose: 'p', ifStillUnconverted: 'x' },
      { day: 2, channel: 'WhatsApp', path: 'Below ₹10,000 — read but no action', purpose: 'p', ifStillUnconverted: 'x' },
      { day: 2, channel: 'SMS', path: 'Below ₹10,000 — not read', purpose: 'p', ifStillUnconverted: 'x' },
      { day: 5, channel: 'SMS', path: 'Below ₹10,000 — all still unconverted', purpose: 'p', ifStillUnconverted: 'x' },
      { day: 0, channel: 'WhatsApp', path: '₹10,000 and above', purpose: 'p', ifStillUnconverted: 'x' },
    ];
    expect(
      cadenceBlocks({ strategy: strategy(overSplit), blueprint: bands([send('High')], [send('Low')]) } as never),
    ).toEqual([]);
  });

  it('does not count experiment arms or engagement arms as groups', () => {
    const inner = [
      {
        kind: 'experiment',
        label: 'Framing test',
        tests: 'explanation',
        arms: [
          { label: 'Functional', pct: 50, steps: [send('A'), { kind: 'branch', label: 'Response', paths: [
            { label: 'Read', statuses: ['READ'], steps: [send('A-read')] },
            { label: 'Not read', statuses: ['DELIVERED', 'DELETED'], steps: [send('A-unread')] },
          ] }] },
          { label: 'Benefit', pct: 50, steps: [send('B')] },
        ],
      },
    ];
    expect(cadenceBlocks({ strategy: strategy(), blueprint: bands([send('High')], inner) } as never)).toEqual([]);
  });

  it('STILL refuses a who-arm with nothing to send it', () => {
    const blocks = cadenceBlocks({
      strategy: strategy(),
      blueprint: bands([send('High')], [{ kind: 'exit', reason: 'Nothing for them.' }]),
    } as never);
    expect(blocks.map((b) => b.code)).toEqual(['cadence-unnamed']);
    expect(blocks[0].reason).toMatch(/"Everyone else"/);
    expect(blocks[0].reason).toMatch(/never messages/);
    expect(blocks[0].clears.how).toMatch(/at least one send, or drop the split/);
  });

  it('never calls a holdout a group with no send', () => {
    // A control arm is an experiment arm: an interior of one group, read at
    // random, and deliberately unmessaged. It is not a guest list.
    const withHoldout = [
      {
        kind: 'experiment',
        label: 'Holdout',
        tests: 'explanation',
        arms: [
          { label: 'Messaged', pct: 90, steps: [send('Opening')] },
          { label: 'Control', pct: 10, steps: [{ kind: 'exit', reason: 'Measured against the rest.' }] },
        ],
      },
    ];
    expect(cadenceBlocks({ strategy: strategy(), blueprint: path(withHoldout) } as never)).toEqual([]);
  });

  it('finds a who-split nested under an experiment or a wait', () => {
    const nested = path([
      { kind: 'wait', durationHours: 24 },
      {
        kind: 'branch',
        label: 'Ticket band',
        entity: 'Transaction',
        attribute: 'Transaction Amount',
        paths: [
          { label: 'High ticket', operator: 'Greater than', value: '10000', steps: [send('High')] },
          { label: 'Everyone else', operator: 'Less than', value: '10000', steps: [] },
        ],
      },
    ]);
    expect(cadenceBlocks({ strategy: strategy(), blueprint: nested } as never).map((b) => b.code)).toEqual([
      'cadence-unnamed',
    ]);
  });

  it('is not re-litigated on the turn that builds the approved plan', () => {
    // `building` is true on Confirm and refinement. Refusing there is both
    // useless and insulting: there is nothing the manager can do about a
    // missing field from the build turn, and the moment to say so was before
    // they agreed.
    const brief = settled();
    const noPath = { strategy: strategy(), blueprint: null } as never;
    expect(decide(brief, { proposed: noPath, building: true }).blocks.map((b) => b.code)).not.toContain(
      'cadence-unnamed',
    );
    expect(decide(brief, { proposed: noPath }).blocks.map((b) => b.code)).toContain('cadence-unnamed');
  });

  it('shows the manager the sequence, not just a timing sentence', () => {
    const out = renderStrategy({
      summary: 'Fourteen days from issuance.',
      approach: [],
      assumptions: [],
      unknowns: [],
      touches: [
        { day: 0, channel: 'WhatsApp', path: 'all', purpose: 'Prompt the PIN.', ifStillUnconverted: 'Try SMS next.' },
        { day: 3, channel: 'WhatsApp', path: 'all', purpose: 'Prompt the PIN.', ifStillUnconverted: 'Try SMS next.' },
        { day: 7, channel: 'WhatsApp', path: 'all', purpose: 'Prompt the PIN.', ifStillUnconverted: 'Try SMS next.' },
        { day: 13, channel: 'WhatsApp', path: 'all', purpose: 'Prompt the PIN.', ifStillUnconverted: 'Try SMS next.' },
        { day: 2, channel: 'WhatsApp', path: 'High limit', purpose: 'Prompt the PIN.', ifStillUnconverted: 'Try SMS next.' },
      ],
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

  it('does not cry drift when nested touch labels split one route', () => {
    // MEASURED, `eval/runs/ui-s-1793086620956` turn 4. High-ticket 2, low-ticket
    // nested as separate path names so the fullest *row-group* was 2; the
    // compiled longest path was 3. The steps already had three messages on
    // that arm.
    const send = { kind: 'send', name: 'm', objective: ['emi'], stage: 'first-touch', describe: 'd' };
    const path = {
      campaignName: 'EMI',
      description: 'd',
      goal: null,
      entry: { kind: 'audience', entity: 'Customer' },
      steps: [
        {
          kind: 'branch',
          on: { entity: 'Transaction', attribute: 'Transaction Amount' },
          paths: [
            { label: 'High', steps: [send, send] },
            {
              label: 'Low',
              steps: [
                send,
                {
                  kind: 'branch',
                  paths: [
                    { label: 'Read', statuses: ['READ'], steps: [send, send] },
                    { label: 'Unread', statuses: ['DELIVERED'], steps: [send, send] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const touches = [
      { day: 0, path: 'Above ₹10,000' }, { day: 4, path: 'Above ₹10,000' },
      { day: 0, path: '₹10,000 or below' },
      { day: 3, path: '₹10,000 or below — read' },
      { day: 6, path: '₹10,000 or below — read arm' },
    ];
    const out = renderBuildSummary(
      { summary: 's', approach: [], assumptions: [], unknowns: [], touches } as never,
      { graph: chain(3), issues: [], sendProposals: [] } as never,
      { outcome: 'passed', checks: [], unverifiedHardConstraints: [] } as never,
      0,
      false,
      null,
      path as never,
    );
    expect(out).not.toMatch(/on its longest path/);
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
    // WAS pinned on "# THIS TURN BUILDS THE APPROVED PLAN" in the context
    // prompt, which is deleted: it restated what the Confirm sticky says, and
    // carried the {"action":"design"} handshake that has never fired live.
    expect(stickyForPhase('build')).toMatch(/build_campaign — the approved path, as a journey/);
    expect(stickyForPhase('build')).toMatch(/This is the job of the turn/);
    // HOMELESS, and listed in `server/promptHomeless.md`: "never tell them the
    // build is unavailable to you" was written for a measured live failure —
    // a Confirm that replied its role stopped at proposing. The Confirm
    // manual says the positive version instead, and the forced build is the
    // structural guarantee either way.
    expect(stickyForPhase('build')).toMatch(/A build that exists only in prose does not exist on the canvas/);
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
      // FILED, because a typed yes compiles the filed path exactly as the
      // button does. That is the whole point of the merge.
      brief: filePath(settled(), COMPLETE),
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
let lastCalls: () => number = () => 0;
async function confirmScripted(bodies: string[], brief?: unknown, opts?: { file?: boolean }) {
  lastCalls = script(bodies);
  const gen = orchestrateStream({
    sessionId: 'confirm-prose',
    tenantId: 'TEN-IBL',
    knowledge,
    discoveryRounds: 3,
    // `file: false` is the no-plan-on-file case, which is the only refusal on
    // the Confirm door. Everything else files the path, because that is what a
    // propose turn leaves behind in the real app.
    brief: opts?.file === false ? (brief ?? settled()) : filePath(brief ?? settled(), COMPLETE),
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

// ===========================================================================
// ONE CONFIRM, NOT TWO
// ===========================================================================
//
// MEASURED IN CODE. The button posts `intent: 'confirm'` and took a
// short-circuit that built `req.confirmedBlueprint` — the client's echo of its
// own `pendingBlueprint` — and returned, skipping `checkBarrierCoverage`,
// `checkExperimentClaims` and the reaction report. A manager who TYPED the
// same sentence walked the whole build tail instead, where those two audits
// could refuse the build AFTER they had agreed, and where a clock against a
// reactive claim spent another model call asking for a fork they had never
// approved. Same words, two campaigns.
describe('the button and a typed yes are the same product', () => {
  const PATH = [
    {
      kind: 'send',
      name: 'Opening nudge',
      objective: ['activate', 'pin'],
      stage: 'first-touch',
      describe: 'Show them the two steps to set a PIN.',
      copy: 'Your card is ready. Set your PIN in two minutes.',
      channelPreference: ['WHATSAPP'],
      barrier: 'cost-perception',
    },
    { kind: 'exit', reason: 'Fourteen days are up.' },
  ];
  /** A blueprint nobody filed, which is what a browser can post. */
  const ECHO = {
    campaignName: 'Something else entirely',
    description: 'Not the plan that was put up.',
    goal: null,
    entry: { kind: 'audience', entity: 'Card', conditions: [] },
    steps: [{ kind: 'send', name: 'Echo send', objective: ['x'], stage: 'first-touch', describe: 'd', copy: 'c', channelPreference: ['SMS'], barrier: 'cost-perception' }],
  };

  const confirmWith = async (over: Record<string, unknown>) => {
    script([proseTurn('Anything.')]);
    const gen = orchestrateStream({
      sessionId: 'one-confirm',
      tenantId: 'TEN-IBL',
      knowledge,
      discoveryRounds: 3,
      brief: filePath(settled(), PATH),
      session: { state: 'AWAITING_STRATEGY_CONFIRMATION', strategyVersion: 1, confirmation: null },
      messages: [
        { role: 'user', content: 'Get new cardholders activated.' },
        { role: 'assistant', content: 'Here is the plan.' },
        { role: 'user', content: 'Confirmed. Build this campaign.' },
      ],
      ...over,
    } as never);
    let out = await gen.next();
    while (!out.done) out = await gen.next();
    return out.value as unknown as Record<string, unknown>;
  };

  const names = (res: Record<string, unknown>) =>
    Object.values((res.graph as { nodes: Record<string, { label?: string }> }).nodes)
      .map((n) => n.label ?? '')
      .join(' | ');

  it('the BUTTON compiles the filed path, not the echo it posted', async () => {
    const res = await confirmWith({ intent: 'confirm', confirmedBlueprint: ECHO });
    expect(res.graph).toBeTruthy();
    expect(names(res)).toContain('Opening nudge');
    expect(names(res)).not.toContain('Echo send');
    expect(String(res.campaign && (res.campaign as { name?: string }).name)).not.toContain('Something else entirely');
  });

  it('a TYPED yes compiles the same filed path, from the same place', async () => {
    const res = await confirmWith({ confirmedBlueprint: ECHO });
    expect(res.graph).toBeTruthy();
    expect(names(res)).toContain('Opening nudge');
    expect(names(res)).not.toContain('Echo send');
  });

  it('a mutated echo changes nothing, because the echo is not read', async () => {
    const withEcho = await confirmWith({ intent: 'confirm', confirmedBlueprint: ECHO });
    const withoutEcho = await confirmWith({ intent: 'confirm', confirmedBlueprint: null });
    expect(names(withEcho)).toBe(names(withoutEcho));
  });

  it('no filed path is refused, and nothing is built from the browser', async () => {
    const res = await confirmWith({ intent: 'confirm', confirmedBlueprint: ECHO, brief: settled() });
    expect(res.graph ?? null).toBeNull();
    expect(res.campaign ?? null).toBeNull();
    expect(res.phase).toBe('planning');
    expect(String(res.reply ?? '')).toMatch(/no plan on file/i);
  });

  it('a REFINEMENT reports an uncited send too, rather than refusing it', async () => {
    // THE OTHER BUILD TURN. A refinement is the manager asking for a specific
    // change to a campaign that already exists, so it is an approval as much
    // as a Confirm is — and `checkBarrierCoverage` used to send it back to
    // Revise instead of building and stating the cost. Both build turns now
    // report. This is the case that keeps the `!approvedPlan` guard honest,
    // because a Confirm no longer reaches that code at all.
    const uncited = [
      { kind: 'send', name: 'Nameless nudge', objective: ['activate'], stage: 'first-touch',
        describe: 'Say something.', copy: 'Something.', channelPreference: ['WHATSAPP'] },
      { kind: 'exit', reason: 'Done.' },
    ];
    script([buildTurn(uncited), proseTurn('Changed.')]);
    const gen = orchestrateStream({
      sessionId: 'refine',
      tenantId: 'TEN-IBL',
      knowledge,
      discoveryRounds: 3,
      brief: filePath(settled(), COMPLETE),
      currentCampaign: { id: 'c1', name: 'Existing', root: { rootId: 'n1', nodes: {}, edges: [] } },
      session: { state: 'EXPORT_ELIGIBLE', strategyVersion: 1, confirmation: null },
      messages: [
        { role: 'user', content: 'Get new cardholders activated.' },
        { role: 'assistant', content: 'Built.' },
        // WORDED LIKE THE OBJECTIVE ON PURPOSE. A change request that shares
        // nothing with the brief is read as a NEW objective and resets the
        // machine to `UNDERSTANDING_GOAL`, which then cannot legally enter
        // generation. That hazard is older than this slice and is not what
        // this test is about.
        { role: 'user', content: 'Get new cardholders activated a day later than this.' },
      ],
    } as never);
    let out = await gen.next();
    while (!out.done) out = await gen.next();
    const res = out.value as unknown as Record<string, unknown>;

    // IT BUILDS. A change request is an approval as much as a Confirm is, so
    // an uncited send is a cost to state rather than a reason to refuse.
    expect(res.phase, 'a refinement is not sent back to Revise').not.toBe('revising');
    expect(res.graph, 'the change still reaches the canvas').toBeTruthy();

    // AND IT SAYS SO. `phase !== 'revising'` on its own was the whole
    // assertion, which made this test pass whether or not the cost was ever
    // reported — the refinement path skipped the refusal once a plan was
    // approved and put nothing in its place, so an uncited send compiled in
    // silence. The sentence has to reach the manager, by either route
    // `renderStrategy` and the build summary read.
    const blockers = ((res.campaignBlockers as string[] | undefined) ?? []).join(' ');
    const warnings = (((res.strategy as { designWarnings?: string[] } | null)?.designWarnings) ?? []).join(' ');
    expect(
      `${blockers} ${warnings}`,
      'the uncited send must be stated on the blockers or under what this design cannot do',
    ).toMatch(/do not say which problem they solve/);
    expect(`${blockers} ${warnings}`).toMatch(/Nameless nudge/);
  });

  it('nothing claims the tail still runs a yes', () => {
    // COMMENTS AND TEST NAMES ARE PART OF THE PRODUCT HERE. Three of them
    // outlived the merge and said a typed "Confirmed. Build this campaign."
    // falls through to the build tail, or called what reaches it a
    // refinement. Both yeses return at the door, and refinements compile at
    // their own block, so each sentence was pointing the next reader at the
    // wrong place.
    const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    // THE HEADER ONLY — everything above the first import. Reading the whole
    // file would make this assertion match its own text, which is the kind of
    // self-satisfying pin this repo has been bitten by.
    const self = readFileSync(new URL('./confirmReachesGeneration.test.ts', import.meta.url), 'utf8');
    const header = self.slice(0, self.indexOf('import '));
    expect(header).not.toMatch(/fall-through below must stay correct/);
    expect(header).toMatch(/The tail no\n\/\/ longer runs for either of them/);
    // AND IT MUST AGREE WITH THE HOP ABOUT WHO GETS THERE. Pinning the old
    // phrase was not enough: the replacement header made the same overclaim in
    // new words — "what reaches it is a refinement" — one paragraph before the
    // block that correctly says it is not. The claim is what gets checked now,
    // so any rewording that says a refinement reaches the hop fails here.
    expect(header).not.toMatch(/reaches (it|the tail|that hop)[^.]*is a refinement/i);
    expect(header).not.toMatch(/is a refinement, which\n\/\/ compiles/);
    expect(header).toMatch(/AWAITING_STRATEGY_CONFIRMATION/);
    expect(header).toMatch(/returns at its own `isRefinement` block/);

    // The block after the refinement return must not call its visitor a
    // refinement, and must name who actually gets there.
    const who = orch.slice(orch.indexOf('// WHO STILL LANDS HERE'), orch.indexOf('session = { ...session, state: transition(session.state, \'GENERATING_CAMPAIGN\') };', orch.indexOf('// WHO STILL LANDS HERE')));
    expect(who.length).toBeGreaterThan(0);
    expect(who).not.toMatch(/a refinement, where the manager/);
    expect(who).toMatch(/not a refinement/);
    expect(who).toMatch(/is not `AWAITING_STRATEGY_CONFIRMATION`/);

    // And the merge that could not add a line is gone: one `tailGaps.lines`
    // merge, on the refinement compile.
    expect(orch.match(/tailGaps\.lines\.filter/g) ?? [], 'one merge, on the refinement').toHaveLength(1);

    // THE CASE NAME IN `canvasMustReact` SAID THE OPPOSITE OF ITS BODY: it was
    // titled for the DOOR's rule — prefer the filed plan — while asserting the
    // TAIL's, which is this turn's proposal. A test name cannot fail on its
    // own, so the old title is pinned absent from here, where there is no
    // self-reference to satisfy it.
    const cmr = readFileSync(new URL('./canvasMustReact.test.ts', import.meta.url), 'utf8');
    expect(cmr).not.toContain('prefers the approved plan over the strategy this turn happens to carry');
    expect(cmr).toContain('the Confirm door reads the filed plan; the tail reads this turn');
  });

  // A PATH THEY CAN CONFIRM MUST COMPILE INTO THE SENDS THEY APPROVED.
  //
  // MEASURED, `eval/runs/ui-s-1793009889177`. Turn 4 filed one Transaction
  // Amount branch with six sends on its arms — label, copy, channels, no
  // `stage`. Turn 5 compiled it and returned `phase: 'review'` over a canvas
  // of an entry, the split and three exits: zero message steps. The reply said
  // so; the screen said review.
  const noSendPath = {
    campaignName: 'Waits only',
    description: 'Get new cardholders activated.',
    goal: null,
    entry: { kind: 'audience', entity: 'Card', conditions: [] },
    steps: [{ kind: 'wait', duration: 2, unit: 'days' }, { kind: 'exit', reason: 'Done.' }],
  };

  it('a Confirm that compiles to no sends is not a review screen', async () => {
    const res = await confirmWith({ intent: 'confirm', confirmedBlueprint: null, brief: filePath(settled(), noSendPath.steps) });
    // THE SENTENCE WAS ALREADY RIGHT and is not the pin: it matched on the
    // live turn while three exits sat on screen. The graph is.
    expect(String(res.reply ?? '')).toMatch(/did not produce any message steps/i);
    const nodes = Object.keys(((res.graph as { nodes?: Record<string, unknown> } | null)?.nodes) ?? {});
    expect(nodes, 'nothing to draw, so nothing is drawn').toHaveLength(0);
    expect(res.phase, 'a canvas of exits is not something to review').not.toBe('review');
    expect(res.designGenerated ?? false).toBe(false);
  });

  it('a Confirm of the live EMI-shaped path builds its sends', async () => {
    // The shape that produced zero sends: a branch with sends on both arms and
    // no stage anywhere.
    const send = (label: string) => ({ kind: 'send', label, copy: 'Convert this purchase to EMI.', channelPreference: ['WHATSAPP'], barrier: 'cost-perception' });
    const emi = [
      {
        kind: 'branch',
        entity: 'Transaction',
        attribute: 'Transaction Amount',
        paths: [
          { label: 'High value', operator: 'Equals', value: '10000', steps: [send('Day0 high'), send('Day4 high')] },
          { label: 'Lower value', operator: 'Not Equals', value: '10000', steps: [send('Day0 lower')] },
        ],
      },
    ];
    const res = await confirmWith({ intent: 'confirm', confirmedBlueprint: null, brief: filePath(settled(), emi) });
    const types = Object.values(((res.graph as { nodes?: Record<string, { type?: string }> } | null)?.nodes) ?? {}).map((n) => n.type);
    expect(types.filter((t) => t === 'SEND'), 'the sends they approved reach the canvas').toHaveLength(3);
    expect(String(res.reply ?? '')).not.toMatch(/did not produce any message steps/i);
    expect(res.phase).toBe('review');
  });

  it('REACTION_RETRY is never sent after a yes', async () => {
    const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    // The constant still exists, and nothing sends it. A clock is reported,
    // not re-asked: the moment to catch a plan whose steps do not match its
    // claim is before approval, and afterwards the manager can do nothing
    // with the refusal except approve again.
    expect(orch).toMatch(/export const REACTION_RETRY =/);
    const sends = orch.match(/\$\{REACTION_RETRY\}/g) ?? [];
    expect(sends, 'no system string carries it any more').toHaveLength(0);
  });

  it('the design handshake cannot fire on a build turn', async () => {
    const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    // Gated rather than deleted: `capability.test.ts` greps these symbols, and
    // a grepped symbol that disappears fails a test for a reason unrelated to
    // what that test is about.
    expect(orch).toMatch(/const DESIGN_HANDSHAKE_LIVE = false;/);
    expect(orch).toMatch(/act === 'design' &&[^\n]*&& DESIGN_HANDSHAKE_LIVE/);
    expect(orch).toMatch(/act === 'propose' &&[^\n]*&& DESIGN_HANDSHAKE_LIVE/);
  });

  it('the handshake JSON gets no second round on a Confirm', async () => {
    // A model that emits the intervention JSON on a Confirm is not answered
    // with a request for more of it. The turn compiles the filed path.
    const res = await confirmWith({
      intent: 'confirm',
      confirmedBlueprint: null,
    });
    expect(res.graph).toBeTruthy();
    expect(String(res.reply ?? '')).not.toMatch(/state the INTERVENTION/i);
  });
});

// A CONFIRM MAKES NO MODEL CALL AT ALL.
//
// These cases were written when a Confirm walked the round loop: the model
// could look things up, write a false success sentence, and never call
// `build_campaign`, and the application had to force the build and then refuse
// to pass the prose off as a campaign. The door compiles `brief.lastProposal`
// and returns, so none of that can happen — the scripted turns below are never
// requested. The product claims they pin are still the right ones, so they are
// kept and each one now also pins that no round was spent.
describe('a Confirm compiles the filed path and calls nothing', () => {
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
    expect(lastCalls(), 'the path is on file, so there is nothing to ask for').toBe(0);
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
    // The reply is the application's own account of what it built, and the
    // model's claim cannot even be in the running: it is never asked.
    expect(String(res.reply ?? '')).not.toBe(FALSE_SUCCESS);
    expect(String(res.reply ?? '')).toMatch(/canvas/i);
    expect(lastCalls(), 'no round is spent on a Confirm').toBe(0);
  });

  it('REPLACED: nothing on file is the honest empty, not a build of the echo', async () => {
    // WHAT THIS TEST USED TO BE. It scripted a Confirm where the model never
    // called `build_campaign`, and asserted the compiler's own failure. That
    // case no longer exists: Confirm compiles `brief.lastProposal`, so whether
    // the model calls the tool on this turn does not decide whether there is
    // anything to build. A model that stays silent on a Confirm with a filed
    // path still gets the filed path built, which is the point of the slice.
    //
    // WHAT IT IS NOW. The honest empty that replaced it: a Confirm with NO
    // filed path refuses rather than compiling whatever the browser last drew.
    // This is the only refusal on the Confirm door, and it has to be a
    // refusal, because the alternative is building a journey the application
    // never accepted.
    const res = await confirmScripted(
      [lookupAndRecordTurn(), proseTurn(FALSE_SUCCESS), buildTurn(COMPLETE), proseTurn('Built.')],
      settled(),
      { file: false },
    );
    expect(res.graph ?? null).toBeNull();
    expect(res.campaign ?? null).toBeNull();
    expect(res.phase).toBe('planning');
    expect(String(res.reply ?? '')).toMatch(/no plan on file/i);
    expect(res.brief, 'the record survives a refusal').toBeTruthy();
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
