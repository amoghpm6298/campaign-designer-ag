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

/** The fork itself: three WhatsApp people, three jobs. */
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
      steps: [send({ name: 'What it costs a month', stage: 'outcome', describe: 'Argue the instalment.', channelPreference: ['SMS'], barrier })],
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
