// A plan ready to approve must not arrive looking like a form.
//
// THE LIVE RUN, EMI. The strategy appeared with Confirm and one numbered
// question underneath it — "Does every EMI-eligible purchase share the same
// 7-day expiry?" Answering that question is what took the manager off
// Confirm: the reply became a discovery turn, and the plan they were one
// click from approving went back into the conversation. Clicking Confirm
// instead produced the graph immediately.
//
// So the highest-frequency miss on this path is not the compiler. It is the
// PAIRING — an approvable plan shown beside something that reads as a
// questionnaire — and the thing that made it a questionnaire was the
// application, not the model:
//
//   - `recordQuestions` put the leftovers on the brief as OUTSTANDING, which
//     makes the next typed message an answer rather than a decision;
//   - the response returned them in `questions`, which the client renders as
//     a numbered list under the agent's own message.
//
// Both stop on this path. Nothing is hidden: these items are
// `strategic-ambiguity` by construction, they were already in
// `gate.openItems`, and `renderStrategy` already prints that kind under
// "Worth settling before this is built".
//
// DISCOVERY BEFORE A STRATEGY IS UNCHANGED, and the last describe here is
// what holds that: `ask_questions` still returns numbered questions, still
// capped at three, and still records them. There is no plan to approve on
// that turn, so asking is the whole point.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { orchestrateStream } from '../../server/orchestrator';
import { seedKnowledgeBase } from '../../server/knowledge';
import { evaluateDiscovery, newBrief, recordDimensions, recordSuccessCriteria, type OpenItem } from '../../server/discovery';
import { decide } from '../../server/gate';
import { canTransition } from '../../server/campaignState';
import { discovered } from './support/findings';

const knowledge = seedKnowledgeBase();

const EMI =
  'Customers authorised for an EMI-eligible purchase are not converting. Get more of them to convert before the request expires.';

/** The question from the live run, as the agent declared it. */
const EXPIRY = 'Does every EMI-eligible purchase share the same 7-day expiry?';

const OPEN_ITEMS: OpenItem[] = [
  {
    kind: 'strategic-ambiguity',
    question: EXPIRY,
    whyItMatters: 'It decides whether the last nudge lands before the request lapses.',
    ifUnanswered: 'A timed wait sized to the stated 7-day window.',
  },
];

/** A brief that has finished discovery, because a proposal follows one. */
const settled = () => {
  let b = discovered(newBrief(EMI));
  b = recordDimensions(b, [
    { name: 'Days left in the authorisation window', rationale: 'Late is different from early.', status: 'retained', basis: 'user' },
  ]);
  return recordSuccessCriteria(b, ['More authorised purchases converted to EMI before they lapse.']);
};

const STRATEGY = {
  summary: 'Prompt conversion twice inside the open window, before the request lapses.',
  approach: [
    'Entry on an approved EMI-eligible authorisation, because that is the moment eligibility begins.',
    'Two touches rather than three: the window is short and the message cap is 4.',
  ],
  // AND A DECLARED TEST, since 2026-10-23, for exactly the same reason the
  // sends were named above. `trendBlocks` refuses a plan that compares
  // nothing when the manager has stated no trend, so without this the
  // payload would be held for a second reason and the test would stop
  // proving anything about the open points.
  strategyOptions: [
    { option: 'Experimentation', verdict: 'used', why: 'Cost framing versus deadline framing, randomly assigned.' },
  ],
  // AND A WINNER THAT REACTS, plus a fallback that tells the three
  // non-converters apart, since 2026-10-23. Same reason again:
  // `reactionBlocks` refuses a plan paced off the calendar, and a payload held
  // for a second reason proves nothing about the open points.
  architectures: [
    {
      name: 'Catch the authorisation', barrier: 'cost-perception', audience: 'Every approved EMI-eligible authorisation',
      timing: 'Within the hour', lever: 'message', journey: 'branch-on-response',
      mechanism: 'Say what the instalment costs while the purchase is fresh.', tradeOff: 'Needs the event quickly.', chosen: true,
    },
    {
      name: 'Work the statement date', barrier: 'cost-perception', audience: 'The same purchases, at the statement run',
      timing: 'Two days before the statement', lever: 'timing', journey: 'linear',
      mechanism: 'Pitch it when the bill is in view.', tradeOff: 'Later, and the request may have lapsed.',
    },
  ],
  touches: [
    { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Say the purchase can be split, and what it costs.', ifStillUnconverted: 'If it is still sitting unread, send the same fact again sooner; if it is not delivered at all, SMS the same day.' },
    { day: 3, channel: 'SMS', path: 'all', purpose: 'Remind them the window closes.', ifStillUnconverted: 'If it was read and nothing happened, stop. The request lapses.' },
  ],
  assumptions: ['Silent non-conversion means no EMI request is raised at all.'],
  unknowns: [],
};

const BLUEPRINT = {
  campaignName: 'Authorisation to EMI',
  description: 'Prompt conversion inside the open window.',
  goal: null,
  entry: {
    kind: 'audience',
    entity: 'Card',
    conditions: [{ attribute: 'Status', operator: 'Equals', value: 'Active' }],
  },
  steps: [
    {
      kind: 'send',
      name: 'Cost reframe',
      objective: ['emi', 'convert'],
      stage: 'first-touch',
      describe: 'Show what the instalment actually costs.',
      copy: 'Split this purchase from ₹2,100 a month.',
      channelPreference: ['WHATSAPP'],
      // Cited, because `checkBarrierCoverage` refuses a send that attacks no
      // recorded barrier long before any of this is reached.
      barrier: 'cost-perception',
    },
    // AND ONE ENGAGEMENT FORK, since 2026-10-23. The declared winner is
    // branch-on-response and `reactionBlocks` now reads the STEPS as well as
    // the essay, so a clock here would hold this turn for a second reason and
    // the test would stop proving anything about the open points. Fourth note
    // of this kind on this fixture; the pattern is in server/CLAUDE.md.
    {
      kind: 'branch',
      label: 'What happened to the first message',
      paths: [
        {
          label: 'Delivered, still unread',
          statuses: ['DELIVERED'],
          steps: [
            { kind: 'wait', durationHours: 24, why: 'It is sitting unopened.' },
            { kind: 'send', name: 'Same fact, sooner', objective: ['emi', 'convert'], stage: 'reminder', describe: 'Repeat that it qualifies.', copy: 'Still available.', channelPreference: ['WHATSAPP'], barrier: 'cost-perception' },
          ],
        },
        {
          label: 'Read, not booked',
          statuses: ['READ'],
          steps: [
            { kind: 'send', name: 'What it costs a month', objective: ['emi', 'expiry'], stage: 'outcome', describe: 'Argue the instalment.', copy: 'From Rs 2,100 a month.', channelPreference: ['SMS'], barrier: 'cost-perception' },
          ],
        },
      ],
    },
    { kind: 'exit', reason: 'The authorisation window has closed.' },
  ],
};

const sse = (events: Record<string, unknown>[]) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

/** One turn of model output, as a JSON payload in the text. */
const jsonTurn = (payload: unknown) =>
  sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: JSON.stringify(payload) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 300 } },
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

async function turn(payload: unknown, brief: unknown) {
  script([jsonTurn(payload)]);
  const gen = orchestrateStream({
    sessionId: 'swq',
    tenantId: 'TEN-IBL',
    knowledge,
    discoveryRounds: 3,
    brief,
    messages: [
      { role: 'user', content: EMI },
      { role: 'user', content: 'Yes, every eligible purchase. Go on.' },
    ],
    session: { state: 'DISCOVERING', strategyVersion: 0, confirmation: null },
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

describe('the fixture really is the strategy_with_questions path', () => {
  it('has a brief the gate lets through', () => {
    // Otherwise the turn is held in discovery and proves nothing about the
    // proposal — the same trap the Confirm fixture documents.
    expect(decide(settled()).proceed).toBe(true);
  });

  it('and a strategic ambiguity that the gate would have asked', () => {
    const g = evaluateDiscovery({
      brief: settled(),
      modelAction: 'propose',
      modelQuestions: [],
      modelEvidence: [],
      openItems: OPEN_ITEMS,
      forced: false,
      maxRounds: 8,
    } as never);
    expect(g.outcome).toBe('strategy_with_questions');
    // The gate still FORMS the question — this is not a change to the gate.
    // What changes is what the application does with it afterwards.
    expect(g.questions.map((q) => (typeof q === 'string' ? q : q.text)).join(' ')).toContain(EXPIRY);
  });
});

describe('a proposal with open points is still a proposal', () => {
  it('returns the strategy and the blueprint, ready to confirm', async () => {
    const res = await turn({ action: 'propose', strategy: STRATEGY, blueprint: BLUEPRINT, openItems: OPEN_ITEMS }, settled());
    expect(res.phase).toBe('awaiting-confirmation');
    expect(res.strategy).toBeTruthy();
    // `pendingBlueprint` is null here ON PURPOSE and that is not this slice:
    // a propose turn carries no blueprint, because the plan is agreed in
    // business terms before it is mapped to the builder. Confirm is offered
    // off the PHASE, and the live Confirm posts `confirmedBlueprint: null`.
    expect(res.pendingBlueprint ?? null).toBeNull();

    // THE SESSION STATE IS NOT YET AWAITING_STRATEGY_CONFIRMATION, and that
    // surprised me, so it is worth writing down. The propose return happens
    // BEFORE the STRATEGY_READY -> AWAITING_STRATEGY_CONFIRMATION hops; a
    // Confirm turn re-enters the same code with `isBuildTurn` true, walks
    // those hops itself, and only then opens the door to generation. Verified
    // against the live record: the recorded propose turn returns
    // `phase: awaiting-confirmation` with `state: AWAITING_USER_ANSWER`.
    //
    // What matters is that the door is still REACHABLE, because
    // AWAITING_USER_ANSWER cannot enter generation directly — a propose turn
    // that left the state somewhere else would turn the next Confirm into the
    // "Illegal state transition" crash all over again.
    const state = (res.session as { state: string }).state;
    expect(canTransition(state, 'STRATEGY_READY')).toBe(true);
    expect(canTransition('STRATEGY_READY', 'AWAITING_STRATEGY_CONFIRMATION')).toBe(true);
    expect(canTransition('AWAITING_STRATEGY_CONFIRMATION', 'GENERATING_CAMPAIGN')).toBe(true);
  });

  it('returns NO questions, which is what the client draws as a numbered list', async () => {
    const res = await turn({ action: 'propose', strategy: STRATEGY, blueprint: BLUEPRINT, openItems: OPEN_ITEMS }, settled());
    expect(res.questions).toEqual([]);
  });

  it('does not put the point on the brief as something outstanding', async () => {
    // THE MECHANISM THAT MOVED THEM OFF CONFIRM. An outstanding question makes
    // the next typed message an ANSWER — a discovery turn — rather than a
    // decision about the plan.
    const res = await turn({ action: 'propose', strategy: STRATEGY, blueprint: BLUEPRINT, openItems: OPEN_ITEMS }, settled());
    const brief = res.brief as { questions?: { text: string }[] };
    expect((brief.questions ?? []).map((q) => q.text).join(' ')).not.toContain(EXPIRY);
  });

  it('says it anyway, as an open point on the plan', async () => {
    // Suppressing the question must not suppress the POINT. It is in the
    // agent's own message, under the heading for its kind.
    const res = await turn({ action: 'propose', strategy: STRATEGY, blueprint: BLUEPRINT, openItems: OPEN_ITEMS }, settled());
    const reply = String(res.reply ?? '');
    expect(reply).toContain(EXPIRY);
    expect(reply).toMatch(/Worth settling before this is built/);
  });
});

describe('discovery before a strategy is untouched', () => {
  it('still returns numbered questions, still capped at three', async () => {
    const res = await turn(
      {
        action: 'ask',
        questions: [
          'What counts as a conversion here?',
          'How do you judge whether this worked?',
          'Who converts today?',
          'A fourth question that must not travel.',
        ],
      },
      newBrief(EMI),
    );
    expect(res.phase).toBe('discovery');
    const qs = res.questions as string[];
    expect(qs.length).toBeGreaterThan(0);
    expect(qs.length).toBeLessThanOrEqual(3);
    expect(res.strategy ?? null).toBeNull();
  });

  it('still records them, so the next message is read as an answer', async () => {
    const res = await turn(
      { action: 'ask', questions: ['What counts as a conversion here?'] },
      newBrief(EMI),
    );
    const brief = res.brief as { questions?: { text: string }[] };
    expect((brief.questions ?? []).length).toBeGreaterThan(0);
  });
});
