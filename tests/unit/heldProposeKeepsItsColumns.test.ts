// A refusal on one point is not a reason to start the rest again.
//
// MEASURED, `eval/runs/ui-s-1792770967470` turns 5 to 7. The agent proposed,
// was held, proposed again, was held again, and Confirm finally landed on turn
// 7 — after the manager had repeated the same two facts four times. The holds
// themselves were right. What made it a loop is that each attempt started from
// the model's MEMORY of the last one rather than from the last one: a payload
// with seven named paths and real per-case fallbacks was refused for something
// else, and the next one came back with two paths and a generic "still
// unconverted" on every row. A column that had passed was lost between
// attempts.
//
// The held branch still returns `strategy: null` and `pendingBlueprint: null`
// — nothing is approvable, and Confirm must not appear — so the brief is the
// only thing that survives a hold. It carries the last ACCEPTED proposal, and
// a later call fills a regression from it.
//
// NOTHING HERE IS INVENTED. Every value restored came out of a payload this
// tool accepted earlier in the same conversation.
import { describe, it, expect } from 'vitest';
import { applyOutputTool, fillFromLastProposal } from '../../server/outputTools';
import { namedOutcomes } from '../../server/gate';
import { journeyReacts } from '../../server/optionAudit';
import { newBrief, recordAnswer, recordBarriers, recordConverters, recordDimensions, recordSuccessCriteria } from '../../server/discovery';
import type { CampaignBlueprint } from '../../server/blueprint';
import { readFileSync } from 'node:fs';

const THEIRS = 'they dont know it is eligible for emi';

const settled = () => {
  let b = recordAnswer(newBrief('We want more EMI-eligible card purchases to become EMI.'), `txns above 10k get converted more, ${THEIRS}`);
  b = recordBarriers(b, [
    { id: 'awareness-gap', statement: 'They do not know the purchase is eligible.', basis: 'user-belief', lever: 'message', quote: THEIRS },
  ]);
  b = recordConverters(b, { shape: 'Transactions above ₹10,000 convert more often.', basis: 'user', knowledge: 'known' });
  // AND A RECORD THE GATE CALLS READY, since 2026-10-24. This file is about
  // a payload miss on a turn that MAY propose, and the tool now refuses a
  // missing path two different ways depending on whether discovery is
  // finished. Without the dimensions this fixture got the asking-turn
  // refusal, which is the other half of the live turn-3 split — so it was
  // never testing what its name says.
  b = recordDimensions(b, [
    { name: 'transaction ticket size', rationale: 'They said above ten thousand converts more.', status: 'retained', basis: 'user', note: 'Keep the ₹10,000 line.' },
    { name: 'merchant category', rationale: 'Asked about.', status: 'unavailable', basis: 'user', note: 'They do not track it.' },
    { name: 'prior EMI usage', rationale: 'Asked about.', status: 'unavailable', basis: 'user', note: 'They do not track it.' },
  ]);
  return recordSuccessCriteria(b, ['Number of transactions converting to EMI.']);
};

const send = (over: Record<string, unknown> = {}) => ({
  kind: 'send',
  label: 'Day 0 WhatsApp - eligibility',
  stage: 'first-touch',
  channelPreference: ['WHATSAPP'],
  copy: 'This purchase can be split into EMI.',
  barrier: 'awareness-gap',
  ...over,
});

/** Forks after the first WhatsApp on what it reported. */
const REACTING_PATH = {
  campaignName: 'Authorisation to EMI',
  description: 'Catch them while the purchase is fresh.',
  goal: null,
  entry: { kind: 'audience', entity: 'Card', conditions: [] },
  steps: [
    send({ fallbackChannel: 'SMS' }),
    {
      kind: 'branch',
      label: 'What happened to the first message',
      paths: [
        { label: 'Delivered, unread', statuses: ['DELIVERED'], steps: [{ kind: 'wait', durationHours: 24 }, send({ label: 'Day 1 SMS - same message, other channel', stage: 'reminder', channelPreference: ['SMS'] })] },
        { label: 'Read, no action', statuses: ['READ'], steps: [send({ label: 'Day 2 WhatsApp - how to convert', stage: 'outcome' })] },
      ],
    },
  ],
} as unknown as CampaignBlueprint;

/** The good column: two WHO paths, and the landed cases named per row. */
const GOOD_TOUCHES = [
  { day: 0, channel: 'WHATSAPP', path: 'Below ₹10,000', purpose: 'Say the purchase can be split.', ifStillUnconverted: 'If it is delivered but still unread, repeat the same fact on SMS the next day.' },
  { day: 0, channel: 'WHATSAPP', path: '₹10,000 and above', purpose: 'Say the purchase can be split.', ifStillUnconverted: 'If it was read but no action taken, argue the instalment instead.' },
  { day: 4, channel: 'SMS', path: 'Below ₹10,000', purpose: 'Last chance.', ifStillUnconverted: 'Stop; the window closes.' },
];

const plan = (over: Record<string, unknown> = {}) => ({
  summary: 'Catch them while the purchase is fresh, and react to what the first message did.',
  approach: ['Everyone eligible enters.'],
  assumptions: [],
  unknowns: [],
  architectures: [
    { name: 'Catch the moment', barrier: 'awareness-gap', audience: 'Every eligible transaction', timing: 'On posting', lever: 'message', journey: 'branch-on-response', chosen: true },
    { name: 'Work the statement date', barrier: 'awareness-gap', audience: 'The same transactions', timing: 'Before the statement', lever: 'timing', journey: 'linear' },
  ],
  touches: GOOD_TOUCHES,
  blueprint: REACTING_PATH,
  ...over,
});

/** The accepted proposal, and the brief that now carries it. */
const accepted = () => {
  const out = applyOutputTool(settled(), 'propose_strategy', plan());
  expect(out.error, out.error).toBeUndefined();
  return out;
};

describe('the record keeps the last proposal the tool accepted', () => {
  it('stashes the plan and its path, with the round', () => {
    const out = accepted();
    const stash = out.brief.lastProposal as { strategy: { touches: unknown[] }; blueprint: CampaignBlueprint; round: number };
    expect(stash).toBeTruthy();
    expect(stash.blueprint.steps).toHaveLength(2);
    expect(stash.strategy.touches).toHaveLength(3);
    expect(typeof stash.round).toBe('number');
  });

  it('stashes nothing when the plan was refused', () => {
    // A first propose with no journey is still refused, and a refusal must
    // not leave a half-plan on the record for a later call to inherit.
    const out = applyOutputTool(settled(), 'propose_strategy', plan({ blueprint: undefined }));
    expect(out.error).toMatch(/no journey in it/);
    expect(out.brief.lastProposal).toBeUndefined();
  });
});

describe('a later call fills what the last one had and this one lost', () => {
  it('restores the landed cases when the new rows all say the same thing', () => {
    // The live regression: every `ifStillUnconverted` collapsed to one
    // generic sentence, so `namedOutcomes` fell below two and the turn was
    // held for a reason the previous payload had already satisfied.
    const before = accepted().brief;
    const flattened = plan({
      touches: GOOD_TOUCHES.map((t) => ({ ...t, ifStillUnconverted: 'Still unconverted, so send the next reminder.' })),
    });
    expect(namedOutcomes(flattened.touches).size).toBeLessThan(2);

    const out = applyOutputTool(before, 'propose_strategy', flattened);
    expect(out.error).toBeUndefined();
    const rows = out.strategy!.touches!;
    expect(namedOutcomes(rows).size).toBeGreaterThanOrEqual(2);
    const text = rows.map((r) => r.ifStillUnconverted).join(' ');
    expect(text).toMatch(/delivered but still unread/);
    expect(text).toMatch(/read but no action taken/);
    // Two paths, as before — the repair does not add any.
    expect(new Set(rows.map((r) => r.path)).size).toBe(2);
    // And it says what it put back, rather than doing it silently.
    expect(out.ok).toMatch(/I restored/);
  });

  it('collapses engagement arms that were sent as extra audiences', () => {
    // Unread and read are what the JOURNEY forks on. Sent as path names they
    // double the audience count and leave every path one send deep, which is
    // what turned two real paths into seven.
    const before = accepted().brief;
    const exploded = plan({
      touches: [
        { ...GOOD_TOUCHES[0], path: 'Below ₹10,000 — unread arm' },
        { ...GOOD_TOUCHES[1], path: '₹10,000 and above — read arm' },
        { ...GOOD_TOUCHES[2], path: 'Below ₹10,000 — unread arm' },
      ],
    });
    const out = applyOutputTool(before, 'propose_strategy', exploded);
    expect(out.error).toBeUndefined();
    const paths = new Set(out.strategy!.touches!.map((r) => r.path));
    expect([...paths].sort()).toEqual(['Below ₹10,000', '₹10,000 and above'].sort());
  });

  it('restores the journey when this payload has no steps', () => {
    const before = accepted().brief;
    const out = applyOutputTool(before, 'propose_strategy', plan({ blueprint: { ...REACTING_PATH, steps: [] } }));
    expect(out.error).toBeUndefined();
    expect(out.blueprint!.steps).toHaveLength(2);
    expect(journeyReacts(out.blueprint!)).toBe(true);
    expect(out.ok).toMatch(/I restored the journey itself/);
  });

  it('does not merge a linear clock over a stashed outcome fork', () => {
    // The dangerous repair, refused. If this payload's journey does not react
    // and the stashed one did, the stash is left alone and the propose-time
    // check holds the turn — quietly swapping the journey would hand back an
    // approval for steps the model did not send this turn.
    const before = accepted().brief;
    const clock = {
      ...REACTING_PATH,
      steps: [send(), { kind: 'wait', durationHours: 48 }, send({ label: 'Day 2 reminder', stage: 'reminder' })],
    } as unknown as CampaignBlueprint;
    const out = applyOutputTool(before, 'propose_strategy', plan({ blueprint: clock }));
    expect(out.error).toBeUndefined();
    // The clock came through as sent, NOT replaced by the stashed fork.
    expect(journeyReacts(out.blueprint!)).toBe(false);
    expect(out.blueprint!.steps).toHaveLength(3);
  });

  it('refuses an illegal payload with nothing stashed, exactly as before', () => {
    const empty = settled();
    expect(applyOutputTool(empty, 'propose_strategy', plan({ blueprint: undefined })).error).toMatch(/no journey in it/);
    expect(applyOutputTool(empty, 'propose_strategy', { approach: [] }).error).toMatch(/needs a "summary"/);
    // And with a stash present, a payload that is illegal for a reason the
    // stash cannot fill is still refused.
    const before = accepted().brief;
    expect(applyOutputTool(before, 'propose_strategy', { ...plan(), summary: '' }).error).toMatch(/needs a "summary"/);
  });
});

describe('the live path names, which the first regex could not match', () => {
  // `ui-s-1792829868203` turn 5: "High ticket - delivered, not read" and
  // "Standard ticket - both arms". The first version anchored on `[^,]*?`,
  // so the comma defeated it, nothing collapsed, and the manager was left
  // clerking DELIVERED inside a path name.
  it('collapses a suffix that contains a comma', () => {
    const before = applyOutputTool(
      settled(),
      'propose_strategy',
      plan({
        touches: [
          { day: 0, channel: 'WHATSAPP', path: 'High ticket', purpose: 'Opening.', ifStillUnconverted: 'If it is delivered but still unread, repeat the fact.' },
          { day: 0, channel: 'WHATSAPP', path: 'Standard ticket', purpose: 'Opening.', ifStillUnconverted: 'If it was read but no action taken, change the argument.' },
        ],
      }),
    ).brief;

    const out = applyOutputTool(before, 'propose_strategy', plan({
      touches: [
        { day: 0, channel: 'WHATSAPP', path: 'High ticket - delivered, not read', purpose: 'Opening.', ifStillUnconverted: 'Still unconverted.' },
        { day: 0, channel: 'WHATSAPP', path: 'Standard ticket - both arms', purpose: 'Opening.', ifStillUnconverted: 'Still unconverted.' },
      ],
    }));
    expect(out.error).toBeUndefined();
    expect(new Set(out.strategy!.touches!.map((r) => r.path))).toEqual(new Set(['High ticket', 'Standard ticket']));
  });

  it('leaves a who-name that merely contains a hyphen alone', () => {
    const before = applyOutputTool(settled(), 'propose_strategy', plan({
      touches: [
        { day: 0, channel: 'WHATSAPP', path: 'Co-brand cards', purpose: 'Opening.', ifStillUnconverted: 'If it is delivered but still unread, repeat the fact.' },
        { day: 2, channel: 'SMS', path: 'Co-brand cards', purpose: 'Last chance.', ifStillUnconverted: 'If it was read but no action taken, change the argument.' },
      ],
    })).brief;
    const out = applyOutputTool(before, 'propose_strategy', plan({
      touches: [
        { day: 0, channel: 'WHATSAPP', path: 'Co-brand cards', purpose: 'Opening.', ifStillUnconverted: 'Still unconverted.' },
      ],
    }));
    expect(out.strategy!.touches!.map((r) => r.path)).toEqual(['Co-brand cards']);
  });
});

describe('six sentences are not six steps', () => {
  // `ui-s-1792829868203` turn 3: this tool accepted a "6-step path" whose
  // steps were prose captions, because the check asked only whether the array
  // was non-empty. The compiler would have hit `Unknown step kind
  // "undefined"` on every one of them.
  it('refuses captions, and says what the grammar is', () => {
    const out = applyOutputTool(settled(), 'propose_strategy', plan({
      blueprint: {
        ...REACTING_PATH,
        steps: [
          'Day 0: WhatsApp telling them the purchase is eligible.',
          'Day 2: SMS reminder if they have not acted.',
        ],
      },
    }));
    expect(out.error).toMatch(/sentences, not steps/);
    expect(out.error).toMatch(/object with a "kind"/);
    expect(out.brief.lastProposal).toBeUndefined();
  });

  it('refuses a mixed list, because one caption is still a caption', () => {
    const out = applyOutputTool(settled(), 'propose_strategy', plan({
      blueprint: { ...REACTING_PATH, steps: [...(REACTING_PATH.steps as unknown[]), 'and then a final SMS'] },
    }));
    expect(out.error).toMatch(/sentences, not steps/);
  });

  it('still accepts a real step list', () => {
    expect(applyOutputTool(settled(), 'propose_strategy', plan()).error).toBeUndefined();
  });
});

describe('the repair is a pure function, so it can be reasoned about', () => {
  it('returns the payload untouched when there is no stash', () => {
    const out = fillFromLastProposal(plan() as never, REACTING_PATH, undefined);
    expect(out.repaired).toEqual([]);
    expect(out.strategy.touches).toEqual(GOOD_TOUCHES);
  });

  it('leaves a payload that is already better than the stash alone', () => {
    const stash = { strategy: { touches: GOOD_TOUCHES.map((t) => ({ ...t, ifStillUnconverted: 'Still unconverted.' })) }, blueprint: REACTING_PATH };
    const out = fillFromLastProposal(plan() as never, REACTING_PATH, stash);
    expect(out.repaired).toEqual([]);
    expect(out.strategy.touches).toEqual(GOOD_TOUCHES);
  });
});

describe('a READY turn still gets the payload correction, not the record one', () => {
  // The other side of the live turn-3 split. `settled()` here passes the
  // record gate, so a missing path is a payload miss: the tool names the
  // field and the grammar, and the orchestrator's "fix that one thing and
  // resend" wrapper is the right thing to append.
  it('names the field and the grammar when the record is ready', () => {
    const out = applyOutputTool(settled(), 'propose_strategy', plan({ blueprint: undefined }));
    expect(out.error).toMatch(/no journey in it/);
    expect(out.error).toMatch(/"blueprint" filled in/);
    expect(out.error).toMatch(/grammar build_campaign uses/);
    // And NOT the asking-turn sentence, which would be wrong here.
    expect(out.error).not.toMatch(/Discovery is not finished/);
  });

  it('still refuses captions as sentences on a ready turn', () => {
    const out = applyOutputTool(settled(), 'propose_strategy', plan({
      blueprint: { ...REACTING_PATH, steps: ['Day 0: WhatsApp telling them it is eligible.'] },
    }));
    expect(out.error).toMatch(/sentences, not steps/);
    expect(out.error).not.toMatch(/Discovery is not finished/);
  });

  it('keeps the wrapper for a ready-turn miss', () => {
    // `refusedProposeIsNotRecorded` pins the wrapper's text; this pins that
    // the gate on it is the asking-turn error and nothing else, so a ready
    // payload miss still gets "do not start over".
    const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    expect(orch).toMatch(/Send the SAME plan again with that one thing fixed/);
    expect(orch).toMatch(/tu\.name === 'propose_strategy' && phase !== 'asking'/);
  });
});
