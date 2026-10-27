/**
 * TWO QUESTIONS, NOT ONE BIT. Is Discovery finished, and may they approve THIS
 * journey. `decide` answered both with one list, so every judgement about a
 * plan had the same power as "there is no journey".
 *
 * MEASURED, `eval/runs/ui-s-1793084077571` turn 4. A closed brief; a
 * ticket-size `branch` + `on` on Transaction Amount with sends on both arms
 * and a nested DELIVERED/READ fork on the lower one; WhatsApp with an SMS
 * fallback on every send. Plan recorded. Then:
 *
 *     lastBlocks  ['single-channel-habit']
 *     phase       revising          Confirm off
 *
 * The hold read `touches[].channel`, where the model had written one string
 * per row — "WhatsApp (SMS fallback on delivery failure)". One distinct
 * string, so one channel, so habit. The STEPS had already given SMS a job on
 * every message.
 *
 * The locked product: a clock plus a who-split is a complete first campaign,
 * and reaction is smarter rather than mandatory. So taste travels as advice
 * beside a live button, and only "there is nothing to approve" keeps it off.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { orchestrateStream } from '../../server/orchestrator';
import { seedKnowledgeBase } from '../../server/knowledge';
import { decide, turnPhase, channelJobBlocks, trendBlocks, cadenceBlocks } from '../../server/gate';
import { whoGroups, sendChannels, sendSteps, forkKind, coSentPairs } from '../../server/pathReading';
import { reactsToDelivery } from '../../server/optionAudit';
import { applyOutputTool } from '../../server/outputTools';
import type { WorkingBrief } from '../../server/discovery';

const read = (f: string) =>
  JSON.parse(readFileSync(new URL(`./support/liveBriefs/${f}`, import.meta.url), 'utf8'));

/** The closed brief and the filed plan, byte-for-byte off turn 4. */
const MIX: WorkingBrief = read('ui-s-1793084077571.turn-4.brief.json');
/** The ticket-size condition from the earlier run, which must still proceed. */
const COND = read('ui-s-1793077922155.turn-3.paths.json') as {
  filedCondition: unknown[];
  brief: WorkingBrief;
};

const mixBrief = () => structuredClone(MIX);
const mixPlan = () => structuredClone(MIX.lastProposal!) as { strategy: unknown; blueprint: { steps: unknown[] } };
const underReview = (brief: WorkingBrief, blueprint: unknown) =>
  ({ strategy: structuredClone(brief.lastProposal!.strategy), blueprint }) as never;

const codes = (d: { blocks: { code: string }[] }) => d.blocks.map((b) => b.code);

// --- one propose turn through the real orchestrator -------------------------
const knowledge = seedKnowledgeBase();
const sse = (events: Record<string, unknown>[]) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
const OLD = process.env.ANTHROPIC_API_KEY;
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.ANTHROPIC_API_KEY = OLD ?? 'test-key-not-real';
});

/**
 * The live propose payload, replayed. `revising` versus
 * `awaiting-confirmation` is the whole user-visible outcome of this slice, and
 * `proceed: true` alone does not prove which return the orchestrator takes.
 */
async function proposeTurn(brief: WorkingBrief, strategy: unknown, blueprint: unknown) {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  const body = sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: JSON.stringify({ action: 'propose', strategy, blueprint, openItems: [] }) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 300 } },
  ]);
  vi.stubGlobal('fetch', async () =>
    new Response(new TextEncoder().encode(body), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  );
  const gen = orchestrateStream({
    sessionId: 'two-decisions',
    tenantId: 'TEN-IBL',
    knowledge,
    discoveryRounds: 3,
    brief,
    messages: [{ role: 'user', content: brief.objective }],
    session: { state: 'DISCOVERING', strategyVersion: 0, confirmation: null },
  } as never);
  let out = await gen.next();
  while (!out.done) out = await gen.next();
  return out.value as { phase?: string; strategy?: unknown; graph?: unknown; reply?: string };
}

describe('the live channel-mix plan reaches Confirm', () => {
  it('the record is closed and the path is approvable, so it proceeds', () => {
    const brief = mixBrief();
    const plan = mixPlan();
    // THE RECORD ANSWER, with no proposal in it — `turnPhase` already asks it
    // this way and must keep doing so, or plan taste decides whether the plan
    // tool is even offered next turn.
    expect(codes(decide(brief)), 'Discovery was finished').toEqual([]);
    expect(turnPhase(brief, { isBuildTurn: false, limitReached: false })).toBe('ready');

    const d = decide(brief, { proposed: underReview(brief, plan.blueprint) });
    expect(codes(d), 'held on single-channel-habit live').toEqual([]);
    expect(d.proceed).toBe(true);
  });

  it('its who-groups are the two ticket bands, not the engagement arms', () => {
    const groups = whoGroups(mixPlan().blueprint.steps);
    expect(groups.map((g) => g.label)).toEqual([
      'Above ₹10,000 - light touch',
      '₹10,000 and below - fuller push',
    ]);
    expect(groups.every((g) => g.sends > 0), 'and both bands get messages').toBe(true);
    // The nested DELIVERED/READ fork is an interior of the lower band.
    const low = (mixPlan().blueprint.steps[0] as { paths: { steps: unknown[] }[] }).paths[1];
    const nested = low.steps.find((s) => (s as { kind?: string }).kind === 'branch');
    expect(forkKind(nested)).toBe('outcome');
  });

  it('habit is ABSENT, because the steps gave SMS a job', () => {
    const plan = mixPlan();
    expect([...sendChannels(plan.blueprint.steps)].sort()).toEqual(['sms', 'whatsapp']);
    expect(channelJobBlocks(underReview(mixBrief(), plan.blueprint))).toEqual([]);
  });

  it('and Confirm does not open with the same-channel sentence', () => {
    // THE NEST LIE BESIDE THE BUTTON. Demoting habit to advice is not enough
    // on its own: an advice line that accuses them of something the steps
    // disprove is worse next to a live Confirm than it was next to a refusal.
    const d = decide(mixBrief(), { proposed: underReview(mixBrief(), mixPlan().blueprint) });
    expect(d.advice.join(' ')).not.toMatch(/same channel/i);
    expect(d.advice.join(' ')).not.toMatch(/habit rather than a decision/i);
  });

  it('it does NOT react, and that is advice rather than a hold', () => {
    // MEASURED, and it corrects the slice brief. Both engagement arms are
    // `wait, send` — they differ in copy, not in job — so `jobSignature` calls
    // them one job and `reactsToDelivery` is false. That rule is deliberate
    // (2026-10-23: "an outcome fork whose arms run the same journey is still a
    // label on a clock") and is not touched here.
    //
    // The point of the slice survives the correction intact: it proceeds
    // anyway, and the read-fork sentence travels as advice.
    expect(reactsToDelivery(mixPlan().blueprint as never)).toBe(false);
    const d = decide(mixBrief(), { proposed: underReview(mixBrief(), mixPlan().blueprint) });
    expect(d.proceed).toBe(true);
    expect(d.advice.join(' ')).toMatch(/read-fork|different jobs/i);
  });

  it('still proceeds when every touch row says WhatsApp and only the steps carry SMS', () => {
    // The door this slice is built on: the fallback lives on the send, and the
    // touch list need not repeat it.
    const brief = mixBrief();
    const plan = mixPlan();
    const strategy = structuredClone(brief.lastProposal!.strategy) as {
      touches?: { channel?: string; ifStillUnconverted?: string }[];
    };
    (strategy.touches ?? []).forEach((t) => {
      t.channel = 'WhatsApp';
      t.ifStillUnconverted = 'No further message on this path.';
    });
    const proposed = { strategy, blueprint: plan.blueprint } as never;
    expect(channelJobBlocks(proposed), 'the steps still name two channels').toEqual([]);
    const d = decide(brief, { proposed });
    expect(d.proceed).toBe(true);
    expect(d.advice.join(' ')).not.toMatch(/same channel/i);
  });
});

describe('a truly one-channel path', () => {
  const oneChannel = () => {
    const plan = mixPlan();
    const strip = (steps: unknown[]): void => {
      for (const s of steps) {
        const step = s as Record<string, unknown>;
        if (step.kind === 'send') {
          step.channelPreference = ['WHATSAPP'];
          delete step.fallbackChannel;
        }
        for (const key of ['steps', 'yes', 'no'] as const) if (Array.isArray(step[key])) strip(step[key] as unknown[]);
        for (const key of ['paths', 'arms'] as const)
          for (const p of (step[key] as { steps?: unknown[] }[]) ?? []) strip(p?.steps ?? []);
      }
    };
    strip(plan.blueprint.steps);
    return plan.blueprint;
  };

  it('a single preference WITH a fallback is still two jobs, not habit', () => {
    // UNPINNED UNTIL MEASURED. Dropping `fallbackChannel` from `sendChannels`
    // left the whole suite green, because the live sends also list
    // `channelPreference: ['WHATSAPP','SMS']` — so the fallback leg was
    // carried by the preference list and proved nothing. This is the case
    // that needs it: one preference, and SMS only as the fallback.
    const path = oneChannel();
    const addFallback = (steps: unknown[]): void => {
      for (const s of steps) {
        const step = s as Record<string, unknown>;
        if (step.kind === 'send') step.fallbackChannel = 'SMS';
        for (const key of ['steps', 'yes', 'no'] as const) if (Array.isArray(step[key])) addFallback(step[key] as unknown[]);
        for (const key of ['paths', 'arms'] as const)
          for (const p of (step[key] as { steps?: unknown[] }[]) ?? []) addFallback(p?.steps ?? []);
      }
    };
    addFallback(path.steps);
    expect([...sendChannels(path.steps)].sort()).toEqual(['sms', 'whatsapp']);
    expect(channelJobBlocks(underReview(mixBrief(), path))).toEqual([]);
  });

  it('says it, as advice only, and never keeps the button off', () => {
    const path = oneChannel();
    expect([...sendChannels(path.steps)]).toEqual(['whatsapp']);
    const proposed = underReview(mixBrief(), path);
    expect(channelJobBlocks(proposed).map((b) => b.code), 'the sentence is still earned').toEqual([
      'single-channel-habit',
    ]);
    const d = decide(mixBrief(), { proposed });
    expect(codes(d), 'but it is not a hold').toEqual([]);
    expect(d.proceed).toBe(true);
    expect(d.advice.join(' ')).toMatch(/same channel/i);
  });
});

describe('the earlier run still proceeds, and the trend rule still holds', () => {
  it('the filed ticket-size condition is not nothing-tested', () => {
    const brief = structuredClone(COND.brief);
    const proposed = underReview(brief, { steps: COND.filedCondition });
    expect(trendBlocks(brief, proposed).map((b) => b.code)).toEqual([]);
    const d = decide(brief, { proposed });
    expect(codes(d), 'held nothing-tested live').toEqual([]);
    expect(d.proceed).toBe(true);
  });

  it('a who-cut with NO stated trend still holds, and does not proceed', () => {
    // THE SIBLING THAT STAYS A BLOCK. `nothing-tested` and
    // `split-without-trend` are two outcomes of one function; demoting both
    // would let a cut on a factor nobody has seen reach Confirm.
    const brief = structuredClone(COND.brief);
    (brief.dimensions ?? []).forEach((d) => {
      if (d.status === 'retained') d.status = 'deferred';
    });
    const proposed = underReview(brief, { steps: COND.filedCondition });
    expect(trendBlocks(brief, proposed).map((b) => b.code)).toEqual(['split-without-trend']);
    const d = decide(brief, { proposed });
    expect(codes(d)).toContain('split-without-trend');
    expect(d.proceed).toBe(false);
  });
});

describe('what is still nothing to approve', () => {
  const send = (name: string, stage = 'first-touch') => ({
    kind: 'send',
    name,
    objective: ['emi'],
    stage,
    describe: 'd',
    copy: 'Split this purchase.',
    channelPreference: ['WHATSAPP'],
    barrier: (MIX.barriers ?? [])[0]?.id ?? 'awareness',
  });

  it('an empty who-arm still holds', () => {
    const path = {
      steps: [
        {
          kind: 'branch',
          label: 'Split',
          on: { entity: 'Transaction', attribute: 'Transaction Amount', operator: 'Equals', value: '10000' },
          paths: [
            { label: 'High', steps: [send('h1'), send('h2', 'reminder')] },
            { label: 'Low', steps: [] },
          ],
        },
      ],
    };
    expect(cadenceBlocks(underReview(mixBrief(), path)).map((b) => b.code)).toEqual(['cadence-unnamed']);
    expect(decide(mixBrief(), { proposed: underReview(mixBrief(), path) }).proceed).toBe(false);
  });

  it('a path with no send anywhere in it still holds', () => {
    // The hold `nothing-tested` used to supply before it became advice. A
    // journey of waits and exits reaches nobody, and Confirm compiles exactly
    // this path.
    const path = { steps: [{ kind: 'wait', durationHours: 48 }, { kind: 'exit', reason: 'Window closed.' }] };
    expect(sendSteps(path.steps)).toBe(0);
    expect(cadenceBlocks(underReview(mixBrief(), path)).map((b) => b.code)).toEqual(['cadence-unnamed']);
    expect(decide(mixBrief(), { proposed: underReview(mixBrief(), path) }).proceed).toBe(false);
  });

  it('read/unread alone is still not a who-split', () => {
    const path = {
      steps: [
        send('open'),
        {
          kind: 'branch',
          paths: [
            { label: 'Unread', statuses: ['DELIVERED'], steps: [{ kind: 'wait', durationHours: 24 }, send('again', 'reminder')] },
            { label: 'Read', statuses: ['READ'], steps: [send('argue', 'reminder')] },
          ],
        },
      ],
    };
    expect(whoGroups(path.steps)).toEqual([]);
    expect(decide(mixBrief(), { proposed: underReview(mixBrief(), path) }).proceed).toBe(true);
  });

  it('waits-only still refuses at the tool and does not write lastProposal', () => {
    const brief = mixBrief();
    brief.lastProposal = undefined;
    const out = applyOutputTool(brief, 'propose_strategy', {
      ...(structuredClone(MIX.lastProposal!.strategy) as object),
      blueprint: {
        campaignName: 'EMI',
        description: 'Prompt conversion inside the window.',
        goal: null,
        entry: { kind: 'audience', entity: 'Customer', conditions: [] },
        steps: [{ kind: 'wait', durationHours: 48 }, { kind: 'exit', reason: 'Window closed.' }],
      },
    } as never);
    expect(out.error).toMatch(/compiles to no messages/i);
    expect(out.brief.lastProposal ?? null).toBeNull();
  });

  it('a trailing sibling after the fork still refuses', () => {
    const brief = mixBrief();
    brief.lastProposal = undefined;
    const out = applyOutputTool(brief, 'propose_strategy', {
      ...(structuredClone(MIX.lastProposal!.strategy) as object),
      blueprint: {
        campaignName: 'EMI',
        description: 'Prompt conversion inside the window.',
        goal: null,
        entry: { kind: 'audience', entity: 'Customer', conditions: [] },
        steps: [
          {
            kind: 'branch',
            label: 'Split',
            on: { entity: 'Transaction', attribute: 'Transaction Amount', operator: 'Equals', value: '10000' },
            paths: [
              { label: 'High', steps: [send('h1')] },
              { label: 'Low', steps: [send('l1')] },
            ],
          },
          send('shared last chance', 'reminder'),
        ],
      },
    } as never);
    expect(out.error).toMatch(/has 3 messages in it and only 2 reached the journey/i);
    expect(out.brief.lastProposal ?? null).toBeNull();
  });
});

describe('the turn the manager actually saw', () => {
  it('returns awaiting-confirmation, not revising', async () => {
    // MEASURED: this exact payload returned `phase: 'revising'` with
    // `lastBlocks: ['single-channel-habit']` and no Confirm. `proceed: true`
    // on its own does not prove which return the orchestrator takes, so this
    // drives the real one.
    const brief = mixBrief();
    const plan = mixPlan();
    brief.lastProposal = undefined;
    const res = await proposeTurn(brief, plan.strategy, plan.blueprint);
    expect(res.phase).toBe('awaiting-confirmation');
    expect(res.strategy, 'there is a plan to approve').toBeTruthy();
    // STILL NOT BUILT. The canvas is a compiled campaign, and only Confirm
    // compiles it.
    expect(res.graph ?? null).toBeNull();
    // And the accusation the steps disprove is not beside the button.
    expect(String(res.reply ?? '')).not.toMatch(/same channel/i);
  });
});

describe('spray is read off the steps too, so it cannot accuse from the table', () => {
  /**
   * NOT A LIVE PAYLOAD, and said so. `ui-s-1793084077571` writes one touch row
   * per path and triggers none of this. The defect is the one `habit` had:
   * `channel-spray` keyed on `touches[].path` + `day`, with an escape that
   * looked for two landed cases in the `ifStillUnconverted` PROSE. Two
   * exclusive arms written under ONE path name are two rows, one path, one day
   * — so it fires, and only a well-filled sentence clears it. It cannot hide
   * Confirm any more, but an advice line the steps disprove is still a lie
   * beside a live button.
   */
  const send = (name: string, channels: string[], delayDays?: number) => ({
    kind: 'send',
    name,
    label: name,
    objective: ['emi'],
    stage: 'reminder',
    describe: 'd',
    copy: 'c',
    channelPreference: channels,
    ...(delayDays === undefined ? {} : { delayDays }),
    barrier: (MIX.barriers ?? [])[0]?.id ?? 'awareness',
  });
  const row = (path: string, day: number, channel: string) => ({
    day,
    channel,
    path,
    purpose: 'p',
    ifStillUnconverted: 'No further message on this path.',
  });
  const withTouches = (touches: unknown[]) => {
    const strategy = structuredClone(MIX.lastProposal!.strategy) as Record<string, unknown>;
    strategy.touches = touches;
    return strategy;
  };
  const sprayCodes = (touches: unknown[], steps?: unknown[]) =>
    channelJobBlocks({ strategy: withTouches(touches), ...(steps ? { blueprint: { steps } } : {}) } as never).map(
      (b) => b.code,
    );

  it('two exclusive arms under one path name are coverage, not fatigue', () => {
    const steps = [
      send('open', ['WHATSAPP'], 0),
      {
        kind: 'branch',
        paths: [
          { label: 'Unread', statuses: ['DELIVERED'], steps: [send('retry on sms', ['SMS'], 2)] },
          { label: 'Read', statuses: ['READ'], steps: [send('argue on whatsapp', ['WHATSAPP'], 2)] },
        ],
      },
    ];
    const touches = [row('Standard ticket', 2, 'SMS'), row('Standard ticket', 2, 'WhatsApp')];
    expect(coSentPairs(steps), 'nobody receives both').toHaveLength(0);
    expect(sprayCodes(touches, steps)).toEqual([]);
    // AND THE TABLE ALONE WOULD HAVE ACCUSED THEM, which is the defect.
    expect(sprayCodes(touches)).toContain('channel-spray');
  });

  it('two sends at the same moment on one path are still fatigue', () => {
    const steps = [send('whatsapp now', ['WHATSAPP'], 0), send('sms now', ['SMS'], 0)];
    expect(coSentPairs(steps)).toHaveLength(1);
    expect(sprayCodes([row('all', 0, 'WhatsApp'), row('all', 0, 'SMS')], steps)).toEqual(['channel-spray']);
  });

  it('a wait between them is not fatigue', () => {
    const steps = [send('whatsapp', ['WHATSAPP']), { kind: 'wait', durationHours: 48 }, send('sms later', ['SMS'])];
    expect(coSentPairs(steps)).toHaveLength(0);
    expect(sprayCodes([row('all', 0, 'WhatsApp'), row('all', 2, 'SMS')], steps)).toEqual([]);
  });

  it('the declared day beats adjacency, which is how the arms case was wrong first', () => {
    // A day-0 send followed by a fork whose arms send on day 2 read as
    // "adjacent, nothing between them passes time" in the first version of
    // `coSentPairs`, so it reported the arms. Their own `delayDays` said two
    // days apart. What the plan SAYS wins; adjacency is the fallback for the
    // plan that did not say.
    const declared = [send('day 0', ['WHATSAPP'], 0), send('day 2', ['SMS'], 2)];
    expect(coSentPairs(declared)).toHaveLength(0);
    const silent = [send('first', ['WHATSAPP']), send('second', ['SMS'])];
    expect(coSentPairs(silent), 'no days declared, so adjacency answers').toHaveLength(1);
  });

  it('and it is advice either way, never a hold', () => {
    const steps = [send('whatsapp now', ['WHATSAPP'], 0), send('sms now', ['SMS'], 0)];
    const proposed = { strategy: withTouches([row('all', 0, 'WhatsApp'), row('all', 0, 'SMS')]), blueprint: { steps } } as never;
    const d = decide(mixBrief(), { proposed });
    expect(codes(d)).not.toContain('channel-spray');
    expect(d.advice.join(' ')).toMatch(/two messages at the same point/i);
  });

  it('the live plan triggers none of it', () => {
    const plan = mixPlan();
    expect(coSentPairs(plan.blueprint.steps)).toHaveLength(0);
    expect(channelJobBlocks(underReview(mixBrief(), plan.blueprint))).toEqual([]);
  });
});
