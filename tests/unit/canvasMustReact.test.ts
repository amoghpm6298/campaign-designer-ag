// The canvas may not be a clock while the plan claimed a reaction.
//
// `eval/runs/ui-s-1792738033056` turn 4, the Confirm. The strategy the manager
// approved declared a branch-on-response journey and named a second channel
// for when the first does not land. What arrived on the canvas:
//
//   - one condition on Transaction Amount — a who-split, not a reaction;
//   - an experiment whose two arms ran the identical four-send cadence;
//   - ten WhatsApp sends, with a Goal Check stamped after each one by the
//     compiler;
//
// and the reply read "Built the journey: 10 message steps, 36 steps in total.
// It is on the canvas now."
//
// NEITHER EXISTING CHECK COULD CATCH IT. `optionAudit` downgrades a `used`
// claim to a footnote in the options table, under that sentence.
// `checkFidelity` compares the declared journey against `derive()`, which
// counts ANY condition as branch-on-response — so a ticket-size split
// satisfies it. Both report; neither is a consequence.
//
// MEASURED BEFORE BUILDING ANYTHING, and it changed the design: on that turn
// the strategy carried by the build turn itself is the SYNTHETIC EMPTY one
// (`summary: ''`, `architectures: []`, no touches), because `propose_strategy`
// is not offered on a Confirm. A check reading only this turn's strategy would
// have been inert in the app and green in every hand-fed test — the
// `confirmedStrategy` trap again. So the approved plan is read from the
// request first, which is where the client actually puts it.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { orchestrateStream, renderBuildSummary } from '../../server/orchestrator';
import { journeyReacts, reactsToDelivery } from '../../server/optionAudit';
import { derive } from '../../server/architectureAudit';
import { seedKnowledgeBase } from '../../server/knowledge';
import { newBrief, recordDimensions, recordSuccessCriteria } from '../../server/discovery';
import { discovered } from './support/findings';
import type { CampaignBlueprint } from '../../server/blueprint';

const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
const designer = readFileSync(new URL('../../src/designer/CampaignDesigner.tsx', import.meta.url), 'utf8');

const SYSTEM = (() => /const SYSTEM = `([\s\S]*?)`;\n/.exec(orch)![1])();

const send = (over: Record<string, unknown> = {}) => ({
  kind: 'send',
  name: 'Opening nudge',
  objective: ['emi', 'convert'],
  stage: 'first-touch',
  describe: 'Say the purchase can be split, and what it costs.',
  copy: 'Split this purchase from ₹2,100 a month.',
  channelPreference: ['WHATSAPP'],
  barrier: 'cost-perception',
  ...over,
});

const bp = (steps: unknown[]): CampaignBlueprint =>
  ({
    campaignName: 'Authorisation to EMI',
    description: 'Prompt conversion inside the open window.',
    goal: null,
    entry: { kind: 'audience', entity: 'Card', conditions: [{ attribute: 'Status', operator: 'Equals', value: 'Active' }] },
    steps,
  }) as never;

/**
 * Turn 4, COPIED OFF THE RECORD rather than imagined.
 *
 * The first version of this fixture had the ticket-size branches doing the
 * same thing on both sides, and the revert that should have failed it passed:
 * `structuralSignature` already called those two branches identical, so the
 * `outcomes` filter was never what the test was measuring. The real journey is
 * lopsided — two sends on the big-ticket side, a four-send copy experiment on
 * the other — which is exactly the shape that makes "any condition counts" a
 * false positive.
 *
 * Read from `eval/runs/ui-s-1792738033056/turns/turn-4.json`, down to the
 * `Greater than` operator the builder does not accept on a number attribute.
 *
 * `tests: 'wording'` is what it honestly is, and declaring anything else makes
 * `checkExperimentClaims` refuse the build before the tail under test.
 */
const CLOCK = [
  {
    kind: 'condition',
    label: 'Above ₹10,000?',
    on: { entity: 'Transaction', attribute: 'Transaction Amount', operator: 'Greater than', value: '10000' },
    yes: [
      send({ name: 'Above ₹10,000 – Day 0 eligibility notice' }),
      send({ name: 'Above ₹10,000 – Day 5 final reminder', stage: 'reminder' }),
      { kind: 'exit', reason: 'The window closed.' },
    ],
    no: [
      {
        kind: 'experiment',
        label: 'Generic versus instalment-value framing',
        tests: 'wording',
        arms: [
          {
            label: 'Generic eligibility framing',
            pct: 50,
            steps: [
              send({ name: 'Day 0 eligibility notice – generic' }),
              send({ name: 'Day 2 reminder – generic', stage: 'reminder' }),
              send({ name: 'Day 4 reminder – generic', stage: 'reminder' }),
              send({ name: 'Day 6 final notice – generic', stage: 'outcome' }),
            ],
          },
          {
            label: 'Instalment value framing',
            pct: 50,
            steps: [
              send({ name: 'Day 0 eligibility notice – value', copy: 'From ₹2,100 a month.' }),
              send({ name: 'Day 2 reminder – value', stage: 'reminder', copy: 'From ₹2,100 a month.' }),
              send({ name: 'Day 4 reminder – value', stage: 'reminder', copy: 'From ₹2,100 a month.' }),
              send({ name: 'Day 6 final notice – value', stage: 'outcome', copy: 'Last chance.' }),
            ],
          },
        ],
      },
      { kind: 'exit', reason: 'The window closed.' },
    ],
  },
];

/** The same plan, built as it was described: a fork on the delivery result. */
const REACTING = [
  send(),
  {
    kind: 'condition',
    label: 'Did it land?',
    outcomes: ['Delivered'],
    yes: [{ kind: 'wait', durationHours: 48, why: 'Let them act.' }, send({ name: 'Nudge again', stage: 'reminder' })],
    no: [send({ name: 'SMS fallback', stage: 'first-touch', channelPreference: ['SMS'] })],
  },
  { kind: 'exit', reason: 'The window closed.' },
];

describe('journeyReacts reads the blueprint, not the claim', () => {
  it('is false for the live turn-4 shape: a who-split and a copy test', () => {
    // THE CASE THE WHOLE SLICE EXISTS FOR. A condition on a customer
    // attribute decides which path someone takes on the way in. It says
    // nothing about what they did with the last message.
    expect(journeyReacts(bp(CLOCK))).toBe(false);
  });

  it('is true for a fork on the preceding send, with different steps each side', () => {
    expect(journeyReacts(bp(REACTING))).toBe(true);
  });

  it('is true for a wait-for-event, which is the purest form of it', () => {
    expect(
      journeyReacts(
        bp([
          send(),
          { kind: 'waitForEvent', eventCategory: 'EMI Events', eventType: 'EMI_STATUS_CHANGED', timeoutDays: 7 },
          { kind: 'exit', reason: 'Done.' },
        ]),
      ),
    ).toBe(true);
  });

  it('is false for sends and waits alone', () => {
    expect(journeyReacts(bp([send(), { kind: 'wait', durationHours: 72 }, send({ name: 'Second' }), { kind: 'exit', reason: 'Done.' }]))).toBe(false);
  });

  it('is false for an outcome fork whose two sides do the same thing', () => {
    // A condition on `outcomes` that runs the identical sequence either way
    // is a label on a journey that does not branch.
    expect(
      journeyReacts(
        bp([
          send(),
          {
            kind: 'condition',
            label: 'Did it land?',
            outcomes: ['Delivered'],
            yes: [send({ name: 'Reminder', stage: 'reminder' })],
            no: [send({ name: 'Reminder', stage: 'reminder' })],
          },
          { kind: 'exit', reason: 'Done.' },
        ]),
      ),
    ).toBe(false);
  });

  it('is false for fallbackChannel on a send, which is a field and not a fork', () => {
    expect(
      journeyReacts(bp([send({ fallbackChannel: 'SMS' }), { kind: 'wait', durationHours: 24 }, { kind: 'exit', reason: 'Done.' }])),
    ).toBe(false);
  });

  it('is false for a branch, which is n-way segmentation', () => {
    expect(
      journeyReacts(
        bp([
          {
            kind: 'branch',
            label: 'Card type',
            entity: 'Card',
            attribute: 'Card Type',
            paths: [
              { label: 'Platinum', operator: 'Equals', value: 'Platinum', steps: [send()] },
              { label: 'Everyone else', operator: 'Not Equals', value: 'Platinum', steps: [send({ name: 'Other' })] },
            ],
          },
          { kind: 'exit', reason: 'Done.' },
        ]),
      ),
    ).toBe(false);
  });

  it('says nothing about a blueprint that is not there', () => {
    expect(journeyReacts(null)).toBe(false);
    expect(journeyReacts(undefined)).toBe(false);
  });
});

describe('the retry instruction names what does NOT count', () => {
  it('is in the source, on the build turn', () => {
    expect(orch).toMatch(/The journey you sent is a clock/);
    expect(orch).toMatch(/A FORK BELONGS AFTER A SEND WHOSE ARMS WOULD DO DIFFERENT JOBS/);
    expect(orch).toMatch(/A split on ticket size is segmentation, not a reaction/);
    expect(orch).toMatch(/Never branch on QUEUED, SENT or PENDING/);
    expect(orch).toMatch(/Arms must not overlap/);
    // It must not cost the manager their evidenced split or invent a problem.
    expect(orch).toMatch(/Do not invent a second barrier/);
    expect(orch).toMatch(/Keep every message, every day and every channel job you already had/);
  });

  it('does not ask for a split after every send', () => {
    // THE SECOND MISTAKE THIS SLICE REFUSES. A check after every message is a
    // clock with extra nodes, and nested three-way forks on a four-touch path
    // are unreadable. The retry asks for a DECISION about which send is worth
    // reading back, so this pins the instruction against its own worst
    // reading — an earlier draft of it said "after each Send, branch on what
    // that send reported", which is the stamp.
    const retry = orch.slice(orch.indexOf('REACTION_RETRY ='), orch.indexOf('export function systemForPhase'));
    expect(retry.length).toBeGreaterThan(0);
    expect(retry).not.toMatch(/after each send/i);
    expect(retry).not.toMatch(/after every send, branch|branch after every/i);
    expect(retry).toMatch(/WHERE EVERY ARM WOULD WAIT THE SAME TIME AND SEND THE SAME KIND OF REMINDER, DO NOT SPLIT/);
    expect(retry).toMatch(/One or two designed checks on a whole path is the shape/);
  });

  it('does not ask for the failure path on another channel', () => {
    // THE WRONG INSTRUCTION, measured on `ui-s-1792748248345`: the retry told
    // the model to route the failure to a different channel, and undelivered
    // is `fallbackChannel` on the Send — a field, not a route anybody walks.
    const retry = orch.slice(orch.indexOf('REACTION_RETRY ='), orch.indexOf('export function systemForPhase'));
    expect(retry).not.toMatch(/failure path on a different channel/);
    expect(retry).toMatch(/do not route the failure to another channel as a step/);
    expect(retry).toMatch(/Do NOT add a FAILED, UNKNOWN or NOT_DELIVERED arm/);
    expect(retry).toMatch(/Do not add a converted arm/);
    // And the definition it came from is gone from the audit as well.
    const audit = readFileSync(new URL('../../server/optionAudit.ts', import.meta.url), 'utf8');
    expect(audit).toMatch(/THE CHANNEL-FALLBACK LEG IS GONE/);
    expect(audit).not.toMatch(/const failure = channelOf\(firstSend\(condition\.no\)\);[\s\S]{0,200}return Boolean\(failure && tested\)/);
  });

  it('is NOT method prose in SYSTEM, which has a cap this does not touch', () => {
    // The cap is on the prompt that travels every turn. This travels on one:
    // the turn after a build that did not react.
    expect(SYSTEM).not.toMatch(/The journey you sent is a clock/);
    expect(SYSTEM.length).toBeLessThanOrEqual(33_500);
  });

  it('asks for the journey a second time rather than reporting and moving on', () => {
    // Reverting the retry — deleting the forced second `build_campaign` —
    // fails here and in the end-to-end case below.
    const at = orch.indexOf('const reacts = journeyReacts(blueprint)');
    expect(at).toBeGreaterThan(-1);
    const before = orch.slice(orch.indexOf('if (isBuildTurn && promisedReaction'), at);
    expect(before).toMatch(/toolChoice: \{ type: 'tool', name: 'build_campaign' \}/);
    expect(before).toMatch(/REACTION_RETRY/);
  });
});

// ---------------------------------------------------------------------------
// The build turn, end to end
// ---------------------------------------------------------------------------

const sse = (events: Record<string, unknown>[]) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

const buildTurn = (steps: unknown[]) =>
  sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'b1', name: 'build_campaign', input: {} } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(bp(steps)) },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 200 } },
  ]);

const proseTurn = (text: string) =>
  sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 60 } },
  ]);

function script(bodies: string[]) {
  let calls = 0;
  vi.stubGlobal('fetch', async () => {
    const body = bodies[Math.min(calls, bodies.length - 1)];
    calls += 1;
    return new Response(new TextEncoder().encode(body), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
  return () => calls;
}

const knowledge = seedKnowledgeBase();

const settled = () => {
  let b = discovered(newBrief('Customers are not converting eligible purchases to EMI.'));
  b = recordDimensions(b, [
    { name: 'purchase ticket size', rationale: 'They said bigger ones convert.', status: 'retained', basis: 'user', note: 'Theirs.' },
    { name: 'merchant category and card type', rationale: 'Asked together.', status: 'unavailable', basis: 'user', note: 'They do not track either.' },
  ]);
  return recordSuccessCriteria(b, ['More eligible purchases converted before they lapse.']);
};

/**
 * The plan the manager approved, as the client posts it back.
 *
 * `confirmedStrategy` is populated by `CampaignDesigner`:
 * `setPendingStrategy(res.strategy ?? null)` on every non-error turn, posted
 * as `confirmedStrategy` when `intent === 'confirm'`. That chain is what makes
 * this check live in the app rather than only in tests, and the assertion
 * below pins it.
 */
const APPROVED = {
  summary: 'Catch them while the purchase is fresh.',
  approach: ['Everyone eligible enters.'],
  assumptions: [],
  unknowns: [],
  architectures: [
    { name: 'Catch the moment', barrier: 'cost-perception', entry: 'Every eligible purchase', timing: 'Within the hour', lever: 'message', journey: 'branch-on-response', mechanism: 'Say what it costs.', tradeoff: 'Needs the event fast.', chosen: true },
    { name: 'Work the statement date', barrier: 'cost-perception', entry: 'The same purchases', timing: 'Before the statement', lever: 'timing', journey: 'linear', mechanism: 'Pitch it with the bill.', tradeoff: 'Later.' },
  ],
  touches: [
    { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Opening.', ifStillUnconverted: 'If it is still sitting unread, send the same fact again sooner; if it is not delivered at all, SMS the same day.' },
    { day: 2, channel: 'SMS', path: 'all', purpose: 'Last chance.', ifStillUnconverted: 'If it was read and nothing happened, stop.' },
  ],
};

async function confirm(bodies: string[], strategy: unknown = APPROVED) {
  const calls = script(bodies);
  const gen = orchestrateStream({
    sessionId: 'canvas-must-react',
    tenantId: 'TEN-IBL',
    knowledge,
    discoveryRounds: 3,
    brief: settled(),
    intent: 'confirm',
    // Null, as the live client sends it: a propose turn carries no blueprint.
    confirmedBlueprint: null,
    confirmedStrategy: strategy,
    session: { state: 'AWAITING_STRATEGY_CONFIRMATION', strategyVersion: 1, confirmation: null },
    messages: [
      { role: 'user', content: 'Customers are not converting eligible purchases to EMI.' },
      { role: 'assistant', content: 'Here is the plan.' },
      { role: 'user', content: 'Confirmed. Build this campaign.' },
    ],
  } as never);
  let out = await gen.next();
  while (!out.done) out = await gen.next();
  return { res: out.value as unknown as Record<string, unknown>, calls };
}

const OLD = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.ANTHROPIC_API_KEY = OLD ?? 'test-key-not-real';
});

describe('a clock against a plan that promised a reaction', () => {
  it('asks for the journey again, and takes the success path when it reacts', async () => {
    const { res, calls } = await confirm([buildTurn(CLOCK), proseTurn('Built.'), buildTurn(REACTING)]);
    // The retry happened: a third call, beyond the two the rounds make.
    expect(calls()).toBeGreaterThan(2);
    expect(String(res.reply)).toContain('It is on the canvas now.');
    // Joined rather than `toContain(expect.stringContaining(...))`, which
    // compares elements by equality and would have passed whatever the array
    // held.
    expect((res.campaignBlockers as string[]).join(' ')).not.toMatch(/timed sequence/);
    expect(res.graph).toBeTruthy();
  });

  it('builds anyway when the second journey is still a clock, and says so first', async () => {
    const { res } = await confirm([buildTurn(CLOCK), proseTurn('Built.'), buildTurn(CLOCK)]);
    const reply = String(res.reply);
    // THE SUCCESS SENTENCE IS GONE, and the mismatch is in the first line
    // rather than three paragraphs down in an options table.
    expect(reply).not.toContain('It is on the canvas now.');
    expect(reply).toMatch(/I am not going to call that done/);
    expect(reply).toMatch(/The journey on the canvas is a timed sequence/);
    expect(reply).toMatch(/delivered, read or acted on/);
    expect(reply).toMatch(/split by ticket size is segmentation/);
    expect(reply).toMatch(/goal check after each send is the platform/);
    // Compiled anyway: an empty canvas helps nobody, same rule as a send with
    // no description.
    expect(res.graph).toBeTruthy();
    expect(Object.keys((res.graph as { nodes: Record<string, unknown> }).nodes).length).toBeGreaterThan(3);
    // A BLOCKER, NOT A FOOTNOTE.
    expect((res.campaignBlockers as string[])[0]).toMatch(/timed sequence/);
    // And no export invitation underneath a mismatch.
    expect(reply).not.toMatch(/You can export the configuration now/);
  });

  it('does nothing when the approved plan chose a clock itself', async () => {
    // `reactionBlocks` holds a linear winner at propose time. If one was
    // approved anyway, inventing a reaction nobody agreed to is not this
    // function's job — and the retry must not fire.
    const linear = { ...APPROVED, architectures: [{ ...APPROVED.architectures[1], chosen: true }, APPROVED.architectures[0]] };
    const { res, calls } = await confirm([buildTurn(CLOCK), proseTurn('Built.')], linear);
    expect(calls()).toBe(2);
    expect(String(res.reply)).toContain('It is on the canvas now.');
  });

  it('does nothing when no journey behaviour was declared, rather than guessing one', async () => {
    const { res, calls } = await confirm([buildTurn(CLOCK), proseTurn('Built.')], { ...APPROVED, architectures: [] });
    expect(calls()).toBe(2);
    expect(String(res.reply)).toContain('It is on the canvas now.');
  });
});

describe('the approved plan is read from where the client puts it', () => {
  it('the client posts the strategy it last received as confirmedStrategy', () => {
    // Pinned in the CLIENT, because this is the link that makes the check
    // live. Without it the build turn sees only the synthetic empty strategy
    // — measured on the live turn 4 — and the whole slice is inert in the app
    // while green here.
    expect(designer).toMatch(/setPendingStrategy\(res\.strategy \?\? null\)/);
    expect(designer).toMatch(/confirmedStrategy: opts\?\.intent === 'confirm' \? pendingStrategy : null/);
  });

  it('prefers the approved plan over the strategy this turn happens to carry', () => {
    expect(orch).toMatch(/const approvedStrategy = \(req\.confirmedStrategy \?\? proposed\.strategy\)/);
  });
});

describe('derive() stopped calling a who-split a reaction', () => {
  it('reads no branch-on-response out of the live turn-4 journey', () => {
    // THE SAME FALSE POSITIVE, one function further along. `derive` tagged
    // `branch-on-response` for ANY condition, so `checkFidelity` would have
    // confirmed a declared reaction against a campaign that branches on the
    // customer — blessing the exact build the retry refuses.
    const built = [...derive(bp(CLOCK))];
    expect(built).not.toContain('branch-on-response');
    expect(built).toContain('linear');
    expect(built).toContain('experiment');
  });

  it('reads one out of a fork on the delivery result', () => {
    expect([...derive(bp(REACTING))]).toContain('branch-on-response');
  });

  it('does not call a wait-for-event journey a branch as well', () => {
    // Tagged separately on purpose: `journeyReacts` is `reactsToDelivery` OR
    // a wait, which is the right question for "does this move at all". An
    // inventory of behaviours must not add a claim the agent never made.
    const built = [...derive(bp([send(), { kind: 'waitForEvent', eventCategory: 'EMI Events', eventType: 'EMI_STATUS_CHANGED', timeoutDays: 7 }, { kind: 'exit', reason: 'Done.' }]))];
    expect(built).toContain('wait-for-event');
    expect(built).not.toContain('branch-on-response');
  });

  it('shares one definition with journeyReacts rather than restating it', () => {
    // Two copies of this rule would drift, and the drift would be invisible:
    // both halves would still pass their own tests.
    const audit = readFileSync(new URL('../../server/architectureAudit.ts', import.meta.url), 'utf8');
    expect(audit).toMatch(/import \{ reactsToDelivery \} from '\.\/optionAudit'/);
    expect(audit).toMatch(/if \(reactsToDelivery\(bp\)\) found\.add\('branch-on-response'\)/);
    // And the condition case no longer tags anything by itself.
    expect(audit).not.toMatch(/'condition'\) \{ found\.add\('branch-on-response'\)/);
  });

  it('fails the turn-4 fixture if any condition counts again', () => {
    // The revert this slice is measured by, stated as the rule rather than as
    // a source grep: a journey whose only fork is an attribute split must
    // report no reaction, however the function is written.
    expect(reactsToDelivery(bp(CLOCK))).toBe(false);
    expect(derive(bp(CLOCK)).has('branch-on-response')).toBe(false);
  });
});

describe('fidelity runs on the turn that builds', () => {
  it('is handed the approved plan, not the empty strategy of the Confirm turn', () => {
    expect(orch).toMatch(/const architectureComparison = compareArchitectures\(approvedStrategy\?\.architectures\)/);
    expect(orch).toMatch(/const fidelity = checkFidelity\(approvedStrategy\?\.architectures, blueprint\)/);
  });

  it('says the built campaign is not the one that was chosen', async () => {
    // On live turn 4 this returned null — `architectures: []` on the turn's
    // own strategy — so the one check that asks "is this the campaign you
    // were sold" never ran on the only turn that builds one.
    const { res } = await confirm([buildTurn(CLOCK), proseTurn('Built.'), buildTurn(CLOCK)]);
    const warnings = ((res.strategy as { designWarnings?: string[] })?.designWarnings ?? []).join(' ');
    expect(warnings).toMatch(/Chose a "branch-on-response" journey/);
    expect(warnings).toMatch(/The strategy and the campaign disagree/);
  });

  it('stays quiet when the second journey does react', async () => {
    const { res } = await confirm([buildTurn(CLOCK), proseTurn('Built.'), buildTurn(REACTING)]);
    const warnings = ((res.strategy as { designWarnings?: string[] })?.designWarnings ?? []).join(' ');
    expect(warnings).not.toMatch(/The strategy and the campaign disagree/);
  });
});

describe('the comment that would undo all of this', () => {
  it('no longer claims confirmedStrategy is empty', () => {
    // It said "always undefined" and "no response has ever carried that
    // field". Both were wrong about the mechanism, and the correction cuts
    // both ways: key `approvedPlan` onto this field and discovery becomes
    // skippable; stop reading it for the plan's CONTENT and the reaction and
    // fidelity checks go inert again.
    const block = orch.slice(
      orch.indexOf('// A PLAN THE MANAGER ACTUALLY APPROVED'),
      orch.indexOf('const approvedPlan ='),
    );
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toMatch(/always undefined/);
    expect(block).not.toMatch(/no response has ever carried that field/);
    expect(block).not.toMatch(/the state it posts back is empty/);
    // And it still says why the flag is not keyed on it.
    // Split across two source lines by the comment wrap, so matched in two
    // pieces rather than as one span.
    expect(block).toMatch(/Confirmed\. Build this/);
    expect(block).toMatch(/DURING discovery/);
    expect(block).toMatch(/not evidence that discovery happened/);
  });
});

describe('the option-audit footnote survives', () => {
  it('still downgrades the claim, because this slice adds a consequence rather than replacing a report', () => {
    expect(orch).toMatch(/strategyOptions: applyAudit\(proposed\.strategy\.strategyOptions, optionAudits\)/);
    expect(orch).toMatch(/unsupportedClaims\(optionAudits\)/);
  });

  it('renderBuildSummary keeps the success sentence when nothing is wrong', () => {
    const out = renderBuildSummary(
      null,
      { graph: { nodes: { a: { type: 'SEND' }, b: { type: 'EXIT' } } }, issues: [], sendProposals: [] },
      { outcome: 'passed', checks: [], unverifiedHardConstraints: [] } as never,
      0,
      true,
    );
    expect(out).toContain('It is on the canvas now.');
    expect(out).toContain('You can export the configuration now.');
  });
});
