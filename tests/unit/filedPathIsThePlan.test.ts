// A FILED PATH IS THE PLAN. CONFIRM IS HOW THEY ACCEPT IT.
//
// MEASURED, `eval/runs/ui-s-1792843757296` turn 3. Discovery was finished,
// `decide(brief)` was empty, the turn was ready, the lookups ran. The first
// `propose_strategy` sent `blueprint` as a JSON string and was refused; the
// second was accepted — "Plan recorded, with a 1-step path" — and stashed on
// `brief.lastProposal`: a ticket-size branch, an experiment on the smaller
// band, and inside it an outcome fork on READ against DELIVERED/DELETED.
//
// Confirm never appeared. The response was `phase: 'discovery'`,
// `strategy: null`, `pendingBlueprint: null`, and the manager got the essay
// plus a hold saying the journey does not react.
//
// STEP 0 WAS TO MEASURE RATHER THAN ASSUME, and it changed the fix:
//
//     journeyReacts(brief.lastProposal.blueprint) === TRUE
//
// The steps really do fork on what the customer did. Nothing needed
// stripping. What held the turn was `reactionBlocks` returning on
// `namedOutcomes` over the touch PROSE — `ifStillUnconverted` named one
// landed case — before it ever read `p.blueprint`. Vocabulary beat the path,
// and a rule written on the assumption that this journey was a clock would
// have stripped a real fork.
//
// "1-step path" is the same confusion in miniature: `steps` held one
// `branch` carrying eight nested sends.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { orchestrateStream } from '../../server/orchestrator';
import { seedKnowledgeBase } from '../../server/knowledge';
import { newBrief, recordDimensions, recordSuccessCriteria } from '../../server/discovery';
import { discovered } from './support/findings';
import { decide, turnPhase, reactionBlocks, alignJourneyClaim, shapedBlueprint, READ_FORK_ADVICE } from '../../server/gate';
import { journeyReacts } from '../../server/optionAudit';
import { previewFromBlueprint } from '../../src/designer/preview';
import type { WorkingBrief } from '../../server/discovery';

/**
 * That run's turn-3 brief, byte-for-byte, copied into the repo.
 *
 * `eval/runs/` is gitignored — the transcripts are ~47MB and regenerable — so
 * reading it from there would pass here and fail from a clone. This is
 * `turn.response.brief` re-serialised and nothing else: `lastProposal` carries
 * the strategy and the path exactly as the tool accepted them.
 */
const live = (): WorkingBrief =>
  JSON.parse(
    readFileSync(new URL('./support/liveBriefs/ui-s-1792843757296.turn-3.brief.json', import.meta.url), 'utf8'),
  ) as WorkingBrief;

const filed = () => {
  const lp = live().lastProposal!;
  return { strategy: lp.strategy, openItems: [], blueprint: lp.blueprint } as never;
};

describe('the live brief that had a journey and showed none', () => {
  it('STEP 0: the steps react, so there was never a false claim here', () => {
    const lp = live().lastProposal!;
    expect(shapedBlueprint(lp.blueprint as never)).toBe(true);
    expect(journeyReacts(lp.blueprint as never)).toBe(true);
    // The claim and the path agree, so nothing is rewritten.
    const aligned = alignJourneyClaim(filed());
    expect(aligned.stripped).toBe(false);
    expect(aligned.proposed!.strategy!.architectures!.find((a: { chosen?: boolean }) => a.chosen)!.journey).toBe(
      'branch-on-response',
    );
    // And no advice, because there is nothing to advise: the fork is there.
    expect(aligned.advice).toEqual([]);
  });

  it('the fork is an outcome branch on READ against DELIVERED/DELETED', () => {
    // Read off the fixture rather than described, so a future "tidy-up" of
    // the engagement arms cannot quietly make this test about nothing.
    const json = JSON.stringify(live().lastProposal!.blueprint);
    expect(json).toContain('"statuses"');
    expect(json).toContain('"READ"');
    expect(json).toContain('"DELIVERED"');
    expect(json).toContain('"DELETED"');
  });

  it('is not held, and the prose that held it is no longer consulted', () => {
    expect(reactionBlocks(filed())).toEqual([]);
    const d = decide(live(), { proposed: filed() });
    expect(d.blocks.map((b) => b.code), d.blocks.map((b) => b.reason).join(' | ')).toEqual([]);
    expect(d.proceed).toBe(true);
    expect(d.forcedBy).toBeUndefined();
  });

  it('IS READY, with nothing typed', () => {
    expect(turnPhase(live(), { isBuildTurn: false, limitReached: false })).toBe('ready');
  });

  it('draws: the path the tool accepted can be previewed', () => {
    const p = previewFromBlueprint(live().lastProposal!.blueprint as never);
    expect(p).not.toBeNull();
    // Every path of the fork is drawn, the empty one included — the rule the
    // preview exists for. Read off the whole structure rather than the top
    // row: a fork's arms are NESTED under it, which is the same thing the
    // "1-step path" message got wrong at the other end.
    const drawn = JSON.stringify(p);
    for (const arm of ['High ticket', 'Standard ticket', 'Read, no action', 'Not read / deleted']) {
      expect(drawn, arm).toContain(arm);
    }
    expect(p!.rows.length).toBeGreaterThan(0);
  });
});

describe('the held branch keeps the path it has on file', () => {
  const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');

  it('returns the filed path as pendingBlueprint rather than null', () => {
    const held = orch.slice(orch.indexOf('if (!decision.proceed && !approvedPlan) {'), orch.indexOf('  // Discovery is complete.'));
    expect(held).toMatch(/pendingBlueprint: filedPath/);
    expect(held).toMatch(/shapedBlueprint\(brief\.lastProposal\?\.blueprint as never\)/);
    // AND NOTHING THAT MEANS AGREED OR BUILT.
    expect(held).toMatch(/strategy: null/);
    expect(held).toMatch(/blueprint: null/);
    // TWO SCREENS NOW: `discovery` while the RECORD is open, `revising` once
    // it is closed and only the plan needs a change. Neither is
    // `awaiting-confirmation`, so Confirm cannot appear from here.
    expect(held).toMatch(/phase: briefClosed \? planOrRevise\(filedPath\) : 'discovery',/);
    expect(held).not.toMatch(/awaiting-confirmation/);
  });

  it('only a SHAPED path travels, so captions never reach the canvas', () => {
    expect(shapedBlueprint({ steps: ['Day 0 WhatsApp'] } as never)).toBe(false);
    expect(shapedBlueprint({ steps: [] } as never)).toBe(false);
    expect(shapedBlueprint(null)).toBe(false);
    expect(shapedBlueprint(live().lastProposal!.blueprint as never)).toBe(true);
  });
});

describe('a claim the steps do not support is repaired, not refused', () => {
  const clock = {
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
          { label: 'High ticket', operator: 'Greater than', value: '10000', steps: [{ kind: 'send', name: 'A', objective: ['emi'], stage: 'first-touch', describe: 'd', channelPreference: ['WHATSAPP'], barrier: 'b' }] },
          { label: 'Everyone else', operator: 'Less than', value: '10000', steps: [{ kind: 'send', name: 'B', objective: ['emi'], stage: 'first-touch', describe: 'd', channelPreference: ['WHATSAPP'], barrier: 'b' }] },
        ],
      },
    ],
  };
  const claiming = (journey: string) => ({
    summary: 's',
    approach: ['a'],
    architectures: [
      { name: 'Catch the moment', journey, chosen: true },
      { name: 'Statement date', journey: 'linear' },
    ],
  });

  it('rewrites the label, keeps the who-split, invents no fork', () => {
    const before = JSON.stringify(clock);
    const aligned = alignJourneyClaim({ strategy: claiming('branch-on-response'), blueprint: clock } as never);
    expect(aligned.stripped).toBe(true);
    expect(aligned.proposed!.strategy!.architectures!.find((a: { chosen?: boolean }) => a.chosen)!.journey).toBe('linear');
    // The rival's label is untouched; only the winner's claim was wrong.
    expect(aligned.proposed!.strategy!.architectures![1].journey).toBe('linear');
    expect(JSON.stringify(aligned.proposed!.blueprint)).toBe(before);
    expect(aligned.advice.join(' ')).toMatch(/read-fork on the first WhatsApp/);
  });

  it('is idempotent, so a plan that was already honest passes through', () => {
    const honest = { strategy: claiming('linear'), blueprint: clock } as never;
    const once = alignJourneyClaim(honest);
    const twice = alignJourneyClaim(once.proposed!);
    expect(once.stripped).toBe(false);
    expect(twice.stripped).toBe(false);
    expect(JSON.stringify(twice.proposed)).toBe(JSON.stringify(once.proposed));
  });

  it('does not repair a plan with no path — there is nothing to approve', () => {
    const aligned = alignJourneyClaim({ strategy: claiming('branch-on-response'), blueprint: null } as never);
    expect(aligned.stripped).toBe(false);
    expect(aligned.advice).toEqual([]);
    expect(reactionBlocks({ strategy: claiming('branch-on-response'), blueprint: null } as never).map((b) => b.code)).toEqual([
      'no-reaction',
    ]);
  });
});

// THE SENTENCE HAS TO BE NEXT TO THE BUTTON.
//
// MEASURED. `alignJourneyClaim` puts `READ_FORK_ADVICE` on `aligned.advice`,
// `decide` merges it into `decision.advice`, and the HELD branch prints that
// list through `renderBlocks`. The return a manager actually sees Confirm on
// — `phase: 'awaiting-confirmation'`, `reply: renderStrategy(...)` — never
// received it. So a who-split clock that is allowed through, which is now the
// common case, reached Confirm with nothing said about what a read-fork would
// have added. Proving it on `decision.advice` proved the wrong half.
//
// DRIVEN THROUGH `orchestrateStream`, not asserted on the source, so the
// reply is the one the client would render.
describe('a clock that is allowed through still owes one sentence', () => {
  const knowledge = seedKnowledgeBase();
  const EMI = 'Customers are not converting eligible purchases to EMI. Get more of them converting.';

  /** Discovery finished, one seen axis, so only the proposal is on trial. */
  const settled = () => {
    let b = discovered(newBrief(EMI));
    b = recordDimensions(b, [
      { name: 'Transaction ticket size', rationale: 'They said bigger ones convert.', status: 'retained', basis: 'user', note: 'Theirs.' },
      { name: 'merchant category', rationale: 'Asked about it together.', status: 'unavailable', basis: 'user', note: 'They do not track it.' },
    ]);
    return recordSuccessCriteria(b, ['More eligible purchases converted before they lapse.']);
  };

  const send = (over: Record<string, unknown> = {}) => ({
    kind: 'send',
    name: 'Opening',
    objective: ['emi', 'convert'],
    stage: 'first-touch',
    describe: 'Say the purchase can be split.',
    copy: 'Split this purchase into instalments.',
    channelPreference: ['WHATSAPP'],
    barrier: 'cost-perception',
    ...over,
  });

  /** A who-split clock: a ticket band, a wait, a reminder. No engagement fork. */
  const CLOCK_PATH = {
    campaignName: 'Eligible purchase to EMI',
    description: 'Catch them while the purchase is fresh.',
    goal: null,
    entry: { kind: 'audience', entity: 'Card', conditions: [{ attribute: 'Status', operator: 'Equals', value: 'Active' }] },
    steps: [
      {
        kind: 'branch',
        label: 'Ticket band',
        entity: 'Transaction',
        attribute: 'Transaction Amount',
        paths: [
          {
            label: 'High ticket',
            operator: 'Greater than',
            value: '10000',
            steps: [send(), { kind: 'wait', durationHours: 48, why: 'Give them a day.' }, send({ name: 'Reminder', stage: 'reminder' })],
          },
          {
            label: 'Everyone else',
            operator: 'Less than',
            value: '10000',
            steps: [send({ name: 'Other opening' }), { kind: 'wait', durationHours: 72, why: 'Give them longer.' }, send({ name: 'Other reminder', stage: 'reminder' })],
          },
        ],
      },
    ],
  };

  /**
   * THE JSON PROPOSE PATH NESTS THE STRATEGY, and a flat payload here read as
   * an empty plan: `renderStrategy` printed "Here is the strategy." and one
   * design warning. The TOOL path is flat (`applyOutputTool` reads
   * `obj as Strategy`); `{ action: 'propose', strategy, blueprint }` is not.
   * Worth the note, because a fixture that silently proposes nothing proves
   * nothing.
   */
  const CLOCK_STRATEGY = {
    summary: 'Catch them while the purchase is fresh, harder on the bigger tickets.',
    approach: ['Everyone eligible enters.', 'The ticket band decides the cadence.'],
    strategyOptions: [{ option: 'Experimentation', verdict: 'used', why: 'Cost framing versus deadline framing, randomly assigned.' }],
    architectures: [
      {
        name: 'Catch the moment', barrier: 'cost-perception', audience: 'Every eligible purchase',
        timing: 'On posting', lever: 'message', journey: 'branch-on-response',
        mechanism: 'Say what the instalment costs while it is fresh.', tradeOff: 'Needs the event quickly.', chosen: true,
      },
      {
        name: 'Work the statement date', barrier: 'cost-perception', audience: 'The same purchases later',
        timing: 'Before the statement', lever: 'timing', journey: 'linear',
        mechanism: 'Pitch it when the bill is in view.', tradeOff: 'The window may have closed.',
      },
    ],
    touches: [
      { day: 0, channel: 'WHATSAPP', path: 'High ticket', purpose: 'Say it can be split.', ifStillUnconverted: 'If it is still unread, repeat the fact sooner.' },
      { day: 2, channel: 'SMS', path: 'High ticket', purpose: 'Last chance.', ifStillUnconverted: 'If they read it and did nothing, stop.' },
      { day: 0, channel: 'WHATSAPP', path: 'Everyone else', purpose: 'Say it can be split.', ifStillUnconverted: 'If it is still unread, repeat the fact sooner.' },
      { day: 3, channel: 'SMS', path: 'Everyone else', purpose: 'Last chance.', ifStillUnconverted: 'If they read it and did nothing, stop.' },
    ],
    assumptions: [],
    unknowns: [],
  };

  const CLOCK_PLAN = { action: 'propose', strategy: CLOCK_STRATEGY, blueprint: CLOCK_PATH, openItems: [] };

  const sse = (events: Record<string, unknown>[]) =>
    events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

  const proposeTurn = async (payload: unknown) => {
    vi.stubGlobal('fetch', async () =>
      new Response(
        new TextEncoder().encode(
          sse([
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: JSON.stringify(payload) } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 300 } },
          ]),
        ),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
    const gen = orchestrateStream({
      sessionId: 'clock-advice',
      tenantId: 'TEN-IBL',
      knowledge,
      discoveryRounds: 3,
      brief: settled(),
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

  it('the fixture really is a clock the gate lets through', () => {
    expect(decide(settled()).proceed).toBe(true);
    expect(journeyReacts(CLOCK_PATH as never)).toBe(false);
    const d = decide(settled(), { proposed: { strategy: CLOCK_STRATEGY, blueprint: CLOCK_PATH } as never });
    expect(d.blocks.map((b) => b.code), d.blocks.map((b) => b.reason).join(' | ')).toEqual([]);
    expect(d.advice.join(' ')).toContain(READ_FORK_ADVICE);
  });

  it('reaches Confirm AND says it, in the reply the manager reads', async () => {
    const res = await proposeTurn(CLOCK_PLAN);
    expect(res.phase).toBe('awaiting-confirmation');
    expect(String(res.reply)).toContain(READ_FORK_ADVICE);
    // Not a question and not a numbered list beside an approvable plan.
    expect(res.questions).toEqual([]);
    expect(String(res.reply)).not.toMatch(/^\s*\d[.)]\s/m);
    // The plan and its path are what they are approving.
    expect(res.strategy).toBeTruthy();
    expect(res.pendingBlueprint).toBeTruthy();
    // And the claim was repaired to match the steps before they saw it.
    expect((res.strategy as { architectures?: { journey?: string; chosen?: boolean }[] }).architectures!.find((a) => a.chosen)!.journey).toBe('linear');
  });

  it('a reacting path gets Confirm with no lecture', async () => {
    const reacting = { ...CLOCK_PLAN, blueprint: live().lastProposal!.blueprint };
    const res = await proposeTurn(reacting);
    expect(res.phase).toBe('awaiting-confirmation');
    expect(String(res.reply)).not.toContain(READ_FORK_ADVICE);
    expect((res.strategy as { architectures?: { journey?: string; chosen?: boolean }[] }).architectures!.find((a) => a.chosen)!.journey).toBe(
      'branch-on-response',
    );
  });
});
