// A plan may not spend a signal it does not have, nor decline to produce one.
//
// THE LIVE EMI RUN, 2026-10-23, after discovery had finally asked the right
// question — "have you seen a pattern in who does this already, or do you not
// track it?" The manager answered plainly: they do not track prior EMI,
// merchant category or ticket size; they want one track; they want the first
// run to generate that signal.
//
// The strategy then did both wrong things at once:
//
//   1. It split day-0 copy by prior EMI versus first-time, and said the
//      manager had FLAGGED that factor — about a factor they had just said
//      they do not record. Listing something as untracked is not seeing a
//      trend in it.
//   2. It put the wording and dosage test in "hypotheses for future" instead
//      of running it over the seven days it was designing. There is no later
//      run to inherit a test: with nothing compared this time, the next
//      campaign starts exactly as blind.
//
// §2, §3 and §6 of the prompt already said all of this in words, and the run
// happened anyway — which is this repo's standing lesson about prompt rules.
// So the rules are checked against the proposal now, in the same shape as
// `cadenceBlocks`: BEFORE Confirm, never after.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { orchestrateStream } from '../../server/orchestrator';
import { seedKnowledgeBase } from '../../server/knowledge';
import { decide, trendBlocks } from '../../server/gate';
import { newBrief, recordAnswer, recordConverters, recordDimensions, recordSuccessCriteria } from '../../server/discovery';
import { discovered } from './support/findings';

const SYSTEM = (() => {
  const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
  return /const SYSTEM = `([\s\S]*?)`;\n/.exec(src)![1];
})();

const knowledge = seedKnowledgeBase();
const EMI =
  'Customers authorised for an EMI-eligible purchase are not converting. Get more of them to convert before the request expires.';

/**
 * The live brief: they answered the trends question with "we do not track it".
 *
 * The three factors are recorded the way the record actually holds them —
 * status `unavailable`, basis `user`, each with the manager's reason. That is
 * the distinction the whole slice turns on: the manager SAID these words, so
 * the basis is theirs, but they said the factor is not measured. A check that
 * read only the basis would take this as permission to split on prior EMI,
 * which is the defect.
 */
const noTrack = () => {
  let b = discovered(newBrief(EMI));
  b = recordAnswer(b, 'we do not track prior EMI, category or ticket size. one track. the first run should generate that signal.');
  // KNOWLEDGE IS 'known', AND THAT IS THE POINT, corrected 2026-10-23.
  //
  // The manager keeps saying "record that as known: every eligible purchase,
  // one track". They are describing WHO IS IN, which is the entry, and the
  // model files it as the converters finding being settled. The first
  // fixture used 'unknown' and so never met the brief the live run actually
  // produces — while `statedTrend` read `knowledge === 'known'` as a pattern
  // they had seen, which no-opped both rules on exactly that brief.
  //
  // An audience is not a trend. Nothing here says one group behaves
  // differently from another.
  b = recordConverters(b, {
    shape: 'every eligible purchase, one track, no split',
    basis: 'user',
    knowledge: 'known',
  });
  b = recordDimensions(b, [
    { name: 'Prior EMI usage', rationale: 'Someone who has done it before may need less explaining.', status: 'unavailable', basis: 'user', note: 'They said they do not track it.' },
    { name: 'Merchant category', rationale: 'What was bought may change the pitch.', status: 'unavailable', basis: 'user', note: 'They said they do not track it.' },
    { name: 'Ticket size', rationale: 'A larger balance costs more to carry.', status: 'unavailable', basis: 'user', note: 'They said they do not track it.' },
  ]);
  return recordSuccessCriteria(b, ['More authorised purchases converted before they lapse.']);
};

/** The same conversation, but they named a pattern they have actually seen. */
const sawATrend = () =>
  recordDimensions(noTrack(), [
    { name: 'Days left in the window', rationale: 'They said late ones almost never convert.', status: 'retained', basis: 'user', note: 'Their own observation.' },
  ]);

const touches = (path = 'all') => [
  { day: 0, channel: 'WHATSAPP', path, purpose: 'Say what the instalment costs.', ifStillUnconverted: 'Follow up on day 3.' },
  { day: 3, channel: 'SMS', path, purpose: 'Remind them the window closes.', ifStillUnconverted: 'Stop; it lapses.' },
];

const plan = (over: Record<string, unknown> = {}) => ({
  summary: 'Prompt conversion inside the open window.',
  approach: ['Everyone eligible enters.'],
  touches: touches(),
  assumptions: [],
  unknowns: [],
  ...over,
});

const OPTION = (option: string, verdict: string, why = 'because') => ({ option, verdict, why });

describe('a treatment split needs a trend the manager has seen', () => {
  it('refuses a copy split on a factor they said they do not track', () => {
    // The live failure, exactly: different day-0 copy for prior-EMI versus
    // first-time, on a brief where prior EMI is recorded as untracked.
    const blocks = trendBlocks(noTrack(), {
      strategy: plan({
        strategyOptions: [OPTION('Segmentation', 'used', 'Prior EMI users get a shorter explanation.')],
        touches: [...touches('Prior EMI users'), ...touches('First-time')],
      }),
    });
    expect(blocks.map((b) => b.code)).toContain('split-without-trend');
    expect(blocks[0].reason).toMatch(/nothing you have told me says those groups behave differently/);
  });

  it('catches the split even when the options list does not admit to one', () => {
    // A plan can cut the copy by path and still mark Segmentation
    // "not-applicable". The paths are the evidence; the verdict is a claim.
    const blocks = trendBlocks(noTrack(), {
      strategy: plan({
        strategyOptions: [OPTION('Segmentation', 'not-applicable', 'One track.')],
        touches: [...touches('Prior EMI users'), ...touches('First-time')],
      }),
    });
    expect(blocks.map((b) => b.code)).toContain('split-without-trend');
  });

  it('allows the same split once they have stated the trend', () => {
    const blocks = trendBlocks(sawATrend(), {
      strategy: plan({
        strategyOptions: [OPTION('Segmentation', 'used', 'Late ones get the urgent wording.')],
        touches: [...touches('Late in the window'), ...touches('Early in the window')],
      }),
    });
    expect(blocks).toEqual([]);
  });

  it('an experiment does not excuse the cut', () => {
    // THE SECOND HOLE. `tests` short-circuited the whole function, so
    // declaring a wording test anywhere in the plan legalised a prior-EMI
    // copy split. A test is not permission to cut on a factor nobody tracks.
    const blocks = trendBlocks(noTrack(), {
      strategy: plan({
        strategyOptions: [OPTION('Experimentation', 'used', 'Cost framing versus deadline framing.')],
        touches: [...touches('Prior EMI users'), ...touches('First-time')],
      }),
    });
    expect(blocks.map((b) => b.code)).toEqual(['split-without-trend']);
  });

  it('allows randomly assigned arms, which need no trend at all', () => {
    // An experiment arm is not a claim about who these people are, so it is
    // not a cut on a factor and needs nothing stated.
    const blocks = trendBlocks(noTrack(), {
      strategy: plan({
        strategyOptions: [OPTION('Experimentation', 'used', 'Two openings, randomly assigned.')],
        touches: [...touches('Arm A — cost framing'), ...touches('Arm B — deadline framing')],
      }),
    });
    expect(blocks).toEqual([]);
  });
});

describe('with no history, the first run has to test something', () => {
  it('refuses a flat plan that compares nothing', () => {
    const blocks = trendBlocks(noTrack(), { strategy: plan() });
    expect(blocks.map((b) => b.code)).toEqual(['nothing-tested']);
    expect(blocks[0].reason).toMatch(/compares nothing/);
  });

  it('refuses harder when the test was parked for a later run', () => {
    // The live shape: the right test, written into "hypotheses for future".
    const blocks = trendBlocks(noTrack(), {
      strategy: plan({ hypotheses: ['Wording: cost framing versus deadline framing.'] }),
    });
    expect(blocks.map((b) => b.code)).toEqual(['nothing-tested']);
    expect(blocks[0].reason).toMatch(/keeps its test for a future run/);
    expect(blocks[0].reason).toMatch(/no later run to inherit it/);
  });

  it('accepts a wording test', () => {
    expect(
      trendBlocks(noTrack(), {
        strategy: plan({ strategyOptions: [OPTION('Experimentation', 'used', 'Cost framing versus deadline framing.')] }),
      }),
    ).toEqual([]);
  });

  it('accepts a dosage test just as readily — the test is derived, not fixed', () => {
    // "Always run a copy test" would be its own standing list. What the rule
    // requires is a comparison, not a particular one.
    expect(
      trendBlocks(noTrack(), {
        strategy: plan({ strategyOptions: [OPTION('Experimentation', 'used', 'Two touches versus four over the window.')] }),
      }),
    ).toEqual([]);
  });

  it('a settled audience is not a trend, so it buys no exemption', () => {
    // REVERSED 2026-10-23. This used to assert that `knowledge: 'known'`
    // excused a flat plan, which is how the live brief slipped through both
    // rules: the manager says "record converters as known, every eligible
    // purchase, one track", and that is a statement about who ENTERS. Who is
    // in and who responds differently are different findings.
    let b = discovered(newBrief(EMI));
    b = recordConverters(b, { shape: 'every eligible purchase, one track', basis: 'user', knowledge: 'known' });
    expect(trendBlocks(b, { strategy: plan() }).map((x) => x.code)).toEqual(['nothing-tested']);
  });

  it('a retained trend they stated still exempts the plan', () => {
    // The release that remains, and the only one.
    expect(trendBlocks(sawATrend(), { strategy: plan({ touches: [...touches('Late in the window'), ...touches('Early')] }) })).toEqual([]);
  });
});

describe('the refusal happens before Confirm and never after', () => {
  it('is not raised on a build turn', () => {
    // Same rule as the cadence block. Once they have approved, refusing
    // leaves them with an approval that did nothing.
    const held = decide(noTrack(), { proposed: { strategy: plan() } });
    expect(held.proceed).toBe(false);
    expect(held.blocks.map((b) => b.code)).toContain('nothing-tested');
    const building = decide(noTrack(), { proposed: { strategy: plan() }, building: true });
    expect(building.blocks.map((b) => b.code)).not.toContain('nothing-tested');
  });

  it('names something the model can write, like every other block', () => {
    const [block] = trendBlocks(noTrack(), { strategy: plan() });
    expect(block.clears.field).toBe('experiment');
    expect(block.clears.how).toMatch(/wording, dosage, channel or timing/);
  });
});

// ---------------------------------------------------------------------------
// End to end: does the turn actually stop at the gate?
// ---------------------------------------------------------------------------

const sse = (events: Record<string, unknown>[]) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

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
    return new Response(new TextEncoder().encode(body), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
}

const BLUEPRINT = {
  campaignName: 'Authorisation to EMI',
  description: 'Prompt conversion inside the open window.',
  goal: null,
  entry: { kind: 'audience', entity: 'Card', conditions: [{ attribute: 'Status', operator: 'Equals', value: 'Active' }] },
  steps: [
    { kind: 'send', name: 'Cost reframe', objective: ['emi', 'convert'], stage: 'first-touch', describe: 'What the instalment costs.', copy: 'Split this purchase.', channelPreference: ['WHATSAPP'], barrier: 'cost-perception' },
    { kind: 'wait', durationHours: 72, why: 'Give them time.' },
    { kind: 'send', name: 'Window closing', objective: ['emi', 'expiry'], stage: 'reminder', describe: 'It lapses soon.', copy: 'Closing soon.', channelPreference: ['SMS'], barrier: 'cost-perception' },
    { kind: 'exit', reason: 'The window closed.' },
  ],
};

async function proposeTurn(strategy: unknown) {
  script([jsonTurn({ action: 'propose', strategy, blueprint: BLUEPRINT, openItems: [] })]);
  const gen = orchestrateStream({
    sessionId: 'first-run',
    tenantId: 'TEN-IBL',
    knowledge,
    discoveryRounds: 3,
    brief: noTrack(),
    messages: [
      { role: 'user', content: EMI },
      { role: 'user', content: 'we do not track that. one track. let the first run tell us.' },
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

describe('the turn itself stops short of Confirm', () => {
  it('a flat plan on a no-track brief does not reach awaiting-confirmation', async () => {
    const res = await proposeTurn(plan());
    expect(res.phase).not.toBe('awaiting-confirmation');
    expect(res.pendingBlueprint ?? null).toBeNull();
    expect(String(res.reply ?? '')).toMatch(/compares nothing|keeps its test for a future run/);
  });

  it('the same plan with a derived test does reach it', async () => {
    const res = await proposeTurn(
      plan({ strategyOptions: [OPTION('Experimentation', 'used', 'Cost framing versus deadline framing, randomly assigned.')] }),
    );
    expect(res.phase).toBe('awaiting-confirmation');
    expect(res.strategy).toBeTruthy();
  });
});

describe('the prompt no longer fights the rule', () => {
  it('asks for candidate TRENDS, not segments to wait on', () => {
    // The leftover line told the agent to "give TWO candidate segments
    // resting on different things and wait for their reaction" — a targeting
    // menu, and a wait that `convertersSettled` stopped requiring.
    expect(SYSTEM).not.toMatch(/TWO candidate segments/);
    expect(SYSTEM).not.toMatch(/wait for their reaction/);
    expect(SYSTEM).toMatch(/name two candidate TRENDS resting on different things/);
    expect(SYSTEM).toMatch(/a trend nobody has seen is what the campaign MEASURES, not what it acts on/);
  });

  it('never models a rupee figure inside a question', () => {
    // The run invented "₹3,000 versus ₹60,000" while asking whether success
    // is counted or valued. The ban already existed; what matters is that no
    // application-authored copy demonstrates the opposite.
    expect(SYSTEM).toMatch(/Never supply a sample answer, a rupee figure or a number of days alongside a question/);
    const questionCopy = SYSTEM.split('\n').filter((l) => /\?|ask/i.test(l));
    for (const line of questionCopy) expect(line, line.slice(0, 60)).not.toMatch(/₹\s?[0-9]/);
  });

  it('still forbids a click condition on a channel that cannot report one', () => {
    expect(SYSTEM).toMatch(/Never put a click condition on a WhatsApp or SMS send/);
  });
});
