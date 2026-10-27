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
  reopen,
  type AskAuthor,
} from './record';
import {
  recordConverters,
  recordBarriers,
  recordDimensions,
  recordSuccessCriteria,
  recordContextChecked,
  recordQuestionResolutions,
  type WorkingBrief,
  type DimensionUpdate,
  type QuestionImpact,
  type QuestionContingency,
  type QuestionResolution,
} from './discovery';
import type { Converters, Barrier } from './findings';
import { buildFromBlueprint, type CampaignBlueprint } from './blueprint';
import { sendSteps } from './pathReading';
import type { Strategy } from './orchestrator';
import { registerToolTitles, type ToolDef } from './agentTools';
import { decide, namedOutcomes, type TurnPhase } from './gate';
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

const STRING_LIST = { type: 'array', items: { type: 'string' } } as const;

/**
 * The journey itself, as JSON Schema.
 *
 * HOISTED SO TWO TOOLS SHARE ONE GRAMMAR, 2026-10-23. `propose_strategy` now
 * carries the path it is asking the manager to approve, and the alternative
 * was a second copy of this object — which is how the architecture fields and
 * the two event-label maps drifted. One definition, referenced twice.
 */
const BLUEPRINT_SCHEMA = {
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


/**
 * Fill a regression in THIS proposal from the last one the tool accepted.
 *
 * MEASURED, `eval/runs/ui-s-1792770967470` turns 5 to 7. A plan arrived with
 * seven named paths and real per-case fallbacks and was refused for something
 * else; the next attempt came back with two paths and a generic "still
 * unconverted" on every row. The held turn had thrown the good column away,
 * so each attempt started from the model's memory of the last one rather than
 * from the last one.
 *
 * THREE REPAIRS, AND THEY ARE ALL RESTORATIONS. Nothing here invents a field
 * the model has never sent: every value copied came out of a payload this
 * tool accepted earlier in the same conversation.
 *
 *  1. No steps at all → the stashed path. A first propose with no journey is
 *     still refused, because there is nothing stashed to fill from.
 *  2. Fewer than two landed cases named, when the stash named two or more →
 *     the stashed `ifStillUnconverted` for the row that matches by path, or
 *     by channel when the path was renamed.
 *  3. Paths exploded into engagement arms — "{who} — unread arm" — when the
 *     stash had the who-split alone. Unread and read are what the JOURNEY
 *     forks on; they are not two more audiences, and splitting them here
 *     makes every path one send deep.
 *
 * WHAT IT WILL NOT DO: merge a linear clock over a stashed outcome fork. If
 * this payload's journey does not react and the stashed one did, the stash is
 * left alone and `reactionBlocks` holds the turn — repairing that silently
 * would hand back an approval for a journey the model did not send.
 */
export function fillFromLastProposal(
  incoming: Strategy,
  blueprint: CampaignBlueprint | null,
  stash: { strategy: unknown; blueprint: unknown } | undefined,
): { strategy: Strategy; blueprint: CampaignBlueprint | null; repaired: string[] } {
  const prev = stash?.strategy as Strategy | undefined;
  const prevBp = stash?.blueprint as CampaignBlueprint | undefined;
  if (!prev && !prevBp) return { strategy: incoming, blueprint, repaired: [] };
  const repaired: string[] = [];
  let strategy = incoming;
  let path = blueprint;

  // 1. the journey itself
  if ((!path || !Array.isArray(path.steps) || !path.steps.length) && prevBp?.steps?.length) {
    path = prevBp;
    // "the journey itself", not "the journey from the last plan you sent that
    // I accepted" — the sentence this list is spliced into already says where
    // it came from, and saying it twice is what the live turn-5 tool result
    // did: "I restored the journey, from the last plan you sent that I
    // accepted from the last plan you sent that I accepted".
    repaired.push('the journey itself');
  }

  const rows = Array.isArray(strategy.touches) ? [...strategy.touches] : [];
  const prevRows = Array.isArray(prev?.touches) ? prev!.touches : [];

  // 2. the landed cases
  if (rows.length && prevRows.length && namedOutcomes(rows).size < 2 && namedOutcomes(prevRows).size >= 2) {
    const byPath = new Map(prevRows.map((t) => [`${String(t.path ?? '').trim().toLowerCase()}@${t.day}`, t]));
    const byChannel = new Map(prevRows.map((t) => [`${String(t.channel ?? '').trim().toLowerCase()}@${t.day}`, t]));
    let filled = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const match =
        byPath.get(`${String(r.path ?? '').trim().toLowerCase()}@${r.day}`) ??
        byChannel.get(`${String(r.channel ?? '').trim().toLowerCase()}@${r.day}`);
      if (match?.ifStillUnconverted && String(match.ifStillUnconverted).trim() !== String(r.ifStillUnconverted ?? '').trim()) {
        rows[i] = { ...r, ifStillUnconverted: match.ifStillUnconverted };
        filled += 1;
      }
    }
    if (filled) repaired.push(`what happens to the people who got each message, on ${filled} send(s)`);
  }

  // 3. engagement arms masquerading as audiences
  // THE LIVE SUFFIXES, which the first version could not match: "High
  // ticket - delivered, not read" and "Standard ticket - both arms".
  // `[^,]*?` died on the comma, so nothing collapsed and the manager was
  // left clerking DELIVERED inside a path name. Anchored on the separator
  // after the WHO name; once the suffix starts with a landed case, the rest
  // of it may say anything.
  const ARM = /\s*[-—–:(]\s*(delivered|not delivered|unread|not read|read|opened|clicked|dismissed|deleted|both arms?|no action)\b.*$/i;
  const prevPaths = new Set(prevRows.map((t) => String(t.path ?? '').trim().toLowerCase()).filter(Boolean));
  if (rows.length && prevPaths.size && rows.some((r) => ARM.test(String(r.path ?? '')))) {
    let collapsed = 0;
    for (let i = 0; i < rows.length; i++) {
      const raw = String(rows[i].path ?? '');
      if (!ARM.test(raw)) continue;
      const base = raw.replace(ARM, '').trim();
      const restored = prevPaths.has(base.toLowerCase())
        ? base
        : prevRows.find((t) => t.day === rows[i].day && String(t.channel ?? '').toLowerCase() === String(rows[i].channel ?? '').toLowerCase())?.path;
      if (restored) {
        rows[i] = { ...rows[i], path: restored };
        collapsed += 1;
      }
    }
    if (collapsed) repaired.push(`${collapsed} path name(s) that had split an audience by what the message did`);
  }

  if (repaired.length) strategy = { ...strategy, touches: rows };
  return { strategy, blueprint: path, repaired };
}

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
              barrier: { type: 'string', description: 'The recorded id of the customer problem this one attacks — use an id from the findings record, not free prose. Two candidates MAY cite the same barrier: when only one is recorded that is the normal shape, and the rival is a different TREATMENT of it. They must then differ in entry, timing, lever or journey.' },
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
              ifStillUnconverted: {
                type: 'string',
                description:
                  'What happens next for the people who GOT this message and have not acted: still unread, read and no action taken, dismissed — plus opened or clicked only where that channel reports them (email and RCS do; WhatsApp and SMS do not). Undelivered is "fallbackChannel" on this send rather than one of these cases, and converting is not one either: the goal check already takes anyone who booked off the path.',
              },
            },
            required: ['day', 'channel', 'path', 'purpose', 'ifStillUnconverted'],
          },
        },
        blueprint: {
          ...BLUEPRINT_SCHEMA,
          description:
            'THE PATH YOU ARE ASKING THEM TO APPROVE. The same grammar build_campaign uses, and Confirm compiles exactly this — it does not design a second journey. Required: they are approving a sequence, so it has to exist. Keep your MESSAGE in their language; the steps live here.',
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
      // `$defs` HERE TOO, because `blueprint.steps` references `#/$defs/step`
      // and a `$ref` resolves against the schema it is sent in. Without it the
      // provider would reject the call with a schema error rather than a
      // usable message.
      $defs: { step: STEP_DEF },
    },
  },
  {
    name: 'build_campaign',
    title: 'Building the journey',
    description:
      'Build the approved plan as a journey. Only ever called AFTER the manager has approved a strategy. Emit no ids of any kind — the application owns every node id, edge id and template id, and builds the graph through the product\'s own reducer. If the plan cannot be expressed in this grammar, say so in text instead of building a lesser version: a campaign that silently dropped a requirement is worse than no campaign and a plain statement of what is in the way.',
    input_schema: {
      ...BLUEPRINT_SCHEMA,
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
      'Record who converts today, why the rest do not, and how they would judge success. Call this on EVERY turn where the manager has said anything about any of them — you cannot propose a strategy without the first two, and success is theirs to give, so file it the turn they say it. A barrier must carry the manager\'s own words in "quote"; the application checks the quote against what they actually typed and downgrades an unverifiable one to an assumption rather than rejecting it. "notCovered" is for the rare case where their reply genuinely did not touch a question you asked; leaving it empty is normal and correct.',
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
        successCriteria: {
          ...STRING_LIST,
          description:
            'How the business would judge this, in their own words, the moment they tell you. Never a target number — no performance history exists. Record it here rather than waiting for a proposal: they have told you, so it belongs on the record now.',
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
/**
 * THE TOOL DOES NOT EXIST ON A TURN THAT MAY NOT USE IT.
 *
 * `propose_strategy` used to travel on an asking turn with `blueprint` and
 * `$defs` stripped out, on the reasoning that the GATE should decide when a
 * proposal is allowed and a model that proposes early should be refused by the
 * record rather than left unable to speak. Measured twice, that reasoning cost
 * a conversation each time:
 *
 *  - `ui-s-1792834072700` turn 3: five identical refusals, then the plan
 *    dumped into the chat for the manager to approve by hand.
 *  - `ui-s-1792839251135` turn 3: a settled record held by a bookkeeping bug,
 *    a tool offered and refused, and the manager asked to type "go ahead".
 *
 * A tool on the list is an invitation. Offering one in order to refuse it
 * teaches the model that the plan is the move and the refusal is an obstacle,
 * and it took five attempts to stop trying. Findings are filed with
 * `record_findings` — which takes `successCriteria` as well as the two
 * customer findings — so nothing has to be smuggled through a plan.
 *
 * ASKING: ask, record, record, request evidence. READY: the two record tools
 * plus `propose_strategy` carrying its path. BUILD: `build_campaign` and the
 * two record tools — no proposing, because the plan is already approved, and
 * nothing that waits for an answer.
 */
export const outputToolsForPhase = (phase: TurnPhase) =>
  OUTPUT_TOOLS.filter((t) =>
    t.name === 'build_campaign'
      ? phase === 'build'
      : t.name === 'propose_strategy'
        ? phase === 'ready'
        : // `ask_questions` IS OFF A READY TURN, 2026-10-26.
          //
          // A question recorded through this tool is an OUTSTANDING question:
          // `recordAsked` leaves `addressedInRound` empty, `outstanding` reads
          // it, and `blocksFor` turns it into `awaiting-reply`. On a closed
          // record that flips the very next turn back to `asking` and strips
          // `propose_strategy` — the brief reopened by bookkeeping, from a
          // leftover thought the manager never needed to answer.
          //
          // The turn is not silenced. A point worth making about a plan goes
          // in `openItems` on `propose_strategy`, which `renderStrategy`
          // already prints under "Worth settling before this is built" — a
          // flag on the document rather than question 1 beside Confirm.
          //
          // ASKING KEEPS IT, because that is the whole of an asking turn.
          //
          // BUILD DOES NOT, SINCE 2026-10-26, AND THE REASON THIS COMMENT
          // USED TO GIVE WAS WRONG. It said "the record cannot be reopened by
          // it" on a build turn. It can. Measured on the closed live brief:
          // `decide` is `[]` and `turnPhase` is `ready`; after one
          // `recordAsked` the blocks are `['awaiting-reply']` and the phase is
          // `asking`. The bookkeeping does not care which turn wrote the
          // question — so a stray thought on the turn that BUILDS puts the
          // manager back in discovery on the turn after their campaign
          // appeared, which is the worst moment of the three to do it.
          //
          // A question the build genuinely raised still has somewhere to go:
          // `openItems` on the build payload, as an operational limitation,
          // which is printed rather than waited on. `record_findings` and
          // `record_dimensions` stay on Confirm — those write facts, not
          // obligations — and so do the lookups, to compile what was approved
          // rather than to design something new.
          // `request_evidence` GOES WITH IT, for the identical reason. It
          // writes a `pending` evidence request, and a pending request routes
          // the next turn through `resolveEvidence` as though the manager owed
          // us data — a form, on a record that is settled. Aggregated data
          // that would sharpen a decision is worth saying; it belongs in
          // `openItems` on the plan, which `renderStrategy` prints, not in a
          // slot that waits for an answer.
          !['ask_questions', 'request_evidence'].includes(t.name) || phase === 'asking',
  );

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

/** A list of non-empty strings, from a list or from one bare string. */
const asStringList = (value: unknown): string[] => {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  return asList<unknown>(value).map((x) => String(x ?? '').trim()).filter(Boolean);
};

/**
 * `converters` as an object, or nothing.
 *
 * Hoisted so `record_findings` and the asking-turn harvest cannot coerce it
 * two different ways. The nested `candidates` guard is the same hole one level
 * down: `recordConverters` does `(c.candidates ?? []).filter(...)`.
 */
const coerceConverters = (raw: unknown): Converters | undefined =>
  raw && typeof raw === 'object' && !Array.isArray(raw)
    ? ({
        ...(raw as Converters),
        candidates: asList<NonNullable<Converters['candidates']>[number]>((raw as Converters).candidates),
      } as Converters)
    : undefined;

/** Was something sent at all, as opposed to omitted? */
const wasSent = (value: unknown): boolean => value !== undefined && value !== null;

/**
 * NO PHASE ARGUMENT, because there is nothing left for it to decide.
 *
 * It took one, and before that it worked the answer out from the brief. Both
 * existed to serve a single branch: `propose_strategy` arriving on a turn that
 * may not propose. `outputToolsForPhase` no longer puts the tool on that
 * turn's list, so the branch — and the question — is gone. Every check below
 * is about the payload in front of it.
 *
 * A `propose_strategy` call on an asking turn is now impossible through the
 * API and a test bug anywhere else.
 */
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
      const converters = coerceConverters(obj.converters);
      const barriers = asList<Barrier>(obj.barriers);
      // SUCCESS IS RECORDABLE WITHOUT A PLAN, since 2026-10-24. It used to
      // live on `propose_strategy` alone, so the one thing a manager answers
      // first had to travel on the one tool an asking turn refuses.
      const success = asStringList(obj.successCriteria);

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
      // A SUCCESS-ONLY CALL RECORDS SOMETHING. Without this clause the tool
      // would take the field and then refuse the call for carrying nothing
      // else, which is the same shape of trap as the one above it.
      if (!converters && !barriers.length && !success.length) {
        return {
          brief,
          error:
            'That call recorded nothing. Send "converters", "barriers", "successCriteria", or any combination — whichever the manager has actually told you about.',
        };
      }
      if (success.length) {
        next = recordSuccessCriteria(next, success);
        notes.push('how they would judge this');
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
      // `notCovered` WAS DECLARED AND IGNORED. It is in this tool's schema and
      // in `RecordFindingsInput`, and nothing read it — so the one bounded way
      // to say "their reply did not touch that question" did nothing on the
      // production path. The reply closes questions at ingest now, which makes
      // this a re-open: `REOPEN_LIMIT` stops it becoming a way to keep a
      // manager answering the same thing for ever.
      const missed = asStringList(obj.notCovered);
      if (missed.length) {
        const before = next.questions.filter((q) => q.addressedInRound === undefined).length;
        next = reopen(next, missed);
        const after = next.questions.filter((q) => q.addressedInRound === undefined).length;
        if (after > before) notes.push(`${after - before} question(s) put back to them`);
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
      // THIS TURN MAY PROPOSE, because the tool is only on the list when it
      // may. The asking-turn branch that used to sit here — refuse the plan,
      // harvest its record fields, name a two-item "still open" list — is
      // gone with the stripped schema it was written for: a tool offered in
      // order to be refused is an invitation the model took five times in
      // `ui-s-1792834072700` and again in `ui-s-1792839251135`. Findings are
      // filed with `record_findings`, which takes `successCriteria` too.
      //
      // So every check below is about the PAYLOAD, and a refusal says what to
      // send instead — plus whatever the RECORD still holds, in the record's
      // own words.
      //
      // WHY `decide` AND NOT A LIST WRITTEN HERE. The branch this replaces
      // named two things it had decided were the likely ones: how success
      // would be judged, and the second-pattern probe. In
      // `ui-s-1792839251135` both were already done and the real block was
      // `awaiting-reply` — so the refusal told a manager who had answered
      // everything that the two things they had answered were outstanding,
      // and never mentioned the one thing that was. `decide(brief).blocks`
      // is the live answer, and `Block.reason` is already written in their
      // language.
      //
      // Usually empty, because `propose_strategy` is only on the list when
      // the gate says ready. It is NOT empty when the turn was forced there
      // — the round budget, Skip & propose, or a typed "go ahead" — and that
      // is exactly the turn where knowing what is still open matters.
      const refuse = (message: string): ApplyResult => {
        const open = decide(brief).blocks.map((b) => b.reason.trim()).filter(Boolean);
        return { brief, error: open.length ? `${message} Still on the record: ${open.join(' ')}` : message };
      };
      const strategy = obj as unknown as Strategy;
      if (!strategy.summary?.trim()) {
        return refuse('A proposal needs a "summary" saying what the campaign is, in the manager\'s own terms.');
      }
      // TWO candidates, and they must be tellable apart BY A CUSTOMER.
      //
      // The weakness measured on the activation run was real: both
      // "architectures considered" segmented or branched differently while
      // sharing one theory of the problem ("they are not being nudged"), and
      // the double-down-versus-expand comparison collapsed.
      //
      // The rule drawn from it — cite two DIFFERENT barriers — was too
      // strong, and 2026-10-23 shows what it cost: with one barrier recorded
      // it refused a good plan and told the agent to invent a second reason,
      // which then overwrote the manager's own. One recorded barrier is the
      // ordinary case when someone answers clearly. What two candidates must
      // not share is the TREATMENT — entry, timing, lever and journey, the
      // same tuple `architectureAudit` compares.
      //
      // Checked structurally on the model's OWN declaration, the same shape as
      // the experiment-arms check: the application cannot judge whether two
      // barriers are meaningfully different, but it can insist they are not
      // the same string.
      // `.map` below, so a string reaches it the same way `.some` did.
      // ALIASED BEFORE ANYTHING READS IT, moved up 2026-10-23.
      //
      // The schema asks for `audience`, `tradeOff` and `why`; everything
      // downstream reads `entry`, `tradeoff` and `whyChosen`. That
      // reconciliation used to happen at the END of this case, after the
      // checks — so the treatment comparison added the same day read
      // `a.entry` on a payload that carries `audience`, found undefined on
      // both candidates, and called two plans that differ only in WHO THEY
      // REACH one architecture described twice.
      //
      // That is the precise failure the comment below was already warning
      // about for `architectureAudit`, reintroduced one check earlier. One
      // boundary, and it has to come first.
      const asRejected = (value: unknown): NonNullable<Strategy['rejected']> => {
        if (typeof value === 'string' && value.trim()) return [{ option: value.trim(), why: '' }];
        return asList<{ option?: string; why?: string } | string>(value)
          .map((r) =>
            typeof r === 'string'
              ? { option: r, why: '' }
              : { option: String(r.option ?? '').trim(), why: String(r.why ?? '').trim() },
          )
          .filter((r) => r.option);
      };
      // ONE COERCION, SHARED WITH THE RECORD HARVEST ABOVE. This was a local
      // copy of `asStringList`, which meant `successCriteria` could be read
      // one way when a plan was accepted and another way when it was refused.
      const asStrings = asStringList;
      const normalised: Strategy = {
        ...strategy,
        approach: asStrings(strategy.approach),
        assumptions: asStrings(strategy.assumptions),
        unknowns: asStrings(strategy.unknowns),
        hypotheses: asStrings(strategy.hypotheses),
        successCriteria: asStrings(strategy.successCriteria),
        measurement: asStrings(strategy.measurement),
        rejected: asRejected(strategy.rejected),
        architectures: asList<NonNullable<Strategy['architectures']>[number]>(strategy.architectures).map((a) => {
          const raw = a as typeof a & { audience?: string; tradeOff?: string; why?: string };
          return {
            ...a,
            entry: a.entry ?? raw.audience,
            tradeoff: a.tradeoff ?? raw.tradeOff,
            whyChosen: a.whyChosen ?? raw.why,
          };
        }),
      };
      const arch = asList<NonNullable<Strategy['architectures']>[number]>(normalised.architectures);
      if (arch.length < 2) {
        return refuse(
          'Send at least two candidate architectures. If you cannot find a second, look for the factor the first one cannot carry — that is usually where it is.',
        );
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
        return refuse(
          `Cite the barrier by its recorded id. ${
            known.size
              ? `You have recorded: ${[...known.keys()].join(', ')}. Use one of those, or record a new barrier first with record_findings.`
              : 'You have not recorded any barrier yet. Call record_findings first — a strategy cannot attack a problem that is not in the record.'
          }`,
        );
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
        return refuse(
          known.size < 2
              ? 'These two candidates attack the same barrier in the same way — same entry, timing, lever and journey — so they are one architecture described twice. With one barrier recorded that is expected and fine: make the rival a different TREATMENT of it. Catch them at a different moment, work it harder or lighter, or change the journey shape. Do not invent a second reason customers do not convert.'
              : `Both candidates cite the same barrier AND the same entry, timing, lever and journey, so they are one architecture described twice. Either point the second at one of your other recorded barriers (${known.size} are on the record), or give it a genuinely different treatment of this one.`,
        );
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
      // Normalised ABOVE rather than here or in the renderer: there is one
      // boundary where model output becomes application state, and a second
      // alias in each reader is how this drifts again.
      // THE PLAN MUST CARRY ITS PATH.
      //
      // MEASURED, `ui-s-1792748248345` turn 4: this tool returned prose, the
      // response carried `blueprint: false`, and Confirm appeared under an
      // essay. The canvas was then invented on the turn AFTER they agreed, so
      // what they approved and what they got were two different model outputs.
      //
      // Refused here rather than in the gate because the message can say what
      // to send, and because it applies to every winner — a linear plan needs
      // its sequence approved just as much as a reactive one.
      // REPAIR BEFORE REFUSING. A held turn kept the record but the model
      // re-sends from memory, so a column that passed last time can arrive
      // worse this time. Anything restored here came out of a payload this
      // tool already accepted.
      const sent = (obj as { blueprint?: CampaignBlueprint }).blueprint ?? null;
      const mend = fillFromLastProposal(normalised, sent, brief.lastProposal);
      const path = mend.blueprint;
      // SIX SENTENCES ARE NOT SIX STEPS. Measured, `ui-s-1792829868203` turn
      // 3: this accepted a "6-step path" whose steps were prose captions,
      // because the check below asked only whether the array was non-empty.
      // `buildFromBlueprint` would have hit `Unknown step kind "undefined"`
      // on every one of them. Same family as the empty-steps refusal, so it
      // says the same kind of thing: what to send instead.
      const shaped =
        Array.isArray(path?.steps) &&
        path.steps.every((x) => x && typeof x === 'object' && typeof (x as { kind?: unknown }).kind === 'string');
      const plan = mend.strategy;
      // THE READY-TURN EXIT. The turn may carry a path, so a plan without one
      // is a payload mistake and the message says what to send. The asking
      // turn is handled at the top of this case and never reaches here.
      if (!path || !Array.isArray(path.steps) || !path.steps.length || !shaped) {
        return refuse(
            (Array.isArray(path?.steps) && path.steps.length && !shaped
              ? 'The "blueprint" steps are sentences, not steps. Each one has to be an object with a "kind" — send, wait, waitForEvent, branch, condition, experiment, exit — because the journey is COMPILED from them rather than read. Send the SAME plan again with the path written in that grammar. '
              : '') +
            'This proposal has no journey in it. Send the SAME plan again with "blueprint" filled in — the path you are asking them to approve, in the same grammar build_campaign uses: entry, then the steps in order. They are agreeing to a sequence, so it has to exist before they agree. Confirm compiles exactly this one; you will not be asked to design it again.',
        );
      }
      // WHAT THE PATH ACTUALLY COMPILES TO, BEFORE IT IS STASHED.
      //
      // MEASURED, `eval/runs/ui-s-1793009889177`. Turn 4 filed a shaped path —
      // one Transaction Amount branch with six sends on its arms — and turn 5
      // compiled it into an entry, the split and three exits. Zero message
      // steps. The manager approved a journey that could not become one, and
      // the plan was already on the record by then.
      //
      // `assessGraphReadiness` dry-runs the same compiler later and did not
      // stop it, because it runs AFTER this stash. So the check belongs here:
      // a path whose steps are legal grammar but produce no send is refused,
      // and `lastProposal` is not written. Nothing else can repair it — Confirm
      // compiles exactly what is filed.
      //
      // THE ISSUER IS NOT VISIBLE HERE, so this uses the channel-array form of
      // `buildFromBlueprint`, the same one the unit tests use. It asks one
      // question — does this produce a message — and a channel this bank does
      // not have is reported elsewhere.
      const dry = (() => {
        try {
          return buildFromBlueprint(path, ['WHATSAPP', 'SMS', 'EMAIL', 'RCS']);
        } catch {
          // A compiler crash is not this check's business: the build path has
          // its own guard, and refusing here on a throw would hide it.
          return null;
        }
      })();
      // EVERY SEND THEY WROTE IS ON THE CANVAS, OR NOTHING IS FILED.
      //
      // TWO MISTAKES, AND THE CORRECTION HAS TO NAME THE RIGHT ONE. MEASURED,
      // `eval/runs/ui-s-1793017853714` turn 3: both forced attempts came back
      // with the waits-only refusal and neither fixed anything, because it
      // told a model that HAD written sends to write the sends into the path.
      // It had. They were not attached: a send placed after a fork has several
      // arms it could continue from, so the compiler reports the ambiguity and
      // drops the step rather than guessing one.
      //
      // AND COUNTED, NOT MERELY DETECTED. This used to fire only when the
      // graph had ZERO sends, so the mixed case walked straight through:
      // `eval/runs/ui-s-1793009889177` filed a path with six sends, five of
      // them on the arms and one sibling after a nested fork. That compiles to
      // five, which is more than none, so it was stashed and Confirm built a
      // campaign missing a message the manager had approved. Naming the skip
      // in the build report is not the same as refusing the plan: by then it
      // is already on the record.
      const sendKinds = sendSteps(path.steps as unknown[]);
      const builtSends = dry
        ? Object.values(dry.graph.nodes).filter((n) => (n as { type?: string }).type === 'SEND').length
        : sendKinds;
      if (dry && builtSends < sendKinds) {
        // QUOTE WHAT THE COMPILER SAID, rather than guessing the cause.
        //
        // The sentence named one reason — a send placed after a fork — and
        // `eval/runs/ui-s-1793077922155` turn 3 was refused with it twice over
        // sends that were already on the arms. The real reason was in
        // `dry.issues` all along: the fork had been read as a delivery branch
        // and needed a preceding send.
        //
        // CAPPED AT THREE AND DEDUPED. A dozen pasted issues is how twelve
        // empty-field reports once blocked an export, and the first ones are
        // the ones that caused the rest.
        const why = [...new Set((dry.issues ?? []).map((x) => x.problem.trim()).filter(Boolean))].slice(0, 3);
        return refuse(
          `This path has ${sendKinds} message${sendKinds === 1 ? '' : 's'} in it and ${builtSends === 0 ? 'none of them' : `only ${builtSends}`} reached the journey. ` +
            (why.length
              ? // THE COMPILER'S OWN WORDS, AND NOTHING APPENDED.
                //
                // This used to end "with every send nested inside the arm it
                // belongs to". MEASURED on
                // `eval/runs/ui-s-1793080526410` turn 3: the sends WERE nested
                // on the arms, and the compiler had dropped the fork because
                // the attribute was called `Amount`. The appended sentence
                // told the model to fix the one thing that was already right,
                // twice, and it is a guess in every case where the issues say
                // something else.
                //
                // The compiler still names the nesting itself when a send
                // really did come after a fork, so that instruction arrives
                // through `why` on the turns where it is true.
                `The compiler said: ${why.join(' ')} Fix what it names and send the SAME plan again.`
              : 'A send placed AFTER a fork has more than one arm it could continue from, so it is reported and dropped rather than attached to whichever arm came first. Send the SAME plan again with every send nested inside the arm it belongs to — in that arm\'s own "steps", not after the branch — and give each arm its own last message rather than one shared afterwards.'),
        );
      }
      if (dry && sendKinds === 0) {
        return refuse(
          'This path compiles to no messages. The steps are in the right grammar, but nothing in them produces a send — a journey of waits and exits reaches nobody, and Confirm compiles exactly this path, so there would be nothing on the canvas to approve. Send the SAME plan again with the sends written into the path, each one on the arm it belongs to.',
        );
      }
      // WHAT THE CANVAS WILL SAY, NOT WHAT THE JSON SAYS.
      //
      // THE LEFTOVER FROM THE RESOLUTION SLICE, and it is a reporting defect
      // rather than a compile one. The Plan preview draws the filed JSON —
      // `Purchase Posted`, `Amount` — because `src/designer/preview.ts` cannot
      // import the compiler. The RESOLVED graph only appears once Confirm
      // compiles. So the compiler's direction ("not a real event", "starts
      // from every eligible customer", the known-events list) sat on
      // `dry.issues`, which nobody reads at propose time, while the tool
      // result said "Plan recorded." and the manager approved a picture that
      // was not yet the canvas.
      //
      // Both substitutions travel as open items, which `renderStrategy`
      // already prints in the bubble, so they are in front of the manager on
      // the turn with the decision in it.
      //
      //  - a stand-in entry is `optional-preference` → "Defaults applied",
      //    because that is literally what it is: the application chose, and
      //    naming the real trigger overrides it. THIS IS THE WAY TO PROVIDE
      //    THE EVENT — the item asks for it.
      //  - a resolved name is the same kind for the same reason. The canvas
      //    will read `Transaction Amount`; they wrote `Amount`; they get to
      //    see that before they agree to it.
      //
      // Taken from the `substituted` tag rather than from the wording, so this
      // cannot drift from compiler copy the way four nest pins did.
      const substitutions = (dry?.issues ?? []).filter((i) => i.substituted);
      const standIn = substitutions.some((i) => i.substituted === 'entry-stand-in');
      const openItemsWithSubs = [
        ...openItems,
        // `question` and `ifUnanswered` ARE THE FIELDS `renderStrategy` READS.
        // My first version called the second one `default`, which that
        // function never looks at — so the line would have been dropped on the
        // floor and the test would have passed on the `question` alone.
        // `optional-preference` is the one kind it prints with "Until then:".
        ...substitutions.map((i) => ({
          kind: 'optional-preference',
          question: i.problem,
          ifUnanswered:
            i.substituted === 'entry-stand-in'
              ? 'the journey starts from every eligible customer. Name the real trigger to change it.'
              : 'the canvas uses the real field name. Say so if that is the wrong one.',
        })),
      ];
      // STASHED ON THE RECORD, so the next attempt starts from this rather
      // than from the model's memory of it. Only a plan that passed every
      // check above is stashed, and only ever read to fill a regression.
      //
      // The path is stashed AS WRITTEN. Confirm compiles this same object and
      // resolves again, which is what keeps one reading of it.
      const stashed: WorkingBrief = {
        ...brief,
        lastProposal: { strategy: plan, blueprint: path, round: brief.rounds },
      };
      return {
        brief: stashed,
        strategy: plan,
        openItems: openItemsWithSubs,
        blueprint: path,
        ok: [
          `Plan recorded, with a ${path.steps.length}-step path. The manager approves it before anything is built.`,
          // SAID TO THE MODEL TOO, because the bubble is the model's to write
          // and "Plan recorded." taught it there was nothing to mention.
          substitutions.length
            ? `Tell them what the canvas will actually say, in your message: ${substitutions
                .map((i) => i.problem)
                .join(' ')}${standIn ? ' Ask them for the real trigger, or to confirm the default audience.' : ''}`
            : '',
          mend.repaired.length
            ? `I restored ${mend.repaired.join('; ')} from the last plan you sent that I accepted — it was better there, and a refusal on one point is not a reason to start the rest again.`
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      };
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
