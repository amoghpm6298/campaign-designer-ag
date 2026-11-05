// A journey that reacts, for fixtures whose subject is something else.
//
// WHY THIS IS SHARED. Since `propose_strategy` carries the path, every fixture
// that proposes needs one — and a reactive winner needs one that actually
// forks on what the customer did, or `reactionBlocks` holds the turn and the
// test proves nothing about its own subject. Five files needed the same shape
// on the same day; a sixth copy would have been the drift this codebase has
// been bitten by with the architecture fields and the event-label maps.
//
// ONE engagement check, not one per send. That is the shape the slice argues
// for: unread gets the same fact sooner, read-and-not-booked gets a different
// argument, and the later touches are linear.
export const send = (over: Record<string, unknown> = {}) => ({
  kind: 'send',
  name: 'Eligibility notice',
  objective: ['emi', 'convert'],
  stage: 'first-touch',
  describe: 'Say the purchase qualifies and what the instalment costs.',
  copy: 'Split this purchase from ₹2,100 a month.',
  channelPreference: ['WHATSAPP'],
  barrier: 'cost-perception',
  ...over,
});

/**
 * The fork itself: two WhatsApp people, two jobs — and the arms SPEND
 * DIFFERENTLY.
 *
 * Both arms used to carry one send, and `jobSignature` called them different
 * because one waited and one changed channel. `reactsToDelivery` counts the
 * messages now: equal spend is the same job however the channels or waits
 * differ. So the read arm gets the argument AND the consequence of waiting,
 * which is what "read and no action needs a different ask" means — the unread
 * arm just needs the same fact again, sooner.
 */
export const engagementFork = (barrier = 'cost-perception') => ({
  kind: 'branch',
  label: 'What happened to the first message',
  paths: [
    {
      label: 'Delivered, still unread',
      statuses: ['DELIVERED'],
      steps: [
        { kind: 'wait', durationHours: 24, why: 'It is sitting unopened.' },
        send({ name: 'Same fact, sooner', stage: 'reminder', describe: 'Repeat that it qualifies.', barrier }),
      ],
    },
    {
      label: 'Read, not booked',
      statuses: ['READ'],
      steps: [
        send({ name: 'What it costs a month', stage: 'reminder', describe: 'Argue the instalment.', channelPreference: ['SMS'], barrier }),
        send({ name: 'What waiting costs', stage: 'outcome', describe: 'The window closes and the rate goes.', channelPreference: ['SMS'], barrier }),
      ],
    },
  ],
});

/**
 * A complete, reacting path. `barrier` must match whatever the fixture's brief
 * recorded, because `checkBarrierCoverage` refuses an uncited send on the
 * build turn.
 */
export const reactingPath = (over: Record<string, unknown> = {}, barrier = 'cost-perception') => ({
  campaignName: 'Authorisation to EMI',
  description: 'Prompt conversion inside the open window, and react to what the first message did.',
  goal: null,
  entry: { kind: 'audience', entity: 'Card', conditions: [{ attribute: 'Status', operator: 'Equals', value: 'Active' }] },
  steps: [send({ fallbackChannel: 'SMS', barrier }), engagementFork(barrier)],
  ...over,
});

/**
 * Two arms that are the same journey, described differently.
 *
 * THE SHAPE A LIVE RUN KEEPS PRODUCING: same contacts, same channels, same
 * spacing, different paragraphs. `checkExperimentClaims` refuses it for any
 * claim except `wording`, and since 2026-11-03 it is refused at propose time
 * rather than after a refinement — `eval/runs/ui-s-1793616608652` turn 3
 * filed one against a record that said nobody knew why, and Confirm built it.
 *
 * SHARED, because two files now assert on it and the audit's own fixture is
 * the authority on what "copy-only" means. A second copy is how the
 * architecture fields and the two event-label maps drifted.
 */
export const COPY_ONLY_ARMS: [unknown[], unknown[]] = [
  [send({ copy: 'Converting is easy.' }), { kind: 'wait', durationHours: 48 }, send({ stage: 'reminder', channelPreference: ['SMS'] })],
  [send({ copy: 'Here is what it costs.' }), { kind: 'wait', durationHours: 48 }, send({ stage: 'reminder', channelPreference: ['SMS'] })],
];

/** One experiment step over a pair of arms, with whatever it claims to test. */
export const experimentOf = (tests: string, arms: [unknown[], unknown[]] = COPY_ONLY_ARMS) => ({
  kind: 'experiment',
  label: 'Dormancy test',
  tests,
  arms: [
    { label: 'A', pct: 50, steps: arms[0] },
    { label: 'B', pct: 50, steps: arms[1] },
  ],
});
