// How the model writes to the record: tool calls, not a JSON blob.
//
// WHAT THIS REPLACES. The model answered with one JSON object carrying
// everything at once — prose, question bookkeeping, findings, dimensions, the
// strategy and the blueprint. Four separate problems came out of that single
// shape:
//
//  1. THE DEADLOCK. `barriers` existed in the "ask" template and not the
//     "propose" one, while the prompt said "You cannot propose without both"
//     and the gate enforced it. One hand-maintained shape in two places
//     cannot be kept consistent, and nothing checked.
//  2. THE DEAD STREAM. Prose sat behind six machine fields, so the UI had
//     nothing to show until the payload was nearly complete — and fell back
//     to scraping `"summary"` out of half-finished JSON with a regex.
//  3. THE PROMPT CAP. Roughly 7,350 of 33,500 characters were hand-written
//     JSON schemas. Adding one field meant trading against tests that pin
//     method sentences verbatim.
//  4. NO PARTIAL CREDIT. One malformed field invalidated the whole turn, so a
//     good finding was lost because an unrelated part of the payload was
//     wrong.
//
// Tool calls fix all four structurally. The schema lives in the API's own
// `tools` parameter where it costs no prompt budget and the API enforces it;
// prose becomes a plain text block that streams; each call is validated and
// applied on its own, so one bad call does not discard the others.
//
// SCOPE. These three tools feed the RECORD, which is what the gate blocks on
// and where every measured deadlock lived. `propose_strategy` and
// `build_campaign` are a separate pass: the blueprint grammar is the single
// largest artefact in the prompt and converting it deserves its own change
// rather than riding along with this one.
import {
  recordAsked,
  type AskAuthor,
} from './record';
import {
  recordConverters,
  recordBarriers,
  recordDimensions,
  recordContextChecked,
  recordQuestionResolutions,
  type WorkingBrief,
  type DimensionUpdate,
  type QuestionImpact,
  type QuestionContingency,
  type QuestionResolution,
} from './discovery';
import type { Converters, Barrier } from './findings';
import type { CampaignBlueprint } from './blueprint';
import type { Strategy } from './orchestrator';
import { registerToolTitles, type ToolDef } from './agentTools';
import { dcOperatorsForAttribute, LOCKED_ATTR_OPERATORS, type AttrMeta, type AttrType } from '../src/data/sharedConstants';

/**
 * Every operator the builder offers, computed from the builder itself.
 *
 * NOT A SECOND LIST. `dcOperatorsForAttribute` is the one place that decides
 * which operators an attribute accepts, and the union over its input types is
 * the complete set the API should allow. Hand-writing the same five strings
 * here would create exactly the drift this codebase has been bitten by twice
 * today — two vocabularies for one thing, disagreeing silently.
 *
 * The field was `{ type: 'string' }`, so `equals` and `within_days` were valid
 * as far as the API was concerned and only failed deep in the compiler, after
 * the manager had already approved the plan. An enum fails them at the call.
 */
// Every member of AttrType, so the union is complete by construction rather
// than by whoever edited this last remembering to add one.
const TYPES: AttrType[] = ['date', 'select', 'bool', 'number', 'list', 'smartTag', 'multiSelect', 'highestTxnEMI', 'none'];
export const BUILDER_OPERATORS = [
  ...new Set([
    ...TYPES.flatMap((type) => dcOperatorsForAttribute({ type } as AttrMeta)),
    ...LOCKED_ATTR_OPERATORS,
  ]),
];

/**
 * Input shapes, declared against the real types.
 *
 * These exist so the compiler catches drift between a tool's JSON schema and
 * the interface it feeds. Widening `Barrier` without touching the schema below
 * is the bug that caused the deadlock, and it was invisible because the schema
 * was a string in a prompt.
 */
export interface AskQuestionsInput {
  questions: { text: string; impact?: QuestionImpact; contingency?: QuestionContingency }[];
}
export interface RecordFindingsInput {
  converters?: Converters;
  barriers?: Barrier[];
  /** Ids of questions this reply genuinely did not touch. Usually empty. */
  notCovered?: string[];
}
export interface RecordDimensionsInput {
  dimensions: DimensionUpdate[];
}

const BASIS = ['user', 'user-belief', 'assumption', 'none'];


/**
 * The journey grammar, as JSON Schema rather than 7,350 characters of prose in
 * the system prompt.
 *
 * Recursive by `$ref`, which the prompt version could not express at all: an
 * experiment arm, a condition branch and a branch path each contain steps, and
 * the prompt had to describe that in words and hope. Here it is checked by the
 * API before a single line of application code runs.
 */
const CONDITION = {
  type: 'object',
  properties: {
    attribute: { type: 'string' },
    operator: { type: 'string', enum: BUILDER_OPERATORS },
    value: { type: 'string' },
  },
  required: ['attribute', 'operator'],
} as const;

const STEP_DEF = {
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
    durationHours: { type: 'number' },
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
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          operator: { type: 'string', enum: BUILDER_OPERATORS },
          value: { type: 'string' },
          steps: { type: 'array', items: { $ref: '#/$defs/step' } },
        },
        required: ['label', 'operator', 'value', 'steps'],
      },
    },
  },
  required: ['kind'],
} as const;

const STRING_LIST = { type: 'array', items: { type: 'string' } } as const;

export const OUTPUT_TOOLS: ToolDef[] = [
  {
    name: 'propose_strategy',
    title: 'Putting the plan to you',
    description:
      'Propose the plan, BEFORE anything is built. Two candidate architectures, each naming the barrier it attacks, then the one you chose and why — citing what the manager told you rather than a general preference. Two architectures differ when they reach DIFFERENT PEOPLE, at a DIFFERENT MOMENT, or by a DIFFERENT MEANS; a different tone, channel order or send count is the same campaign twice. Do not call build_campaign in the same turn: the manager approves the plan first.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '2-4 sentences, in the manager\'s own terms.' },
        approach: { ...STRING_LIST, description: 'Each entry names what it rests on: what the user told you, what a tool returned, or what you assumed.' },
        assumptions: STRING_LIST,
        unknowns: STRING_LIST,
        successCriteria: { ...STRING_LIST, description: 'How the business would judge this. Never a target number — no performance history exists.' },
        measurement: { ...STRING_LIST, description: 'What to track and how to read it. No forecast.' },
        hypotheses: { ...STRING_LIST, description: 'Worth testing later, explicitly not claimed now.' },
        rejected: {
          type: 'array',
          items: { type: 'object', properties: { option: { type: 'string' }, why: { type: 'string' } }, required: ['option', 'why'] },
        },
        architectures: {
          type: 'array',
          minItems: 2,
          description: 'Exactly the comparison that decides the campaign. The application checks these are genuinely distinguishable.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              barrier: { type: 'string', description: 'The customer problem this one attacks. Two candidates attacking the SAME barrier are one architecture described twice.' },
              lever: { type: 'string' },
              audience: { type: 'string' },
              timing: { type: 'string' },
              journey: { type: 'string' },
              measurement: { type: 'string' },
              tradeOff: { type: 'string' },
              chosen: { type: 'boolean' },
              why: { type: 'string' },
            },
            required: ['name', 'barrier'],
          },
        },
        touches: {
          type: 'array',
          minItems: 2,
          description:
            'EVERY customer-facing send in the chosen plan, in order, one row each. Prose is not this list: "a staggered multi-touch sequence over the full 14 days" names no sends, and a manager cannot approve a cadence they cannot see. Give the first touch, at least one reminder, and the last chance before the window closes. A lighter path — a group that mostly acts on its own — may carry fewer rows, but it must be a NAMED path here rather than an absence; the primary path still needs at least two.',
          items: {
            type: 'object',
            properties: {
              day: { type: 'number', description: 'Days after entry. 0 is the moment they enter.' },
              channel: { type: 'string', description: 'In plain words — WhatsApp, SMS, Email.' },
              path: { type: 'string', description: 'Which group this send is for. Use the same path names as the plan above, and say "all" when there is only one.' },
              purpose: { type: 'string', description: 'What this message is FOR, in the manager\'s terms. Not the copy.' },
              ifStillUnconverted: { type: 'string', description: 'What happens next if this one does not land — not delivered, not read, or read and nothing done.' },
            },
            required: ['day', 'channel', 'path', 'purpose', 'ifStillUnconverted'],
          },
        },
        openItems: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['strategic-ambiguity', 'missing-evidence', 'platform-gap'] },
              question: { type: 'string' },
              whyItMatters: { type: 'string' },
              ifUnanswered: { type: 'string' },
            },
            required: ['kind', 'question'],
          },
        },
      },
      // `touches` IS REQUIRED, which is what stops an unnamed cadence at the
      // API rather than three layers down. The same move that stopped
      // `within_days`: a constraint the provider enforces costs nothing to
      // maintain and fires before any of our code runs.
      required: ['summary', 'approach', 'assumptions', 'unknowns', 'touches'],
    },
  },
  {
    name: 'build_campaign',
    title: 'Building the journey',
    description:
      'Build the approved plan as a journey. Only ever called AFTER the manager has approved a strategy. Emit no ids of any kind — the application owns every node id, edge id and template id, and builds the graph through the product\'s own reducer. If the plan cannot be expressed in this grammar, say so in text instead of building a lesser version: a campaign that silently dropped a requirement is worse than no campaign and a plain statement of what is in the way.',
    input_schema: {
      type: 'object',
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
      $defs: { step: STEP_DEF },
    },
  },
  {
    name: 'ask_questions',
    title: 'Putting questions to you',
    description:
      'Ask the campaign manager up to three questions. Declare how much rides on each ANSWER: "fork" means two different answers mean two different campaigns, "shaping" changes how it is built, "detail" has a safe default. A fork must say what it would do under each answer, so the application can check that the two answers actually lead somewhere different — a question whose answers lead to the same decision is not worth the manager\'s attention.',
    input_schema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'The question, in plain language. Never an internal name or id.' },
              impact: { type: 'string', enum: ['fork', 'shaping', 'detail'] },
              contingency: {
                type: 'object',
                description: 'Required on a fork.',
                properties: {
                  ifA: { type: 'string' },
                  thenA: { type: 'string' },
                  ifB: { type: 'string' },
                  thenB: { type: 'string', description: 'Must differ from thenA.' },
                  ifUnknown: { type: 'string', description: 'What you would assume if they cannot answer.' },
                },
              },
            },
            required: ['text'],
          },
        },
      },
      required: ['questions'],
    },
  },
  {
    name: 'record_findings',
    title: 'Recording what you told me about customers',
    description:
      'Record who converts today and why the rest do not. Call this on EVERY turn where the manager has said anything about either — you cannot propose a strategy without both. A barrier must carry the manager\'s own words in "quote"; the application checks the quote against what they actually typed and downgrades an unverifiable one to an assumption rather than rejecting it. "notCovered" is for the rare case where their reply genuinely did not touch a question you asked; leaving it empty is normal and correct.',
    input_schema: {
      type: 'object',
      properties: {
        converters: {
          type: 'object',
          description: 'Who already does this, in the manager\'s words.',
          properties: {
            shape: { type: 'string' },
            basis: { type: 'string', enum: BASIS },
            knowledge: {
              type: 'string',
              enum: ['known', 'none-yet', 'unknown'],
              description: '"none-yet" means nobody can say. That demands MORE work, not less: supply at least two candidate trends resting on different things, and design a run that tells them apart. Do not wait for the manager to pick one, and do not split the journey on a trend nobody has seen.',
            },
            candidates: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  segment: { type: 'string' },
                  restsOn: { type: 'string', description: 'What defines this group. Two candidates must rest on DIFFERENT things.' },
                  why: { type: 'string' },
                },
                required: ['segment', 'restsOn', 'why'],
              },
            },
          },
          required: ['shape', 'basis', 'knowledge'],
        },
        barriers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              statement: { type: 'string', description: 'What is stopping them, as a customer problem.' },
              basis: { type: 'string', enum: BASIS },
              lever: {
                type: 'string',
                enum: ['message', 'timing', 'targeting', 'not-addressable'],
                description: '"not-addressable" is how you say this reason is real and a drip campaign cannot fix it.',
              },
              quote: { type: 'string', description: "The manager's own words. Checked." },
            },
            required: ['id', 'statement', 'basis', 'lever'],
          },
        },
        notCovered: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'record_dimensions',
    title: 'Recording what could change this campaign',
    description:
      'Record the factors whose answers could genuinely change THIS campaign, and what became of each. A dimension is something that might SEGMENT these customers; a reason they do not act is a barrier and belongs in record_findings. Anything not carried into the design must say why in "note" — ruling something out is a decision, so it needs a reason. If the manager said they do not know, the application writes that note for you from their own words.',
    input_schema: {
      type: 'object',
      properties: {
        dimensions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              rationale: { type: 'string', description: 'Why it could change THIS campaign.' },
              status: { type: 'string', enum: ['open', 'retained', 'deferred', 'unavailable'] },
              basis: { type: 'string', enum: [...BASIS, 'tool'] },
              note: { type: 'string', description: 'What was found, or why it was ruled out.' },
            },
            required: ['name'],
          },
        },
        // THE SLOTS THAT NEARLY VANISHED. Both lived in the JSON payload, and
        // deleting that section from the prompt would have silently removed
        // two capabilities: the agent could no longer say what it consulted,
        // nor decide to carry or defer a question it had asked. Caught by the
        // tests that pinned the old payload — the one time those brittle
        // source-text assertions earned their keep.
        contextChecked: {
          type: 'array',
          description: 'What you actually consulted this turn, and whether anything was found. Never imply access you do not have.',
          items: {
            type: 'object',
            properties: { source: { type: 'string' }, found: { type: 'boolean' } },
            required: ['source', 'found'],
          },
        },
        questionResolutions: {
          type: 'array',
          description: 'A question you asked and have now decided to carry as an open decision or defer, naming which and why.',
          items: {
            type: 'object',
            properties: {
              questionId: { type: 'string' },
              kind: { type: 'string', enum: ['carried', 'deferred'] },
              why: { type: 'string' },
            },
            required: ['questionId', 'kind', 'why'],
          },
        },
      },
      required: ['dimensions'],
    },
  },
  {
    name: 'request_evidence',
    title: 'Asking for data',
    description:
      'Ask for aggregated data, and ONLY when it would change a decision you are about to make and the brief does not already say it is unavailable. Aggregated counts and rates only — never customer-level or personal data.',
    input_schema: {
      type: 'object',
      properties: {
        evidence: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: 'The business question it answers.' },
              fields: { type: 'array', items: { type: 'string' } },
              grouping: { type: 'string' },
              period: { type: 'string' },
              wouldInform: { type: 'string', description: 'What you would do differently once you had it.' },
            },
            required: ['question', 'fields', 'wouldInform'],
          },
        },
      },
      required: ['evidence'],
    },
  },
];

export const OUTPUT_TOOL_NAMES = OUTPUT_TOOLS.map((t) => t.name);

/**
 * The output tools available on this turn.
 *
 * `build_campaign`'s schema IS the journey grammar — every step kind, the
 * entry shapes, the entity groups. Registering it on a discovery turn hands
 * the agent the builder's vocabulary before it has a plan, which is the exact
 * leak that was closed in `systemForPhase` and then reopened here the moment
 * the grammar moved out of the prompt and into a tool. A proposal written
 * inside the platform's limits is a proposal the platform wrote.
 *
 * Caught by the two tests that pinned the prompt-level gate. They looked like
 * brittle source-text assertions and were in fact guarding the standing
 * decision that the strategy comes first and the platform second.
 */
/**
 * A build turn builds. It does not propose again.
 *
 * `propose_strategy` used to travel on a Confirm turn, and its own
 * description says "Do not call build_campaign in the same turn: the manager
 * approves the plan first." So the one turn that exists to build carried a
 * tool telling the model not to build — alongside a prompt line asking for a
 * JSON blob and a `tool_choice: none` that forbade every call. Measured
 * live: the agent replied that its role stops at proposing and the tool was
 * not available to it. It was reading what we sent.
 *
 * The plan is already approved by then. Offering to propose it again is not
 * a capability, it is an invitation to go round once more.
 *
 * The record tools stay: a build turn still discovers things worth writing
 * down — a barrier the journey turned out to need, a question the build
 * raised — and losing those would quietly empty the record on the last turn
 * of the conversation.
 */
export const outputToolsForPhase = (isBuildTurn: boolean) =>
  isBuildTurn
    ? OUTPUT_TOOLS.filter((t) => t.name !== 'propose_strategy')
    : OUTPUT_TOOLS.filter((t) => t.name !== 'build_campaign');

// So the activity timeline shows "Recording what you told me about customers"
// rather than "Running record_findings".
registerToolTitles(OUTPUT_TOOLS);

export const isOutputTool = (name: string): boolean => OUTPUT_TOOL_NAMES.includes(name);

/**
 * What kind of work a tool call is, stamped onto every tool event.
 *
 * The client cannot work this out for itself and was guessing badly: the
 * activity summary counted every `model.tool_call*` event as a "lookup", so
 * the PIN-activation discovery turn reported six lookups having looked
 * nothing up — `ask_questions`, `record_findings` and `record_dimensions` all
 * WRITE, and discovery has no lookup tools at all.
 *
 * Stage is not a substitute: `requested` and `started` are emitted as
 * 'understanding' whatever the tool, so counting on stage replaces one wrong
 * number with another.
 */
export type ToolKind = 'lookup' | 'output';
export const toolKind = (name: string): ToolKind => (isOutputTool(name) ? 'output' : 'lookup');

export interface ApplyResult {
  brief: WorkingBrief;
  /**
   * Returned to the MODEL as the tool result when a call cannot be applied.
   *
   * Always says what to do differently, never just what was wrong. This is the
   * clearability rule from gate.ts applied one level down: a rejection the
   * model cannot act on produces the same loop as a refusal the user cannot
   * act on.
   */
  error?: string;
  /** Said back to the model on success, so it knows the record moved. */
  ok?: string;
  /** The plan, when this call was `propose_strategy`. */
  strategy?: Strategy;
  /** The journey to build, when this call was `build_campaign`. */
  blueprint?: CampaignBlueprint;
  /** Decisions the proposal leaves open, travelling with the plan that raised them. */
  openItems?: unknown[];
  /** Aggregated data the agent asked for. */
  evidence?: unknown[];
}

/**
 * Apply one tool call to the record.
 *
 * Each call is independent. A malformed `record_dimensions` no longer discards
 * a perfectly good `record_findings` from the same turn, which is what made a
 * single bad field cost a whole round.
 *
 * Reuses the existing recorders rather than reimplementing them:
 * `recordBarriers` already verifies quotes against what the user typed and
 * downgrades unverifiable attributions, and `recordDimensions` already
 * normalises an assumption to `deferred`. Those rules were each measured into
 * place and are not re-litigated here.
 */
/**
 * A list, whatever the model actually sent.
 *
 * `?? []` ONLY REPLACES null AND undefined, which is the hole that crashed a
 * live OS-to-EMI turn: the model sent `barriers` as a STRING, `barriers ?? []`
 * kept the string, `.length` worked, and `.some(...)` did not exist. The
 * TypeError escaped as the assistant's message. Same class as the Confirm
 * crash an hour earlier — a type annotation read as a guarantee about data
 * arriving from outside the program.
 *
 * `record_dimensions` three cases below already used `Array.isArray`. This
 * one did not, and the difference was invisible until a model chose the other
 * shape.
 *
 * ONE OBJECT BECOMES A LIST OF ONE. That is a near-miss worth accepting: the
 * model found a single barrier and sent it, rather than a list containing it.
 *
 * ANYTHING ELSE BECOMES EMPTY — never iterated. A string would otherwise
 * yield one "barrier" per character, which is worse than the crash: it would
 * have been recorded.
 */
const asList = <T>(value: unknown): T[] => {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === 'object') return [value as T];
  return [];
};

/** Was something sent at all, as opposed to omitted? */
const wasSent = (value: unknown): boolean => value !== undefined && value !== null;

export function applyOutputTool(brief: WorkingBrief, name: string, input: unknown): ApplyResult {
  const obj = (input ?? {}) as Record<string, unknown>;

  switch (name) {
    case 'ask_questions': {
      const questions = Array.isArray(obj.questions) ? (obj.questions as AskQuestionsInput['questions']) : [];
      const usable = questions.filter((q) => typeof q?.text === 'string' && q.text.trim().length > 0);
      if (usable.length === 0) {
        return {
          brief,
          error:
            'No usable question in that call. Send at least one with a non-empty "text", written in plain language.',
        };
      }
      return {
        brief: recordAsked(brief, usable, 'agent' satisfies AskAuthor),
        // NOT "the manager will see them", which is what it used to say.
        //
        // A tool result is the last thing the model reads before it writes to
        // the user, so its wording is the register the reply comes back in.
        // This one put the manager in the third person and the model repeated
        // it: the PIN-activation run opened with "I've sent these two
        // questions to the campaign manager" — written TO the manager, ABOUT
        // the manager. The prompt forbids that in words; this is what was
        // teaching it.
        //
        // Says what happened and nothing about who sees it, so there is no
        // third person to copy.
        ok: `${usable.length} question(s) recorded. Now write your message, asking them directly.`,
      };
    }

    case 'record_findings': {
      let next = brief;
      const notes: string[] = [];
      // COERCED, NOT CAST. Every list here goes through `asList`, and
      // `converters` has to be an object before anything reads `.shape` off
      // it — a string there throws just as readily as the one in `barriers`
      // did.
      const rawConverters = obj.converters;
      const converters =
        rawConverters && typeof rawConverters === 'object' && !Array.isArray(rawConverters)
          ? ({
              ...(rawConverters as Converters),
              // The same hole one level down: `recordConverters` does
              // `(c.candidates ?? []).filter(...)`.
              candidates: asList<NonNullable<Converters['candidates']>[number]>(
                (rawConverters as Converters).candidates,
              ),
            } as Converters)
          : undefined;
      const barriers = asList<Barrier>(obj.barriers);

      // A WRONG SHAPE IS A TOOL ERROR, NOT A CRASH, and it is reported
      // separately from "you sent nothing" so the model can tell the two
      // apart and fix the right thing.
      if (wasSent(obj.barriers) && !barriers.length && !Array.isArray(obj.barriers)) {
        return {
          brief,
          error:
            '"barriers" must be a list of objects, each with an "id", a "statement", a "basis" and a "lever". Send it again as a list — a bare string cannot be recorded as a barrier.',
        };
      }
      if (wasSent(obj.converters) && !converters) {
        return {
          brief,
          error:
            '"converters" must be an object with "shape", "basis" and "knowledge". Send it again in that form.',
        };
      }
      if (!converters && !barriers.length) {
        return {
          brief,
          error:
            'That call recorded nothing. Send "converters", "barriers", or both — whichever the manager has actually told you about.',
        };
      }
      if (converters) {
        next = recordConverters(next, converters);
        notes.push('who converts');
      }
      if (barriers.length) {
        next = recordBarriers(next, barriers);
        const after = (next.barriers ?? []);
        // THE TOTAL ON THE RECORD, NOT THE DELTA.
        //
        // `after.length - before` reported "0 barrier(s)" every time the
        // model re-sent a barrier it had already recorded — which reads as
        // "nothing was saved" about a brief that holds one. In the live run
        // it printed that four times running while the agent was trying to
        // work out why its proposal kept being refused.
        notes.push(`${after.length} barrier(s) on the record`);
        // Attribution is verified, not trusted, and the model is told when a
        // quote did not check out. Silently downgrading taught it nothing.
        const downgraded = after.filter((b) => b.basis === 'assumption' && barriers.some((x) => x.id === b.id && x.basis !== 'assumption'));
        if (downgraded.length) {
          notes.push(
            `${downgraded.length} recorded as your own inference rather than theirs, because the quote did not match what they typed — design against it, but say it is untested`,
          );
        }
      }
      return { brief: next, ok: `Recorded ${notes.join('; ')}.` };
    }

    case 'record_dimensions': {
      const dims = Array.isArray(obj.dimensions) ? (obj.dimensions as DimensionUpdate[]) : [];
      const usable = dims.filter((d) => typeof d?.name === 'string' && d.name.trim().length > 0);
      if (usable.length === 0) {
        return { brief, error: 'No usable dimension in that call. Each one needs a non-empty "name".' };
      }
      let next = recordDimensions(brief, usable);
      const notes = [`${usable.length} line(s) of enquiry`];
      // Same hole as `barriers`: a string here has `.length` and is then
      // iterated by `recordContextChecked`.
      const checked = asList<{ source: string; found: boolean }>(obj.contextChecked);
      if (checked.length) {
        next = recordContextChecked(next, checked);
        notes.push(`${checked.length} source(s) consulted`);
      }
      const resolutions = asList<QuestionResolution>(obj.questionResolutions);
      if (resolutions.length) {
        next = recordQuestionResolutions(next, resolutions);
        notes.push(`${resolutions.length} question decision(s)`);
      }
      return { brief: next, ok: `Recorded ${notes.join(', ')}.` };
    }

    case 'request_evidence': {
      const evidence = Array.isArray(obj.evidence) ? obj.evidence : [];
      if (evidence.length === 0) {
        return { brief, error: 'No request in that call. Each one needs a "question", the "fields" you want and what it "wouldInform".' };
      }
      return { brief, evidence, ok: `Asked for ${evidence.length} piece(s) of data.` };
    }

    case 'propose_strategy': {
      const strategy = obj as unknown as Strategy;
      if (!strategy.summary?.trim()) {
        return { brief, error: 'A proposal needs a "summary" saying what the campaign is, in the manager\'s own terms.' };
      }
      // TWO candidates, and they must attack DIFFERENT barriers.
      //
      // This is the strategy weakness measured on the activation run: both
      // "architectures considered" segmented or branched differently while
      // sharing one theory of the problem ("they are not being nudged"). Two
      // mechanics for one barrier is one architecture described twice, and the
      // double-down-versus-expand comparison collapses.
      //
      // Checked structurally on the model's OWN declaration, the same shape as
      // the experiment-arms check: the application cannot judge whether two
      // barriers are meaningfully different, but it can insist they are not
      // the same string.
      // `.map` below, so a string reaches it the same way `.some` did.
      const arch = asList<NonNullable<Strategy['architectures']>[number]>(strategy.architectures);
      if (arch.length < 2) {
        return {
          brief,
          error: 'Send at least two candidate architectures. If you cannot find a second, look for the factor the first one cannot carry — that is usually where it is.',
        };
      }
      // CITED BY ID, NOT BY PROSE, and this is the second attempt at it.
      //
      // The first version compared the barrier STRINGS for distinctness. A
      // live run defeated it three times out of three by appending a
      // qualifier: the chosen candidate cited "no-nudge-awareness" and the
      // rival cited "no-nudge-awareness, compounded by delivery timing for
      // courier-issued cards". Two different strings, one customer problem,
      // check passed. Comparing free text was always going to be defeatable
      // by writing more text.
      //
      // An id from the findings record is a CLOSED set the model cannot extend
      // mid-sentence, and it is the same mechanism sends already use to cite
      // the barrier they attack.
      const known = new Map((brief.barriers ?? []).map((b) => [b.id.trim().toLowerCase(), b]));
      const cited = arch.map((a) => (a.barrier ?? '').trim().toLowerCase());
      const unknown = cited.filter((c) => !known.has(c));
      if (unknown.length) {
        return {
          brief,
          error: `Cite the barrier by its recorded id. ${
            known.size
              ? `You have recorded: ${[...known.keys()].join(', ')}. Use one of those, or record a new barrier first with record_findings.`
              : 'You have not recorded any barrier yet. Call record_findings first — a strategy cannot attack a problem that is not in the record.'
          }`,
        };
      }
      // TWO CANDIDATES MAY SHARE A BARRIER. WHAT THEY MAY NOT SHARE IS THE
      // TREATMENT.
      //
      // THE DEFECT THIS REPLACES, measured end to end in
      // `eval/runs/ui-s-1792735473522/turns/turn-3.json`. The manager had
      // given one clear reason — customers do not realise the purchase
      // qualifies — and the agent wrote a real plan around it. This refused
      // the plan for citing one recorded barrier twice and told it to
      // "record a second candidate explanation" with basis "assumption".
      //
      // It obeyed, and the consequences ran all the way to the screen: the
      // follow-up `record_findings` sent only the invented rival, which
      // REPLACED the list and deleted the manager's own barrier; the turn
      // never proposed again; and the manager read "Recorded."
      //
      // The demand was wrong on its own terms. One recorded barrier is the
      // ordinary case when someone answers clearly, and inventing a second
      // why to satisfy a counter is not discovery — it is the application
      // asking the agent to make something up, which every other rule here
      // exists to prevent.
      //
      // WHAT A RIVAL ACTUALLY IS when there is one problem: a different
      // treatment OF that problem — a different moment to catch them, a
      // different intensity, a different journey shape. That is precisely the
      // tuple `architectureAudit` already compares, so the check now asks the
      // same question the audit does instead of a cheaper proxy for it.
      const sameBarrier = new Set(cited).size < 2;
      const treatment = (a: NonNullable<Strategy['architectures']>[number]) =>
        [a.entry, a.timing, a.lever, a.journey]
          .map((x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim())
          .join(' || ');
      const sameTreatment = new Set(arch.map(treatment)).size < 2;
      if (sameBarrier && sameTreatment) {
        return {
          brief,
          error:
            known.size < 2
              ? 'These two candidates attack the same barrier in the same way — same entry, timing, lever and journey — so they are one architecture described twice. With one barrier recorded that is expected and fine: make the rival a different TREATMENT of it. Catch them at a different moment, work it harder or lighter, or change the journey shape. Do not invent a second reason customers do not convert.'
              : `Both candidates cite the same barrier AND the same entry, timing, lever and journey, so they are one architecture described twice. Either point the second at one of your other recorded barriers (${known.size} are on the record), or give it a genuinely different treatment of this one.`,
        };
      }
      const openItems = Array.isArray(obj.openItems) ? (obj.openItems as unknown[]) : [];
      // ONE SHAPE FROM HERE ON, because this schema and the `Architecture`
      // type were written at different times and do not agree.
      //
      // The schema asks for `audience`, `tradeOff` and `why`. Everything
      // downstream reads `entry`, `tradeoff` and `whyChosen`. Nothing
      // complained, because a missing field is not an error — it just reads
      // as undefined. Measured on the PIN-activation run: the model wrote
      // "All new cardholders issued a card and not yet PIN-set, randomly
      // split into a how-to arm, a reason-to-use arm and a small no-message
      // holdout", and the manager was shown "Who it reaches: undefined".
      //
      // It also quietly blunted a check. `architectureAudit` decides whether
      // two candidates are really different from `[entry, timing, journey]`,
      // and `entry` was blank on every candidate ever proposed — so two plans
      // differing only in who they reach would have been called one plan
      // described twice.
      //
      // Normalised here rather than in the renderer: there is one boundary
      // where model output becomes application state, and a second alias in
      // each reader is how this drifts again.
      const normalised: Strategy = {
        ...strategy,
        architectures: strategy.architectures?.map((a) => {
          const raw = a as typeof a & { audience?: string; tradeOff?: string; why?: string };
          return {
            ...a,
            entry: a.entry ?? raw.audience,
            tradeoff: a.tradeoff ?? raw.tradeOff,
            whyChosen: a.whyChosen ?? raw.why,
          };
        }),
      };
      return { brief, strategy: normalised, openItems, ok: 'Plan recorded. The manager approves it before anything is built.' };
    }

    case 'build_campaign': {
      const blueprint = obj as unknown as CampaignBlueprint;
      if (!blueprint.campaignName?.trim()) {
        return { brief, error: 'The journey needs a "campaignName".' };
      }
      if (!Array.isArray(blueprint.steps) || blueprint.steps.length === 0) {
        return { brief, error: 'The journey has no steps. Send at least one, or say in text what is stopping you building this.' };
      }
      if (!blueprint.entry?.kind) {
        return { brief, error: 'The journey needs an "entry" with a "kind" of either "event" or "audience".' };
      }
      return { brief, blueprint, ok: `Journey received: ${blueprint.steps.length} step(s). Validating.` };
    }

    default:
      return { brief, error: `There is no tool called "${name}".` };
  }
}
