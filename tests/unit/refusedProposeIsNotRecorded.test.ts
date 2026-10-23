// The turn that ended "Recorded."
//
// `eval/runs/ui-s-1792735473522/turns/turn-3.json`, end to end. The manager
// had answered three things in one message: ₹10k purchases convert more, they
// do not realise the purchase qualifies, and it usually happens within thirty
// minutes. The agent recorded all of it and wrote a real plan.
//
// Then four application failures in a row, each one feeding the next:
//
//   1. `propose_strategy` refused the plan because both architectures cited
//      the one barrier the manager had given, and told it to record a second
//      explanation with basis "assumption" — the application asking the agent
//      to invent a customer problem.
//   2. It obeyed. The follow-up `record_findings` carried ONLY the invented
//      rival, and replace-on-sent deleted `awareness-gap`. The brief ended the
//      turn holding one assumption the agent had made up and nothing the
//      manager had said.
//   3. The ok string reported "0 barrier(s)" — a delta, printed four times
//      while a barrier existed — so the agent had no way to see what it had
//      just done.
//   4. The round ran out, nothing was proposed, and the fallback told the
//      manager "Recorded."
//
// The plan was in the request the whole time.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { orchestrateStream } from '../../server/orchestrator';
import { seedKnowledgeBase } from '../../server/knowledge';
import { applyOutputTool } from '../../server/outputTools';
import { newBrief, recordAnswer, recordBarriers, recordConverters, recordDimensions, recordSuccessCriteria, briefBarriers } from '../../server/discovery';
import { reactingPath } from './support/journeys';

const knowledge = seedKnowledgeBase();
const EMI = 'Customers are not converting their eligible purchases to EMI. Get more of them converting.';

/** What they actually said, and what the agent recorded from it. */
const THEIRS = 'they do not realise the purchase qualifies for EMI';

const answered = () => {
  // BUILT UP FROM `newBrief`, NOT FROM `discovered()`. The shared helper
  // records a `cost-perception` barrier of its own, and the whole point of
  // this run is the ONE-barrier case: the manager answered clearly, so there
  // is exactly one reason on the record and that is normal.
  let b = recordAnswer(newBrief(EMI), `bigger purchases convert more, ${THEIRS}, and it usually happens within 30 minutes`);
  b = recordBarriers(b, [
    { id: 'awareness-gap', statement: 'They do not realise the purchase qualifies.', basis: 'user-belief', lever: 'message', quote: THEIRS },
  ]);
  b = recordConverters(b, { shape: 'bigger purchases convert more often', basis: 'user', knowledge: 'known' });
  b = recordDimensions(b, [
    { name: 'Time since authorisation', rationale: 'They said it usually happens within half an hour.', status: 'retained', basis: 'user', note: 'Their own observation.' },
    { name: 'Purchase size', rationale: 'They said bigger ones convert more.', status: 'retained', basis: 'user', note: 'Their own observation.' },
    { name: 'Channel preference by segment', rationale: 'Different groups may respond on different channels.', status: 'unavailable', basis: 'none', note: 'No per-customer channel history for this tenant.' },
  ]);
  return recordSuccessCriteria(b, ['More eligible purchases converted.']);
};

describe('the manager own barrier survives a rival the agent adds', () => {
  it('is not deleted by a call that names only the rival', () => {
    // Step 2 of the chain, which is the one that destroyed evidence.
    let b = answered();
    expect(briefBarriers(b).map((x) => x.id)).toEqual(['awareness-gap']);
    b = recordBarriers(b, [
      { id: 'distraction-at-purchase', statement: 'They are mid-checkout and move on.', basis: 'assumption', lever: 'timing' },
    ]);
    expect(briefBarriers(b).map((x) => x.id)).toEqual(['awareness-gap', 'distraction-at-purchase']);
    expect(briefBarriers(b)[0].quote).toBe(THEIRS);
    expect(briefBarriers(b)[0].basis).toBe('user-belief');
  });

  it('reports what is on the record, not what changed', () => {
    // "0 barrier(s)" while a barrier existed. Re-sending a barrier already
    // recorded is the ordinary case, and the delta reads as "nothing saved".
    const out = applyOutputTool(answered(), 'record_findings', {
      barriers: [{ id: 'awareness-gap', statement: 'They do not realise the purchase qualifies.', basis: 'user-belief', lever: 'message', quote: THEIRS }],
    });
    expect(out.ok).toMatch(/1 barrier\(s\) on the record/);
    expect(out.ok).not.toMatch(/0 barrier\(s\)/);
  });
});

describe('one barrier is not a reason to refuse the plan', () => {
  const arch = (over: Record<string, unknown>) => ({
    name: 'A', barrier: 'awareness-gap', entry: 'On authorisation', timing: 'Within 30 minutes',
    lever: 'timing', journey: 'single-touch', mechanism: 'Tell them it qualifies.', tradeoff: 'Less reach.',
    chosen: false, ...over,
  });
  const plan = (architectures: unknown[]) => ({
    summary: 'Catch them while the purchase is still in mind.',
    approach: ['Enter on authorisation.'],
    touches: [
      { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Say it qualifies.', ifStillUnconverted: 'Remind on day 2.' },
      { day: 2, channel: 'SMS', path: 'all', purpose: 'Last chance.', ifStillUnconverted: 'Stop.' },
    ],
    assumptions: [], unknowns: [], architectures,
    // AND A PATH, since `propose_strategy` carries the journey it is asking
    // them to approve. Not the subject of this file, so it is the shared
    // reacting fixture.
    blueprint: reactingPath({}, 'awareness-gap'),
  });

  it('accepts two treatments of the one barrier the manager gave', () => {
    const out = applyOutputTool(answered(), 'propose_strategy', plan([
      arch({ name: 'Catch them at checkout', chosen: true }),
      arch({ name: 'Work the window', timing: 'Day 1, 3, 6', lever: 'message', journey: 'reminder' }),
    ]));
    expect(out.error).toBeUndefined();
    expect(out.strategy).toBeTruthy();
  });

  it('accepts two that differ only in WHO THEY REACH, sent as the schema spells it', () => {
    // The schema field is `audience`; everything downstream reads `entry`.
    // The treatment comparison ran BEFORE that reconciliation, so it read
    // undefined on both candidates and refused two plans whose whole
    // difference was the audience — the exact failure the alias comment had
    // already recorded for `architectureAudit`, one check earlier.
    const out = applyOutputTool(answered(), 'propose_strategy', plan([
      { name: 'Everyone eligible', barrier: 'awareness-gap', audience: 'Every authorised purchase', timing: 'Within 30 minutes', lever: 'timing', journey: 'single-touch', mechanism: 'Tell them.', tradeOff: 'Broad.', chosen: true },
      { name: 'Bigger purchases first', barrier: 'awareness-gap', audience: 'Purchases above their own median', timing: 'Within 30 minutes', lever: 'timing', journey: 'single-touch', mechanism: 'Tell them.', tradeOff: 'Narrow.' },
    ]));
    expect(out.error).toBeUndefined();
    // And the alias still lands, so nothing downstream reads `undefined`.
    expect(out.strategy?.architectures?.[0].entry).toBe('Every authorised purchase');
    expect(out.strategy?.architectures?.[0].tradeoff).toBe('Broad.');
  });

  it('still refuses when the second is the first, renamed', () => {
    const out = applyOutputTool(answered(), 'propose_strategy', plan([
      arch({ name: 'Catch them at checkout', chosen: true }),
      arch({ name: 'Prompt them promptly' }),
    ]));
    expect(out.error).toMatch(/one architecture described twice/);
  });

  it('never tells the agent to invent a second reason', () => {
    const out = applyOutputTool(answered(), 'propose_strategy', plan([arch({ chosen: true }), arch({})]));
    expect(out.error).not.toMatch(/Record a second candidate explanation/);
    expect(out.error).toMatch(/Do not invent a second reason/);
  });
});

// ---------------------------------------------------------------------------
// The reply itself
// ---------------------------------------------------------------------------

const sse = (events: Record<string, unknown>[]) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

/** A turn that calls propose_strategy with a payload the tool will refuse. */
const refusedPropose = () =>
  sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'p1', name: 'propose_strategy', input: {} } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        // FLAT, the way the schema defines it and the live turn sends it.
        // This fixture nested the plan under `strategy`, which is the only
        // reason the fallback could find a summary — the orchestrator was
        // reading the wrapper too. Both are fixed; the test now sends what
        // the model actually sends.
        partial_json: JSON.stringify({
          summary: 'Catch them while the purchase is still in mind.',
          approach: ['Enter on authorisation.'],
          touches: [
            { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Say it qualifies.', ifStillUnconverted: 'Remind on day 2.' },
            { day: 2, channel: 'SMS', path: 'all', purpose: 'Last chance.', ifStillUnconverted: 'Stop.' },
          ],
          assumptions: [], unknowns: [],
          // One architecture: refused for a reason that is NOT the
          // same-barrier rule, so the turn still ends without a proposal.
          architectures: [{ name: 'Only one', barrier: 'awareness-gap', audience: 'x', timing: 'y', mechanism: 'z', tradeOff: 'w', chosen: true }],
        }),
      },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 200 } },
  ]);

/**
 * What the agent did for the rest of the live turn: recorded findings, over
 * and over, trying to satisfy the refusal.
 *
 * Repeated by `script` until the round budget runs out, which is exactly how
 * the real turn ended — with tool calls every round, so the empty-round
 * recovery never applied, and no text at all when the loop finally stopped.
 */
/** A round that produces no usable answer, which is how the live turn ended. */
const blankTurn = () =>
  sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: ' ' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  ]);

const recordFindingsTurn = () =>
  sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'r1', name: 'record_findings', input: {} } },
    {
      type: 'content_block_delta',
      index: 0,
      delta: {
        type: 'input_json_delta',
        partial_json: JSON.stringify({
          barriers: [{ id: 'distraction-at-purchase', statement: 'They are mid-checkout and move on.', basis: 'assumption', lever: 'timing' }],
        }),
      },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 80 } },
  ]);

function script(bodies: string[]) {
  let i = 0;
  vi.stubGlobal('fetch', async () => {
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return new Response(new TextEncoder().encode(body), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });
}

const OLD = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.ANTHROPIC_API_KEY = OLD ?? 'test-key-not-real';
});

async function run(bodies: string[]) {
  script(bodies);
  const gen = orchestrateStream({
    sessionId: 'refused',
    tenantId: 'TEN-IBL',
    knowledge,
    discoveryRounds: 2,
    brief: answered(),
    messages: [
      { role: 'user', content: EMI },
      { role: 'user', content: `bigger purchases convert more, ${THEIRS}, usually within 30 minutes` },
    ],
    session: { state: 'DISCOVERING', strategyVersion: 0, confirmation: null },
  } as never);
  let out = await gen.next();
  while (!out.done) out = await gen.next();
  return out.value as unknown as Record<string, unknown>;
}

describe('a refused proposal never reads as "Recorded."', () => {
  it('says a plan exists and offers to send it again', async () => {
    // The live shape: propose refused, the agent records findings instead,
    // and the turn finally ends with nothing to say. `prose` is empty and
    // `recordedViaTools` is true, which is the branch that printed
    // "Recorded." — the one place a refused proposal could still be denied.
    const res = await run([refusedPropose(), recordFindingsTurn(), blankTurn()]);
    const reply = String(res.reply ?? '');
    expect(reply).not.toBe('Recorded.');
    expect(reply).toMatch(/I have a plan ready/);
    expect(reply).toMatch(/Catch them while the purchase is still in mind/);
    // And the manager's own barrier is still on the brief, despite the agent
    // having spent every remaining round sending only the invented rival.
    const ids = ((res.brief as { barriers?: { id: string }[] }).barriers ?? []).map((x) => x.id);
    expect(ids).toContain('awareness-gap');
  });

  it('tells the model to resend the same plan rather than start over', () => {
    // The corrective tool result. Without it the agent abandons the plan it
    // has already written and goes back to recording findings, which is what
    // the live turn spent its remaining rounds doing.
    const src = require('node:fs').readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/Send the SAME plan again with that one thing fixed/);
    expect(src).toMatch(/Two architectures may cite the SAME barrier/);
    expect(src).toMatch(/never a second invented reason/);
  });
});
