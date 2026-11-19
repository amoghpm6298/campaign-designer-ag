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
      enum: ['send', 'wait', 'goalCheck', 'waitForEvent', 'exit', 'experiment', 'condition', 'branch'],
      description: 'goalCheck: everyone who has reached the campaign goal leaves here as converted; the rest continue. No other fields.',
    },
    // reasoning (every kind): read by the canvas and the reviewer, never by the engine
    rationale: {
      type: 'string',
      description:
        'Your AI rationale for this step, for the person reviewing the campaign: why this step, here, like this. Send: why this angle and copy for this bucket at this point, what it builds on from the previous message, and the evidence (numbers exactly as queried, or say it is your judgement). Wait: why this length, one short line. Condition or branch: why split here and what each route is for. Specific to this bucket and step, never generic.',
    },
    hypothesis: { type: 'string', description: 'Experiment only, required: what the test is trying to learn, e.g. "If rewards framing beats benefits framing, lapsed spenders respond to value already earned, and later messages should lead with it."' },
    successMetric: { type: 'string', description: 'Experiment only, required: how the winner is judged: the metric compared between arms and over what window, e.g. "share of each arm that transacts within 7 days of the first message". Until the campaign runs, the result is unknown.' },
    // a signal switch, and split ideas
    signal: { type: 'string', description: 'Branch only: route by one of the bank\'s signals (list_signals key, usable for switching). Each path then gives operator and value on that signal; otherwise (everyone else) is required.' },
    splitIdea: {
      type: 'object',
      description: 'Optional, rare: your hypothesis that people at this step would respond differently by some signal, so the journey from here might split into routes. A helper tests it against the data after you build, and splits from this step onward only if the data backs it. Never split it yourself.',
      properties: { hypothesis: { type: 'string' }, by: { type: 'array', items: { type: 'string' }, description: 'Signal keys to try.' } },
      required: ['hypothesis', 'by'],
    },
    // an offer on a send (banks with an incentive menu)
    incentive: { type: 'string', description: 'Send only: the id of an offer from list_incentives that this message makes. The system adds the offer\'s exact line after the copy; never write the offer, amounts or terms yourself. Leave it out for a message with no offer.' },
    costAssumptions: {
      type: 'object',
      description: 'Required on a send that carries an incentive: your estimates for the cost calculator. reach = share of the bucket that gets this message (1 if everyone; lower if only non-responders reach it); redeem = share of those who take the offer up. Each as a fraction 0-1, for "expected" and for "few" (if the campaign underperforms; few <= expected), with why (where the estimate comes from: past results in the data, or your judgement).',
      properties: {
        reach: { type: 'object', properties: { expected: { type: 'number' }, few: { type: 'number' }, why: { type: 'string' } }, required: ['expected', 'few', 'why'] },
        redeem: { type: 'object', properties: { expected: { type: 'number' }, few: { type: 'number' }, why: { type: 'string' } }, required: ['expected', 'few', 'why'] },
      },
    },
    // send
    name: { type: 'string' },
    objective: { type: 'array', items: { type: 'string' } },
    stage: { type: 'string', enum: ['first-touch', 'reminder', 'outcome'] },
    describe: { type: 'string' },
    copy: { type: 'string', description: 'The message itself, as the CUSTOMER reads it. Never a description of it. Never contains a URL or web address: the link is added by the system.' },
    cta: { type: 'string', description: 'The action wording, e.g. "Activate now". Never a URL.' },
    link: { type: 'string', description: 'Where the CTA takes the customer: a reference from list_links (e.g. "activate_card"). Never a URL. Leave it out only when the message just informs, or when the bank has no suitable link.' },
    channelPreference: { type: 'array', items: { type: 'string' } },
    barrier: { type: 'string', description: 'The id of the barrier this send attacks. Checked against your recorded findings.' },
    delayDays: { type: 'number', description: 'Days after the previous step (or entry). This is the Send node\'s own relativeDuration, not a Wait step. Omit to keep the builder\'s Absolute 11:00 default.' },
    atTime: { type: 'string', description: 'Clock time this send fires, e.g. "11:00". The Send node already has absTime.' },
    fallbackChannel: { type: 'string', description: 'Leave unset: delivery fallback is a bank-wide setting. Set it only when the manager asks for an exception on this message.' },
    // wait
    durationHours: { type: 'number', description: 'Wait steps only, and required for them: how long to wait, in HOURS (48 = 2 days). Do not use delayDays on a wait.' },
    // waitForEvent
    eventCategory: { type: 'string' },
    eventType: { type: 'string' },
    timeoutDays: { type: 'number' },
    conditions: { type: 'array', items: CONDITION },
    // exit
    reason: { type: 'string', description: 'Exit steps: a short label for this ending, in plain words.' },
    outcome: {
      type: 'string',
      enum: ['no_response', 'not_reachable', 'declined'],
      description:
        'Exit steps: how the customer left. no_response = got the messages and did not act; not_reachable = no message got through; declined = said no (needs reply capture, a proposed capability). Converted is the goal check and opted out is the system, so never write those.',
    },
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
              'Outcome branch only. Statuses from the preceding send\'s channel, e.g. ["DELIVERED"] / ["READ"] / ["DELETED"] on WhatsApp. Never QUEUED, SENT or PENDING: the message is still in flight and that is not a person. Never a FAILED, UNKNOWN or NOT_DELIVERED arm: everyone no path matches (the undelivered) takes the branch\'s "otherwise" route.',
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
    otherwise: {
      type: 'array',
      items: { $ref: '#/$defs/step' },
      description:
        'Branch only: the "Anything else" route, everyone no path matched. On a delivery branch these are the people the message never reached (failed, still queued, unknown). Decide it on purpose: e.g. one try on a DIFFERENT channel, then an exit with outcome not_reachable.',
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
