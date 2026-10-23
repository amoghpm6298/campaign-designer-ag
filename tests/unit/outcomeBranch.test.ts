// Branching on what the last message reported — a capability, never an inject.
//
// MEASURED, `eval/runs/ui-s-1792748248345` turn 5. The Confirm built a
// Transaction Amount branch, waits of 24/48/72 hours, SMS as a field on the
// send, seventeen Goal Checks, and not one split on the previous step's
// outcome. The canvas was a clock, and the blueprint had no words for the
// thing that would have fixed it: the builder's Decision Split can route on
// "Previous step outcome" and the agent could only ask for an attribute.
//
// TWO FAILURES ARE AVOIDED HERE AND THE SECOND IS THE EASY ONE TO WALK INTO:
//
//  1. Undelivered as a graph arm. FAILED / UNKNOWN / NOT_DELIVERED and the
//     SMS FAILED_* codes are `fallbackChannel` on that Send — the same
//     message attempted elsewhere — and an arm for someone who received
//     nothing has nothing different to say.
//  2. A split after every message. That is a clock with extra nodes, and a
//     nested three-way fork on a four-touch path is unreadable. So the
//     compiler builds an outcome split WHEN THE BLUEPRINT ASKS and never
//     inserts one, and `journeyReacts` asks whether a journey has ONE
//     designed check whose arms do different jobs — not whether every send
//     has one.
//
// The statuses themselves are imported from the application's own
// `DELIVERY_STATUS_BY_CHANNEL`, never retyped here.
import { describe, it, expect } from 'vitest';
import { buildFromBlueprint, type CampaignBlueprint } from '../../server/blueprint';
import { auditOptions, copyOnlyExperiments, journeyReacts, reactsToDelivery } from '../../server/optionAudit';
import { decide } from '../../server/gate';
import { newBrief, recordAnswer, recordBarriers, recordConverters, recordDimensions, recordSuccessCriteria } from '../../server/discovery';
import { readFileSync } from 'node:fs';
import { derive } from '../../server/architectureAudit';
import { DELIVERY_STATUS_BY_CHANNEL } from '../../src/data/sharedConstants';
import { engagementStatusesFor } from '../../server/deliveryStatuses';

const OPTS = { availableChannels: ['WHATSAPP', 'SMS', 'EMAIL', 'RCS'] as never, templateLibraryAccess: 'unavailable' as const };

const send = (over: Record<string, unknown> = {}) => ({
  kind: 'send',
  name: 'Eligibility notice',
  objective: ['emi', 'convert'],
  stage: 'first-touch',
  describe: 'Say the purchase qualifies and what the instalment costs.',
  copy: 'Split this purchase from ₹2,100 a month.',
  channelPreference: ['WHATSAPP'],
  barrier: 'awareness-gap',
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

const build = (steps: unknown[]) => buildFromBlueprint(bp(steps), OPTS);

/** Decision Splits that route on the previous step's outcome, in the built graph. */
const outcomeSplits = (g: { nodes: Record<string, { type: string; _config?: Record<string, unknown> }> }) =>
  Object.values(g.nodes).filter((n) => n.type === 'DECISION_SPLIT' && n._config?.source === 'Previous step outcome');

const attributeSplits = (g: { nodes: Record<string, { type: string; _config?: Record<string, unknown> }> }) =>
  Object.values(g.nodes).filter((n) => n.type === 'DECISION_SPLIT' && n._config?.source !== 'Previous step outcome');

// ---------------------------------------------------------------------------
// The gold path: ONE designed check, and the rest of the journey linear
// ---------------------------------------------------------------------------

/**
 * The shape the live run should have produced.
 *
 * A first touch whose job is awareness, with SMS as its fallback FIELD, then
 * one outcome branch where the three people WhatsApp can tell apart get three
 * different jobs — the same fact sooner, a different argument, and left alone
 * — and nothing but linear reminders after it.
 */
const GOLD = [
  send({ fallbackChannel: 'SMS' }),
  {
    kind: 'branch',
    label: 'What happened to the first message',
    paths: [
      {
        label: 'Delivered, still unread',
        statuses: ['DELIVERED'],
        steps: [
          { kind: 'wait', durationHours: 24, why: 'Short: it is sitting unopened.' },
          send({ name: 'Same fact, sooner', stage: 'reminder', describe: 'Repeat that the purchase qualifies.' }),
          { kind: 'exit', reason: 'The window closed.' },
        ],
      },
      {
        label: 'Read, not booked',
        statuses: ['READ'],
        steps: [
          send({ name: 'What it costs a month', stage: 'reminder', describe: 'Argue the instalment, not the eligibility.' }),
          { kind: 'wait', durationHours: 72, why: 'They know; give them room.' },
          send({ name: 'Last chance before it lapses', stage: 'outcome', describe: 'Say the window is closing.' }),
          { kind: 'exit', reason: 'The window closed.' },
        ],
      },
      {
        label: 'Dismissed the thread',
        statuses: ['DELETED'],
        steps: [
          { kind: 'wait', durationHours: 120, why: 'They dismissed it. Leave them alone until the end.' },
          send({ name: 'One last chance', stage: 'outcome', describe: 'A single late notice that the window is closing.' }),
          { kind: 'exit', reason: 'The window closed.' },
        ],
      },
    ],
  },
];

describe('the gold path compiles as the builder draws it', () => {
  const out = build(GOLD);

  it('builds exactly ONE Previous-step-outcome split', () => {
    expect(outcomeSplits(out.graph)).toHaveLength(1);
    // And no attribute split appeared from nowhere.
    expect(attributeSplits(out.graph)).toHaveLength(0);
  });

  it('carries the three arms as the form stores them, in values[]', () => {
    const cfg = outcomeSplits(out.graph)[0]._config as { branches: { label: string; value: string; values: string[] }[] };
    expect(cfg.branches.map((b) => b.values)).toEqual([['DELIVERED'], ['READ'], ['DELETED']]);
    // `value` stays empty: the multi-select lives in `values`, which is what
    // `dcSelectedMulti` reads.
    for (const b of cfg.branches) expect(b.value).toBe('');
  });

  it('never creates an arm for undelivered', () => {
    const cfg = outcomeSplits(out.graph)[0]._config as { branches: { values: string[] }[] };
    const every = cfg.branches.flatMap((b) => b.values);
    for (const s of ['FAILED', 'UNKNOWN', 'NOT_DELIVERED']) expect(every).not.toContain(s);
  });

  it('leaves the fallback where it belongs — a field on the Send', () => {
    const sends = Object.values(out.graph.nodes).filter((n) => n.type === 'SEND');
    expect((sends[0]._config as { fallbackChannel: string }).fallbackChannel).toBe('SMS');
  });

  it('builds the steps inside every arm', () => {
    // If `addSteps` did not descend, the arms would be empty and the journey
    // would be one send and a split.
    const sends = Object.values(out.graph.nodes).filter((n) => n.type === 'SEND');
    expect(sends.length).toBeGreaterThanOrEqual(5);
    expect(out.issues).toEqual([]);
  });

  it('reads as a reaction, and as branch-on-response', () => {
    expect(journeyReacts(bp(GOLD))).toBe(true);
    expect(derive(bp(GOLD)).has('branch-on-response')).toBe(true);
    // The arms carry sends and waits, which `derive` could not see at all
    // until it walked branch paths.
    expect(derive(bp(GOLD)).has('linear')).toBe(true);
  });
});

describe('nothing is inserted that the blueprint did not ask for', () => {
  it('compiles zero outcome splits for a send, a wait and a send', () => {
    // THE SECOND MISTAKE, pinned. A mechanical split after every message is a
    // clock with extra nodes, so the compiler is a capability and not a
    // policy: this journey is a clock, it compiles as a clock, and the
    // application says so elsewhere rather than rewriting it here.
    const out = build([
      send(),
      { kind: 'wait', durationHours: 48, why: 'Give them time.' },
      send({ name: 'Reminder', stage: 'reminder' }),
      { kind: 'exit', reason: 'Done.' },
    ]);
    expect(outcomeSplits(out.graph)).toHaveLength(0);
    expect(out.issues).toEqual([]);
  });

  it('sees the steps inside a branch arm at all', () => {
    // `walk` did not descend into `branch.paths`, so everything in this file
    // was invisible to every check in `optionAudit` — including the audits
    // that read `all(bp)` rather than the fork itself. A wait-for-event
    // nested in an arm is the cheapest proof: without the descent the
    // adaptive-sequencing claim is downgraded on a journey that holds for an
    // event.
    const nested = bp([
      send(),
      {
        kind: 'branch',
        label: 'Engagement',
        paths: [
          {
            label: 'Read',
            statuses: ['READ'],
            steps: [{ kind: 'waitForEvent', eventCategory: 'EMI Events', eventType: 'EMI_STATUS_CHANGED', timeoutDays: 7 }],
          },
          { label: 'Unread', statuses: ['DELIVERED'], steps: [send({ name: 'Sooner', stage: 'reminder' })] },
        ],
      },
    ]);
    const audits = auditOptions([{ option: 'Adaptive sequencing', verdict: 'used', why: 'It waits for the booking.' }], nested);
    expect(audits[0].verified).toBe('used');
    expect(audits[0].gap).toBeUndefined();
  });

  it('does not require a check on every send to count as reacting', () => {
    // One designed check, three linear reminders after it. The live failure
    // was no check at all, not too few.
    expect(journeyReacts(bp(GOLD))).toBe(true);
  });
});

describe('what cannot be an arm', () => {
  it('reports CLICKED on a WhatsApp send rather than coercing it', () => {
    const out = build([
      send(),
      {
        kind: 'branch',
        label: 'Did they click',
        paths: [
          { label: 'Clicked', statuses: ['CLICKED'], steps: [send({ name: 'Closer', stage: 'reminder' })] },
          { label: 'Read only', statuses: ['READ'], steps: [send({ name: 'Nudge', stage: 'reminder' })] },
        ],
      },
    ]);
    const said = out.issues.map((i) => i.problem).join(' ');
    expect(said).toMatch(/WHATSAPP does not report CLICKED/);
    // Not substituted for the nearest thing it does report.
    expect(said).not.toMatch(/READ instead|using READ/);
    expect(DELIVERY_STATUS_BY_CHANNEL.WHATSAPP).not.toContain('CLICKED');
  });

  it('drops a FAILED-only arm with a limitation, and keeps building', () => {
    const out = build([
      send({ fallbackChannel: 'SMS' }),
      {
        kind: 'branch',
        label: 'Did it land',
        paths: [
          { label: 'Landed, unread', statuses: ['DELIVERED'], steps: [send({ name: 'Sooner', stage: 'reminder' })] },
          { label: 'Read', statuses: ['READ'], steps: [send({ name: 'Different argument', stage: 'reminder' })] },
          { label: 'Failed', statuses: ['FAILED', 'UNKNOWN'], steps: [send({ name: 'Try SMS', stage: 'first-touch', channelPreference: ['SMS'] })] },
        ],
      },
    ]);
    const cfg = outcomeSplits(out.graph)[0]._config as { branches: { label: string; values: string[] }[] };
    expect(cfg.branches.map((b) => b.label)).toEqual(['Landed, unread', 'Read']);
    expect(out.limitations.map((l) => l.note).join(' ')).toMatch(/fallback channel on the Send itself/);
    // The journey still exists, and still reacts on the two real arms.
    expect(outcomeSplits(out.graph)).toHaveLength(1);
  });

  it('refuses an in-flight arm, because that is not a person', () => {
    const out = build([
      send(),
      {
        kind: 'branch',
        label: 'Sent yet',
        paths: [
          { label: 'Queued', statuses: ['QUEUED'], steps: [send({ name: 'Wait for it', stage: 'reminder' })] },
          { label: 'Read', statuses: ['READ'], steps: [send({ name: 'Different argument', stage: 'reminder' })] },
        ],
      },
    ]);
    expect(out.issues.map((i) => i.problem).join(' ')).toMatch(/QUEUED means the message is still on its way/);
    const cfg = outcomeSplits(out.graph)[0]._config as { branches: { label: string }[] };
    expect(cfg.branches.map((b) => b.label)).toEqual(['Read']);
    // And QUEUED is not an engagement status anywhere.
    for (const c of ['WHATSAPP', 'SMS', 'EMAIL', 'RCS'] as const) expect(engagementStatusesFor(c)).not.toContain('QUEUED');
  });

  it('refuses two arms claiming the same status', () => {
    // One status, one arm. Two arms claiming READ route the same person two
    // ways and the reducer would pick whichever edge it matched first.
    const out = build([
      send(),
      {
        kind: 'branch',
        label: 'Overlapping',
        paths: [
          { label: 'Read', statuses: ['READ', 'DELIVERED'], steps: [send({ name: 'A', stage: 'reminder' })] },
          { label: 'Also read', statuses: ['READ'], steps: [send({ name: 'B', stage: 'reminder' })] },
        ],
      },
    ]);
    expect(out.issues.map((i) => i.problem).join(' ')).toMatch(/already routed by an earlier arm/);
    const cfg = outcomeSplits(out.graph)[0]._config as { branches: { values: string[] }[] };
    expect(cfg.branches).toHaveLength(1);
    expect(cfg.branches[0].values).toEqual(['READ', 'DELIVERED']);
  });

  it('needs a preceding Send', () => {
    const out = build([
      { kind: 'branch', label: 'On nothing', paths: [{ label: 'Read', statuses: ['READ'], steps: [send()] }] },
    ]);
    expect(out.issues.map((i) => i.problem).join(' ')).toMatch(/needs a preceding Send/);
    expect(outcomeSplits(out.graph)).toHaveLength(0);
  });

  it('reads the fallback channel\'s vocabulary too, because the send could have landed there', () => {
    // A WhatsApp send with an EMAIL fallback could have been delivered by
    // either, so OPENED is legitimately available — `deliveryStatusOptionsForSend`
    // has always said so and this is the first caller to ask.
    const out = build([
      send({ fallbackChannel: 'EMAIL' }),
      {
        kind: 'branch',
        label: 'Engagement',
        paths: [
          { label: 'Opened the email', statuses: ['OPENED'], steps: [send({ name: 'Closer', stage: 'reminder' })] },
          { label: 'Read on WhatsApp', statuses: ['READ'], steps: [send({ name: 'Different argument', stage: 'reminder' })] },
        ],
      },
    ]);
    expect(out.issues.map((i) => i.problem).join(' ')).not.toMatch(/does not report OPENED/);
    expect(outcomeSplits(out.graph)).toHaveLength(1);
  });
});

describe('the whole EMI design, end to end', () => {
  /**
   * What this slice is for, as one blueprint: the eligible-purchase event as
   * entry, the ₹10,000 attribute branch the manager evidenced, a wording
   * experiment on the fuller path, WhatsApp with an SMS fallback — and ONE
   * engagement check, after the first touch, where the three people WhatsApp
   * can tell apart get three different jobs.
   *
   * No trailing exits after the forks: the compiler closes every remaining
   * open path itself, and a redundant exit after a fork is the "N open slots
   * exist; the continuation is ambiguous" issue it has always reported.
   */
  const engagementCheck = {
    kind: 'branch',
    label: 'What happened to the first message',
    paths: [
      {
        label: 'Delivered, unread',
        statuses: ['DELIVERED'],
        steps: [{ kind: 'wait', durationHours: 24, why: 'It is sitting unopened.' }, send({ name: 'Same fact, sooner', stage: 'reminder' })],
      },
      {
        label: 'Read, not booked',
        statuses: ['READ'],
        steps: [send({ name: 'What it costs a month', stage: 'reminder', describe: 'Argue the instalment, not the eligibility.' })],
      },
      {
        label: 'Dismissed',
        statuses: ['DELETED'],
        steps: [{ kind: 'wait', durationHours: 120, why: 'Leave them alone until the end.' }, send({ name: 'One last chance', stage: 'outcome' })],
      },
    ],
  };
  const EMI = [
    {
      kind: 'branch',
      label: 'Ticket band',
      entity: 'Transaction',
      attribute: 'Transaction Amount',
      paths: [
        { label: 'Above 10000', operator: 'Greater than', value: '10000', steps: [send({ fallbackChannel: 'SMS' }), engagementCheck] },
        {
          label: 'Everyone else',
          operator: 'Less than',
          value: '10000',
          steps: [
            {
              kind: 'experiment',
              label: 'Generic versus instalment-value framing',
              tests: 'wording',
              arms: [
                { label: 'Generic', pct: 50, steps: [send({ name: 'Generic opening', fallbackChannel: 'SMS' }), { kind: 'wait', durationHours: 48 }, send({ name: 'Generic reminder', stage: 'reminder' })] },
                { label: 'Instalment value', pct: 50, steps: [send({ name: 'Value opening', copy: 'From ₹2,100 a month.', fallbackChannel: 'SMS' }), { kind: 'wait', durationHours: 48 }, send({ name: 'Value reminder', stage: 'reminder' })] },
              ],
            },
          ],
        },
      ],
    },
  ];
  const full = {
    campaignName: 'Authorisation to EMI',
    description: 'Prompt conversion inside the open window.',
    goal: { eventCategory: 'EMI Events', eventType: 'EMI_STATUS_CHANGED', conditions: [] },
    entry: { kind: 'event', eventCategory: 'Transaction Events', eventType: 'Transaction', conditions: [{ attribute: 'EMI Eligible', operator: 'Equals', value: 'true' }] },
    steps: EMI,
  } as unknown as CampaignBlueprint;
  const out = buildFromBlueprint(full, OPTS);

  it('compiles clean, with every path closed', () => {
    expect(out.issues).toEqual([]);
    expect(out.graph.edges.filter((e) => e.to === null)).toHaveLength(0);
  });

  it('carries the who-split AND exactly one engagement check', () => {
    expect(attributeSplits(out.graph)).toHaveLength(1);
    expect(outcomeSplits(out.graph)).toHaveLength(1);
    const cfg = outcomeSplits(out.graph)[0]._config as { branches: { values: string[] }[] };
    expect(cfg.branches.map((b) => b.values)).toEqual([['DELIVERED'], ['READ'], ['DELETED']]);
  });

  it('keeps the experiment, the fallbacks and the Goal Checks', () => {
    const types = Object.values(out.graph.nodes).map((n) => n.type);
    expect(types.filter((t) => t === 'RANDOM_SPLIT')).toHaveLength(1);
    // Goal Checks are the application's own, and this slice does not hide them.
    expect(types.filter((t) => t === 'GOAL_CHECK').length).toBeGreaterThan(0);
    const sends = Object.values(out.graph.nodes).filter((n) => n.type === 'SEND');
    expect(sends.filter((n) => (n._config as { fallbackChannel?: string }).fallbackChannel === 'SMS').length).toBe(3);
  });

  it('reads as a reaction', () => {
    expect(journeyReacts(full)).toBe(true);
    expect(derive(full).has('branch-on-response')).toBe(true);
    expect(derive(full).has('experiment')).toBe(true);
  });
});

describe('the attribute branch is untouched', () => {
  it('still compiles a ticket-size split, and it is not a reaction', () => {
    const ticket = [
      {
        kind: 'branch',
        label: 'Ticket band',
        entity: 'Transaction',
        attribute: 'Transaction Amount',
        paths: [
          { label: 'Above 10000', operator: 'Greater than', value: '10000', steps: [send()] },
          { label: 'Everyone else', operator: 'Less than', value: '10000', steps: [send({ name: 'Other' })] },
        ],
      },
    ];
    const out = build(ticket);
    expect(attributeSplits(out.graph)).toHaveLength(1);
    expect(outcomeSplits(out.graph)).toHaveLength(0);
    const cfg = attributeSplits(out.graph)[0]._config as { source: string; attribute: string; branches: { value: string }[] };
    expect(cfg.source).toBe('Transaction attribute');
    expect(cfg.attribute).toBe('Transaction Amount');
    expect(cfg.branches.map((b) => b.value)).toEqual(['10000', '10000']);
    // Who, not engagement.
    expect(reactsToDelivery(bp(ticket))).toBe(false);
    expect(derive(bp(ticket)).has('branch-on-response')).toBe(false);
  });
});

describe('reactsToDelivery, on the shapes that look close', () => {
  const twoArm = (over: Record<string, unknown> = {}) =>
    bp([
      send(),
      {
        kind: 'branch',
        label: 'Engagement',
        paths: [
          { label: 'Unread', statuses: ['DELIVERED'], steps: [{ kind: 'wait', durationHours: 24 }, send({ name: 'Sooner', stage: 'reminder' })] },
          { label: 'Read', statuses: ['READ'], steps: [send({ name: 'Different argument', stage: 'reminder' })] },
        ],
        ...over,
      },
    ]);

  it('is true for two engagement arms doing different things', () => {
    expect(reactsToDelivery(twoArm())).toBe(true);
  });

  it('is false when the arms run the identical journey', () => {
    expect(
      reactsToDelivery(
        bp([
          send(),
          {
            kind: 'branch',
            label: 'Engagement',
            paths: [
              { label: 'Unread', statuses: ['DELIVERED'], steps: [send({ name: 'Same', stage: 'reminder' })] },
              { label: 'Read', statuses: ['READ'], steps: [send({ name: 'Same again', stage: 'reminder' })] },
            ],
          },
        ]),
      ),
    ).toBe(false);
  });

  it('is false when FAILED versus DELIVERED is the only split', () => {
    expect(
      reactsToDelivery(
        bp([
          send(),
          {
            kind: 'branch',
            label: 'Did it land',
            paths: [
              { label: 'Landed', statuses: ['DELIVERED'], steps: [send({ name: 'Nudge', stage: 'reminder' })] },
              { label: 'Failed', statuses: ['FAILED'], steps: [send({ name: 'SMS', stage: 'first-touch', channelPreference: ['SMS'] })] },
            ],
          },
        ]),
      ),
    ).toBe(false);
  });

  it('is false for a QUEUED-only second arm, because in flight is not engagement', () => {
    expect(
      reactsToDelivery(
        bp([
          send(),
          {
            kind: 'branch',
            label: 'Sent yet',
            paths: [
              { label: 'Read', statuses: ['READ'], steps: [send({ name: 'Argument', stage: 'reminder' })] },
              { label: 'Queued', statuses: ['QUEUED'], steps: [{ kind: 'wait', durationHours: 2 }] },
            ],
          },
        ]),
      ),
    ).toBe(false);
  });

  it('is still true for a Yes/No condition on READ with different sides', () => {
    expect(
      reactsToDelivery(
        bp([
          send(),
          {
            kind: 'condition',
            label: 'Did they read it',
            outcomes: ['READ'],
            yes: [send({ name: 'Different argument', stage: 'reminder' })],
            no: [{ kind: 'wait', durationHours: 24 }, send({ name: 'Same fact sooner', stage: 'reminder' })],
          },
        ]),
      ),
    ).toBe(true);
  });

  it('is false for a wait-and-send clock', () => {
    expect(reactsToDelivery(bp([send(), { kind: 'wait', durationHours: 48 }, send({ name: 'Reminder', stage: 'reminder' })]))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The lock: Confirm is offered only when the STEPS do the fork
// ---------------------------------------------------------------------------

describe('a trailing exit after a fork is a habit, not a defect', () => {
  /** Arms that leave their own path open, which is what makes the fork ambiguous. */
  const forkWith = (armsTerminate: boolean) => [
    send({ fallbackChannel: 'SMS' }),
    {
      kind: 'branch',
      label: 'Engagement',
      paths: [
        {
          label: 'Unread',
          statuses: ['DELIVERED'],
          steps: [
            { kind: 'wait', durationHours: 24 },
            send({ name: 'Sooner', stage: 'reminder' }),
            ...(armsTerminate ? [{ kind: 'exit', reason: 'The window closed.' }] : []),
          ],
        },
        {
          label: 'Read',
          statuses: ['READ'],
          steps: [send({ name: 'Argument', stage: 'outcome' }), ...(armsTerminate ? [{ kind: 'exit', reason: 'The window closed.' }] : [])],
        },
      ],
    },
    { kind: 'exit', reason: 'The window closed.' },
  ];

  it('compiles with no ambiguity issue when the arms leave paths open', () => {
    // MEASURED, and it corrected my own first pin. With arms that TERMINATE
    // there is exactly one open slot left — the reducer's catch-all — so
    // `nextInChain` resolves it and there was never an issue to fix; that
    // version of this test passed against the unfixed compiler and proved
    // nothing. The real case is arms that end on a send: three open slots,
    // and the trailing exit the agent writes out of habit was reported as
    // "the continuation is ambiguous" on a journey that was correct.
    const out = build(forkWith(false));
    const said = out.issues.map((i) => i.problem).join(' ');
    expect(said).not.toMatch(/open slots exist/);
    expect(said).not.toMatch(/continuation is ambiguous/);
    expect(out.issues).toEqual([]);
    // Nothing is lost by skipping it: every path still ends, and the exits
    // the compiler closes with are the same number either way.
    expect(out.graph.edges.filter((e) => e.to === null)).toHaveLength(0);
    expect(Object.values(out.graph.nodes).filter((n) => n.type === 'EXIT')).toHaveLength(3);
    // And the arms still built.
    expect(Object.values(out.graph.nodes).filter((n) => n.type === 'SEND').length).toBe(3);
  });

  it('is equally quiet when the arms do terminate', () => {
    const out = build(forkWith(true));
    expect(out.issues).toEqual([]);
    expect(out.graph.edges.filter((e) => e.to === null)).toHaveLength(0);
  });

  it('still builds an exit that is the only step on an arm', () => {
    // The guard is `i > 0`: an arm whose single step is an exit is that arm's
    // real ending, and dropping it would leave the path to the automatic
    // close instead of the reason the agent gave.
    const out = build([
      send(),
      {
        kind: 'branch',
        label: 'Engagement',
        paths: [
          { label: 'Read', statuses: ['READ'], steps: [send({ name: 'Different argument', stage: 'reminder' })] },
          { label: 'Dismissed', statuses: ['DELETED'], steps: [{ kind: 'exit', reason: 'They dismissed it. Stop here.' }] },
        ],
      },
    ]);
    expect(out.issues).toEqual([]);
    const reasons = Object.values(out.graph.nodes)
      .filter((n) => n.type === 'EXIT')
      .map((n) => (n._config as { reason?: string })?.reason);
    expect(reasons).toContain('They dismissed it. Stop here.');
  });
});

describe('different waits are not different jobs', () => {
  const twoWaits = (a: number, b: number) =>
    bp([
      send(),
      {
        kind: 'branch',
        label: 'Engagement',
        paths: [
          { label: 'Unread', statuses: ['DELIVERED'], steps: [{ kind: 'wait', durationHours: a }, send({ name: 'Reminder', stage: 'reminder' })] },
          { label: 'Read', statuses: ['READ'], steps: [{ kind: 'wait', durationHours: b }, send({ name: 'Reminder', stage: 'reminder' })] },
        ],
      },
    ]);

  it('is false when the arms differ only in how long they wait', () => {
    // `structuralSignature` carries wait:24 against wait:72 as a difference,
    // which would make two clocks read as a reaction. The retry has said
    // "different WAITS on each arm is not different jobs" since it was
    // written; this is the check agreeing with it.
    expect(reactsToDelivery(twoWaits(24, 72))).toBe(false);
  });

  it('is true when one arm argues something else', () => {
    expect(
      reactsToDelivery(
        bp([
          send(),
          {
            kind: 'branch',
            label: 'Engagement',
            paths: [
              { label: 'Unread', statuses: ['DELIVERED'], steps: [{ kind: 'wait', durationHours: 24 }, send({ name: 'Same fact sooner', stage: 'reminder' })] },
              { label: 'Read', statuses: ['READ'], steps: [send({ name: 'What it costs', stage: 'outcome' })] },
            ],
          },
        ]),
      ),
    ).toBe(true);
  });

  it('leaves structuralSignature alone, because the experiment audits share it', () => {
    // A timing experiment is one of the four claims the schema allows, so a
    // different wait IS a legitimate difference between ARMS. The wait-blind
    // comparison is local to the engagement check.
    const src = readFileSync(new URL('../../server/optionAudit.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/const jobSignature = /);
    expect(src).toMatch(/wait:\$\{s\.durationHours\}/);
    const timingArms = bp([
      {
        kind: 'experiment',
        label: 'Same day versus next day',
        tests: 'timing',
        arms: [
          { label: 'Same day', pct: 50, steps: [send(), { kind: 'wait', durationHours: 6 }, send({ name: 'Nudge', stage: 'reminder' })] },
          { label: 'Next day', pct: 50, steps: [send(), { kind: 'wait', durationHours: 48 }, send({ name: 'Nudge', stage: 'reminder' })] },
        ],
      },
    ]);
    // Still two different arms as far as the experiment audit is concerned.
    expect(copyOnlyExperiments(timingArms)).toEqual([]);
  });
});

describe('the gate reads the steps, not only the essay', () => {
  const settled = () => {
    let b = recordAnswer(newBrief('Customers are not converting eligible purchases to EMI.'), 'purchases above 10,000 convert more, they do not realise the purchase qualifies');
    b = recordBarriers(b, [
      { id: 'awareness-gap', statement: 'They do not realise the purchase qualifies.', basis: 'user-belief', lever: 'message', quote: 'they do not realise the purchase qualifies' },
    ]);
    b = recordConverters(b, { shape: 'Purchases above ₹10,000 convert more often.', basis: 'user', knowledge: 'known' });
    b = recordDimensions(b, [
      { name: 'purchase ticket size', rationale: 'They said bigger ones convert.', status: 'retained', basis: 'user', note: 'Theirs.' },
      { name: 'merchant category and card type', rationale: 'Asked together.', status: 'unavailable', basis: 'user', note: 'They do not track either.' },
      { name: 'Channel preference', rationale: 'Where to reach them.', status: 'unavailable', basis: 'none', note: 'No history.' },
    ]);
    return recordSuccessCriteria(b, ['More eligible purchases converted before they lapse.']);
  };

  /** The essay: a winner that reacts, and prose naming two landed cases. */
  const REACTIVE_PLAN = {
    summary: 'Catch them while the purchase is fresh.',
    approach: ['Everyone eligible enters.'],
    strategyOptions: [{ option: 'Experimentation', verdict: 'used', why: 'Two openings, randomly assigned.' }],
    architectures: [
      { name: 'Catch the moment', journey: 'branch-on-response', chosen: true },
      { name: 'Work the statement date', journey: 'linear' },
    ],
    touches: [
      { day: 0, channel: 'WHATSAPP', path: 'all', purpose: 'Opening.', ifStillUnconverted: 'If it is still sitting unread, repeat the same fact sooner.' },
      { day: 2, channel: 'SMS', path: 'all', purpose: 'Last chance.', ifStillUnconverted: 'If they read it and did nothing, argue the instalment instead.' },
    ],
    assumptions: [],
    unknowns: [],
  };

  /** The live EMI shape: a who-split and a copy test, no engagement fork. */
  const CLOCK_STEPS = [
    {
      kind: 'branch',
      label: 'Ticket band',
      entity: 'Transaction',
      attribute: 'Transaction Amount',
      paths: [
        { label: 'Above 10000', operator: 'Greater than', value: '10000', steps: [send(), { kind: 'wait', durationHours: 48 }, send({ name: 'Reminder', stage: 'reminder' })] },
        { label: 'Everyone else', operator: 'Less than', value: '10000', steps: [send({ name: 'Other opening' }), { kind: 'wait', durationHours: 72 }, send({ name: 'Other reminder', stage: 'reminder' })] },
      ],
    },
  ];

  it('holds the plan whose essay claims a reaction and whose steps are the live clock', () => {
    const d = decide(settled(), { proposed: { strategy: REACTIVE_PLAN, blueprint: bp(CLOCK_STEPS) } as never });
    expect(d.blocks.map((b) => b.code)).toContain('no-reaction');
    expect(d.proceed).toBe(false);
  });

  it('lets the same essay through once the steps carry one engagement fork', () => {
    const d = decide(settled(), { proposed: { strategy: REACTIVE_PLAN, blueprint: bp(GOLD) } as never });
    expect(d.blocks.map((b) => b.code), d.blocks.map((b) => b.reason).join(' | ')).not.toContain('no-reaction');
  });

  it('accepts a wait-for-event journey against a wait-for-event winner', () => {
    const waiting = {
      ...REACTIVE_PLAN,
      architectures: [{ name: 'Hold for the booking', journey: 'wait-for-event', chosen: true }, { name: 'Clock', journey: 'linear' }],
    };
    const steps = [
      send(),
      { kind: 'waitForEvent', eventCategory: 'EMI Events', eventType: 'EMI_STATUS_CHANGED', timeoutDays: 7 },
      send({ name: 'Last chance', stage: 'outcome' }),
    ];
    const d = decide(settled(), { proposed: { strategy: waiting, blueprint: bp(steps) } as never });
    expect(d.blocks.map((b) => b.code)).not.toContain('no-reaction');
  });

  it('is skipped on the build turn, like every other propose-time block', () => {
    const d = decide(settled(), { proposed: { strategy: REACTIVE_PLAN, blueprint: bp(CLOCK_STEPS) } as never, building: true });
    expect(d.blocks.map((b) => b.code)).not.toContain('no-reaction');
  });

  it('says nothing when the turn carries no steps, because propose has none', () => {
    // MEASURED on `ui-s-1792748248345`: the proposing turn carries `strategy`
    // and `blueprint: false`. `propose_strategy` has no blueprint in its
    // schema and `systemForPhase(false)` withholds the grammar deliberately,
    // so blocking on a missing journey there would be a refusal with no legal
    // move. The JSON propose path DOES carry one, and that is where this
    // binds today.
    const d = decide(settled(), { proposed: { strategy: REACTIVE_PLAN } as never });
    expect(d.blocks.map((b) => b.code)).not.toContain('no-reaction');
  });

  it('is handed the journey by the orchestrator, not just by tests', () => {
    const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    expect(orch).toMatch(/blueprint: proposed\.blueprint \?\? null/);
  });
});
