// The journey recipe the agent writes: a closed vocabulary that
// buildFromBlueprint compiles into the builder's own graph. Recursive by $ref,
// so experiment arms, condition branches and branch paths are checked by the
// API before any application code runs.
import { dcOperatorsForAttribute, LOCKED_ATTR_OPERATORS, type AttrMeta, type AttrType } from '../../src/data/sharedConstants';

const TYPES: AttrType[] = ['date', 'select', 'bool', 'number', 'list', 'smartTag', 'multiSelect', 'highestTxnEMI', 'none'];
export const BUILDER_OPERATORS = [
  ...new Set([
    ...TYPES.flatMap((type) => dcOperatorsForAttribute({ type } as AttrMeta)),
    ...LOCKED_ATTR_OPERATORS,
  ]),
];

export const CONDITION = {
  type: 'object',
  properties: {
    attribute: { type: 'string' },
    operator: { type: 'string', enum: BUILDER_OPERATORS },
    value: { type: 'string' },
  },
  required: ['attribute', 'operator'],
} as const;

export const STEP_DEF = {
  type: 'object',
  description: 'One step. "kind" decides which other fields apply.',
  properties: {
    kind: {
      type: 'string',
      enum: ['send', 'wait', 'waitForEvent', 'exit', 'experiment', 'condition', 'branch'],
    },
    // send
    name: { type: 'string' },
    objective: { type: 'array', items: { type: 'string' } },
    stage: { type: 'string', enum: ['first-touch', 'reminder', 'outcome'] },
    describe: { type: 'string' },
    copy: { type: 'string', description: 'The message itself, as the CUSTOMER reads it. Never a description of it.' },
    cta: { type: 'string' },
    channelPreference: { type: 'array', items: { type: 'string' } },
    barrier: { type: 'string', description: 'The id of the barrier this send attacks. Checked against your recorded findings.' },
    delayDays: { type: 'number', description: 'Days after the previous step (or entry). This is the Send node\'s own relativeDuration, not a Wait step. Omit to keep the builder\'s Absolute 11:00 default.' },
    atTime: { type: 'string', description: 'Clock time this send fires, e.g. "11:00". The Send node already has absTime.' },
    fallbackChannel: { type: 'string', description: 'Fallback on THIS send if delivery fails, e.g. SMS. Not a second step.' },
    // wait
    durationHours: { type: 'number', description: 'Wait steps only, and required for them: how long to wait, in HOURS (48 = 2 days). Do not use delayDays on a wait.' },
    why: { type: 'string' },
    // waitForEvent
    eventCategory: { type: 'string' },
    eventType: { type: 'string' },
    timeoutDays: { type: 'number' },
    conditions: { type: 'array', items: CONDITION },
    // exit
    reason: { type: 'string' },
    // experiment / condition / branch
    label: { type: 'string' },
    tests: { type: 'string', enum: ['wording', 'explanation', 'timing', 'audience'], description: 'What the experiment actually compares. Arms must differ in THIS.' },
    arms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          pct: { type: 'number' },
          steps: { type: 'array', items: { $ref: '#/$defs/step' } },
        },
        required: ['label', 'pct', 'steps'],
      },
    },
    outcomes: { type: 'array', items: { type: 'string' } },
    on: {
      type: 'object',
      properties: {
        entity: { type: 'string' },
        attribute: { type: 'string' },
        operator: { type: 'string', enum: BUILDER_OPERATORS },
        value: { type: 'string' },
      },
      required: ['entity', 'attribute', 'operator'],
    },
    yes: { type: 'array', items: { $ref: '#/$defs/step' } },
    no: { type: 'array', items: { $ref: '#/$defs/step' } },
    entity: { type: 'string' },
    attribute: { type: 'string' },
    paths: {
      type: 'array',
      description:
        'Arms of a "branch". TWO SHAPES. On an attribute branch (you sent "entity" and "attribute") every path carries "operator" and "value" — that is who the customer IS. On an outcome branch (no entity, no attribute) every path carries "statuses" — the delivery statuses of the SEND immediately before it, which is what the customer DID. Do not mix the two on one branch.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          operator: { type: 'string', enum: BUILDER_OPERATORS, description: 'Attribute branch only.' },
          value: { type: 'string', description: 'Attribute branch only.' },
          statuses: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Outcome branch only. Statuses from the preceding send\'s channel, e.g. ["DELIVERED"] / ["READ"] / ["DELETED"] on WhatsApp. Never QUEUED, SENT or PENDING: the message is still in flight and that is not a person. Never a FAILED, UNKNOWN or NOT_DELIVERED arm: undelivered is "fallbackChannel" on the send itself, and an arm there would have nothing different to say.',
          },
          steps: { type: 'array', items: { $ref: '#/$defs/step' } },
        },
        // `operator` and `value` ARE NO LONGER REQUIRED, because an outcome
        // path has neither. The compiler checks the pair that applies to the
        // shape it was given; requiring both here would have made the outcome
        // branch unsendable while the API reported it as a schema error.
        required: ['label', 'steps'],
      },
    },
  },
  required: ['kind'],
} as const;


/**
 * The journey itself, as JSON Schema.
 *
 * HOISTED SO TWO TOOLS SHARE ONE GRAMMAR, 2026-10-23. `propose_strategy` now
 * carries the path it is asking the manager to approve, and the alternative
 * was a second copy of this object — which is how the architecture fields and
 * the two event-label maps drifted. One definition, referenced twice.
 */
export const BLUEPRINT_SCHEMA = {
  type: 'object' as const,
  properties: {
    campaignName: { type: 'string' },
    description: { type: 'string' },
    controlPct: {
      type: 'number',
      description:
        'Ignored. The campaign uses the builder default (10% control, DNC and NPA on). Do not design a holdout or an exclusion list.',
    },
    goal: {
      type: 'object',
      description: 'The event that proves the behaviour happened. Null if there is genuinely none.',
      properties: {
        eventCategory: { type: 'string' },
        eventType: { type: 'string' },
        conditions: { type: 'array', items: CONDITION },
      },
      required: ['eventCategory', 'eventType'],
    },
    entry: {
      type: 'object',
      description: 'Where the behaviour has NOT happened yet and still can.',
      properties: {
        kind: { type: 'string', enum: ['event', 'audience'] },
        eventCategory: { type: 'string' },
        eventType: { type: 'string' },
        entity: { type: 'string' },
        conditions: { type: 'array', items: CONDITION },
        groups: {
          type: 'array',
          description: 'Further entity blocks, ANDed with the primary one. This is how one entry combines conditions across entities.',
          items: {
            type: 'object',
            properties: {
              entity: { type: 'string' },
              conditions: { type: 'array', items: CONDITION },
              lookbackDays: { type: 'number', description: 'Transaction only.' },
              existence: { type: 'string', enum: ['exists', 'none'], description: 'Transaction only. "none" tests the ABSENCE of a matching record over the window — not over all time.' },
            },
            required: ['entity'],
          },
        },
      },
      required: ['kind'],
    },
    steps: { type: 'array', items: { $ref: '#/$defs/step' }, minItems: 1 },
  },
  required: ['campaignName', 'description', 'entry', 'steps'],
};
