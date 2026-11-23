// The toolkit. Every tool is offered on every round and none is refused
// because of where the conversation is. The prompt says which tool usually
// fits when; the agent decides. The two warehouse tools exist only for a
// tenant that has a warehouse: that is a capability the tenant lacks, not a
// stage gate.

import { AGENT_TOOLS, runTool, type ToolDef } from '../agentTools';
import { CONDITION, STEP_DEF } from './journeySchema';
import { buildFromBlueprint } from '../blueprint';
import { buildCampaignProposal } from '../../agent-proto/campaignFields';
import { validateCampaignGraph } from '../../agent-proto/validate';
import { bankContext } from '../knowledge';
import type { TenantConfig } from '../tenants';
import type { Channel } from '../../src/data/sharedConstants';
import { countCustomers, runWarehouseQuery, warehouseSchema } from '../warehouse';
import { citationProblems, nextQid } from './citations';
import { checkJourneys, endingGaps, linkProblemsIn, planToBlueprint } from './compile';
import { forAgent, type BankLink } from '../links';
import { signalsFor, signalsForAgent } from '../signals';
import { incentiveForAgent, incentivesFor, qualifyingShare, validFor } from '../incentives';
import { todayIST } from './schedule';
import { costLine, offerProblems } from './offerChecks';
import { autoSizeBuckets } from './autoSize';
import { bucketContext } from '../../src/designer/v2/contextView';
import {
  addQuestions,
  editJourney,
  isAgentFlag,
  log,
  MAX_QUESTIONS_PER_CALL,
  outline,
  addContext,
  removeBucket,
  setFlag,
  updateCampaign,
  upsertBucket,
} from './state';
import { AGENT_FLAGS, type AgentQuestion, type AgentState } from './types';
import type { BpStep } from '../blueprint';
import { stripJourneyIds } from './stepIds';
import { contextKey, currentEntries, entryHistory } from '../../src/designer/v2/contextView';

const STEPS = { type: 'array', items: { $ref: '#/$defs/step' } } as const;
const GROUP = {
  type: 'object',
  properties: {
    entity: { type: 'string', description: 'Customer, Account, Card, Transaction or Milestone (see list_audience_attributes), or Signal: conditions on named signals from list_signals (attribute = the signal key).' },
    conditions: { type: 'array', items: CONDITION },
    lookbackDays: { type: 'number', description: 'Transaction only.' },
    existence: { type: 'string', enum: ['exists', 'none'], description: 'Transaction only. "none" = NO matching transaction in the lookback window.' },
  },
  required: ['entity'],
} as const;

const BASE_TOOLS: ToolDef[] = [
  {
    name: 'ask_questions',
    title: 'Putting questions to you',
    description:
      'Ask the manager questions. They appear as a form, grouped by aspect, with tappable answers. Each question asks ONE thing in one short sentence (no examples inside the question: put them in options). Every question gets tappable answers and a why (what its answer changes in the campaign); the form always adds "Other" for a custom answer, so never write "Other". answerType: "single" when one answer applies, "multi" when several can, "yesno" only when Yes and No each mean one clear thing (never for an A-or-B question; no options needed). For single/multi give 1-4 short options in the manager\'s voice; one option means "this is what I propose". After calling this, file anything outstanding, write one or two sentences and end your turn.',
    input_schema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          maxItems: MAX_QUESTIONS_PER_CALL,
          items: {
            type: 'object',
            properties: {
              aspect: { type: 'string', description: 'Short label of the campaign aspect, 1-3 words, e.g. "Goal", "Success", "Incentive", "Timing", "Buckets".' },
              text: { type: 'string', description: 'One short question, one thing.' },
              why: { type: 'string', description: 'One short sentence: what the answer changes in the campaign. Shown to the manager under the question.' },
              answerType: { type: 'string', enum: ['yesno', 'single', 'multi'] },
              options: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'single/multi only: 1-4 answers. Leave out for yesno.' },
            },
            required: ['aspect', 'text', 'why', 'answerType'],
          },
        },
      },
      required: ['questions'],
    },
  },
  {
    name: 'get_campaign',
    title: 'Reading the campaign',
    description:
      'Read the CAMPAIGN OBJECT as it is saved: what the engine will execute, nothing else. part: "all" (default: settings and every bucket with its journey outline), "shell" (settings only), "everyone_else", or a bucket id (that bucket in full, with its journey and each step\'s address for edit_journey).',
    input_schema: { type: 'object', properties: { part: { type: 'string' } } },
  },
  {
    name: 'create_campaign',
    title: 'Creating the campaign',
    description:
      'Create the campaign, once, in the CAMPAIGN OBJECT (saved straight to file). Same fields as edit_campaign: name, description, goal, entry, membership, everyoneElse, schedule (start and end dates), and for recurring campaigns maxAttempts and afterJourney; budgetCap when the manager gave an offer budget.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        goal: { type: 'object', properties: { eventCategory: { type: 'string' }, eventType: { type: 'string' }, conditions: { type: 'array', items: CONDITION } }, required: ['eventCategory', 'eventType'] },
        entry: { type: 'object', properties: { entity: { type: 'string' }, conditions: { type: 'array', items: CONDITION }, groups: { type: 'array', items: GROUP } }, required: ['entity'] },
        membership: { type: 'object', properties: { type: { type: 'string', enum: ['locked', 'open'] }, refresh: { type: 'string', enum: ['daily', 'weekly', 'monthly'] } }, required: ['type'] },
        everyoneElse: { type: 'object', properties: { approach: { type: 'string', enum: ['journey', 'none'] }, journey: STEPS }, required: ['approach'] },
        schedule: {
          type: 'object',
          description: 'When the campaign runs: startDate and endDate, YYYY-MM-DD. Start today or later; every campaign has an end date (a recurring one can use a far-off one). Set it from the window the manager gave, or your stated assumption.',
          properties: { startDate: { type: 'string' }, endDate: { type: 'string' } },
          required: ['startDate', 'endDate'],
        },
        maxAttempts: { type: 'number', description: 'Recurring campaigns: the stopping rule. The most times one customer goes through this campaign (usually 2). After their last time they leave for good, whatever their ending.' },
        budgetCap: { type: ['number', 'null'], description: 'The most the campaign may spend on offers, in rupees (the engine stops issuing offers once it is spent). From the manager\'s budget; null for no cap.' },
        afterJourney: {
          type: 'object',
          description: 'Recurring campaigns: per outcome, days before a customer may come back in (and be bucketed again), or "leave". Opted-out customers never come back and are not set here.',
          properties: Object.fromEntries(['no_response', 'not_reachable', 'declined', 'converted'].map((k) => [k, { anyOf: [{ type: 'number' }, { type: 'string', enum: ['leave'] }] }])),
        },
      },
      $defs: { step: STEP_DEF },
    },
  },
  {
    name: 'edit_campaign',
    title: 'Editing the campaign',
    description:
      'Change campaign settings in the CAMPAIGN OBJECT, saved straight to file. Execution fields only; send only what you are changing. name, description; goal {eventCategory, eventType} = the event that proves success (your goal checks take out anyone who reaches it); entry = who is eligible at all (everyone who has not reached the goal yet), as {entity, conditions[], groups[]} using real attributes; membership {type: "locked" (fixed as of launch) | "open" (newly matching customers join), refresh: daily|weekly|monthly}; everyoneElse {approach: "journey" | "none", journey: steps[]} for customers who match no bucket. afterJourney {no_response, not_reachable, declined, converted: days | "leave"} and maxAttempts (the stopping rule) for recurring campaigns. budgetCap = the most the campaign may spend on offers, in rupees (null for none). Reasons and notes go in the context (add_context), not here.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        goal: { type: 'object', properties: { eventCategory: { type: 'string' }, eventType: { type: 'string' }, conditions: { type: 'array', items: CONDITION } }, required: ['eventCategory', 'eventType'] },
        entry: { type: 'object', properties: { entity: { type: 'string' }, conditions: { type: 'array', items: CONDITION }, groups: { type: 'array', items: GROUP } }, required: ['entity'] },
        membership: { type: 'object', properties: { type: { type: 'string', enum: ['locked', 'open'] }, refresh: { type: 'string', enum: ['daily', 'weekly', 'monthly'] } }, required: ['type'] },
        everyoneElse: { type: 'object', properties: { approach: { type: 'string', enum: ['journey', 'none'] }, journey: STEPS }, required: ['approach'] },
        schedule: {
          type: 'object',
          description: 'When the campaign runs: startDate and endDate, YYYY-MM-DD. Start today or later; every campaign has an end date (a recurring one can use a far-off one). Set it from the window the manager gave, or your stated assumption.',
          properties: { startDate: { type: 'string' }, endDate: { type: 'string' } },
          required: ['startDate', 'endDate'],
        },
        maxAttempts: { type: 'number', description: 'Recurring campaigns: the stopping rule. The most times one customer goes through this campaign (usually 2). After their last time they leave for good, whatever their ending.' },
        budgetCap: { type: ['number', 'null'], description: 'The most the campaign may spend on offers, in rupees (the engine stops issuing offers once it is spent). From the manager\'s budget; null for no cap.' },
        afterJourney: {
          type: 'object',
          description: 'Recurring campaigns: per outcome, days before a customer may come back in (and be bucketed again), or "leave". Opted-out customers never come back and are not set here.',
          properties: Object.fromEntries(['no_response', 'not_reachable', 'declined', 'converted'].map((k) => [k, { anyOf: [{ type: 'number' }, { type: 'string', enum: ['leave'] }] }])),
        },
      },
      $defs: { step: STEP_DEF },
    },
  },
  {
    name: 'create_bucket',
    title: 'Creating a bucket',
    description:
      'Create ONE new bucket in the CAMPAIGN OBJECT, saved straight to file: id (short slug, new), name, priority (lower is checked first; first match wins, so buckets are mutually exclusive), rule (ANDed entity blocks the engine evaluates, using real attributes from list_audience_attributes), holdoutPct (0 unless the manager explicitly asked for a holdout), journey (this bucket\'s own steps, each with its AI rationale; each experiment with its hypothesis and successMetric). Its reasoning (behaviour, rationale, evidence, metric) and sizing go in the context with add_context.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        priority: { type: 'number' },
        rule: { type: 'array', items: GROUP },
        holdoutPct: { type: 'number' },
        journey: STEPS,
      },
      required: ['id', 'name', 'priority', 'rule'],
      $defs: { step: STEP_DEF },
    },
  },
  {
    name: 'edit_bucket',
    title: 'Editing a bucket',
    description:
      'Change or remove ONE bucket in the CAMPAIGN OBJECT, saved straight to file. Execution fields only: id (short slug), name, priority (lower is checked first; first match wins, so buckets are mutually exclusive), rule (ANDed entity blocks the engine evaluates, using real attributes from list_audience_attributes), holdoutPct (0 unless the manager explicitly asked for a holdout: a share of the bucket that gets no messages, to measure lift), journey (this bucket\'s own steps, each with its AI rationale; each experiment with its hypothesis and successMetric). Match by id; when changing, send only what changes. remove: true deletes it. The bucket\'s reasoning (behaviour, rationale, evidence, metric) and its sizing go in the context with add_context. For a small change to a journey use edit_journey.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        priority: { type: 'number' },
        rule: { type: 'array', items: GROUP },
        holdoutPct: { type: 'number' },
        journey: STEPS,
        remove: { type: 'boolean', description: 'true = delete this bucket.' },
        reason: { type: 'string', description: 'Why, when removing.' },
      },
      required: ['id'],
      $defs: { step: STEP_DEF },
    },
  },
  {
    name: 'list_links',
    title: 'Checking the bank\'s links',
    description:
      'The destinations this bank has for messages: each with a reference, a label, what the page does, its full URL and (for SMS) its short URL and length, the channels it may be used on, and whether it can go by SMS (smsReady). The URLs are for you to understand where a link goes and to fit SMS length — never write a URL into a message: attach the link by its reference (the send\'s "link" field) and the system adds the real URL when it sends. Read this early, while designing: a lever needs somewhere real to send people.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'list_signals',
    title: 'Checking customer signals',
    description:
      'The named facts this bank has about each customer (signals): key, label, type, plain definition, the values it takes, where it may be used, and status (live = the engine evaluates it today; proposed = designed, not yet supplied). Use a signal in a bucket rule as {entity: "Signal", conditions: [{attribute: <key>, operator, value}]}; never invent a signal or what it means. Banks without data access have only journey signals.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_context',
    title: 'Reading the context',
    description:
      'Read the CAMPAIGN CONTEXT: everything behind the campaign that does not execute — the manager\'s answers, the brief (findings and assumptions by aspect, including any incentive), each bucket\'s reasoning and size, research, notes, later results. Returns the current entries (the latest per kind + bucket + topic). Filter by kind, bucketId or topic; history: true returns every version.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['answer', 'brief', 'bucket', 'research', 'sizing', 'note', 'metric'] },
        bucketId: { type: 'string' },
        topic: { type: 'string' },
        history: { type: 'boolean' },
      },
    },
  },
  {
    name: 'add_context',
    title: 'Adding to the context',
    description:
      'Add entries to the CAMPAIGN CONTEXT, saved straight to file. Nothing is overwritten: a newer entry on the same kind + bucket + topic becomes the current one and the old one is kept as history. Each entry: {kind, topic, bucketId?, text, source: "manager" | "data" | "assumption" | "agent", data?}. Kinds: "brief" (what you concluded or assumed, topic = aspect such as Goal, Success, Incentive, Timing, Guardrails, Membership); "bucket" (with bucketId; topic "behaviour" = plain-language definition, "rationale" = your AI rationale: why stuck and the lever, with what it rests on, "evidence" with data {level: "measured" | "manager" | "hypothesis"} and the numbers or quotes as text, "metric"); "sizing" (with bucketId, topic "size", data {sql}: warehouse only, a SELECT returning the bucket\'s customer_id values; the app counts it); "research" (what the data showed); "note" (campaign-level reasoning, topic "campaign strategy" (your working plan: buckets, levers, money and budget, rewritten after every change), "measurement", "guardrails" or "everyone_else"; and "campaign brief", the whole campaign in a few plain sentences for readers, rewritten after every build). The manager\'s answers are filed by the app as kind "answer".',
    input_schema: {
      type: 'object',
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['brief', 'bucket', 'research', 'sizing', 'note', 'metric'] },
              topic: { type: 'string' },
              bucketId: { type: 'string' },
              text: { type: 'string' },
              source: { type: 'string', enum: ['manager', 'data', 'assumption', 'agent'] },
              data: { type: 'object' },
            },
            required: ['kind', 'topic', 'text'],
          },
        },
      },
      required: ['entries'],
    },
  },
  {
    name: 'set_flags',
    title: 'Updating progress',
    description: `Set or clear your progress flags, each with a one-line reason. You own: ${AGENT_FLAGS.join(', ')}. Set a flag true when it genuinely is, and back to false if something you learn undoes it.`,
    input_schema: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          items: {
            type: 'object',
            properties: { flag: { type: 'string', enum: AGENT_FLAGS }, value: { type: 'boolean' }, reason: { type: 'string' } },
            required: ['flag', 'value', 'reason'],
          },
        },
      },
      required: ['changes'],
    },
  },
  {
    name: 'edit_journey',
    title: 'Editing a journey',
    description:
      'Change ONE bucket\'s journey precisely, saved straight to file, without rewriting it (keep each changed step\'s rationale, or an experiment\'s hypothesis and successMetric, true to the new version): a list of operations, each {op: "replace" | "replace_from" | "insert_after" | "insert_before" | "remove", path, step}. "replace_from" replaces the step at path AND everything after it in that list with the one step given: use it to split a journey from a step onward (a branch whose routes each carry the rest of the journey to its end). path is the step\'s address from get_campaign (e.g. "2", "1.arms.0.steps.3", "4.paths.1.steps.0", "4.otherwise.0"). step is a full step for replace/insert. Use bucketId "everyone_else" for the everyone-else journey. Leave every other step as it is. Rebuild afterwards.',
    input_schema: {
      type: 'object',
      properties: {
        bucketId: { type: 'string' },
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['replace', 'replace_from', 'insert_after', 'insert_before', 'remove'] },
              path: { type: 'string' },
              step: { $ref: '#/$defs/step' },
            },
            required: ['op', 'path'],
          },
        },
      },
      required: ['bucketId', 'operations'],
      $defs: { step: STEP_DEF },
    },
  },
  ...AGENT_TOOLS,
  {
    name: 'build_campaign',
    title: 'Building the campaign',
    description:
      'Build the campaign on file as ONE campaign on the canvas: the entry, then a chain of bucket rules (first match wins) each leading to its holdout split and journey, then everyone else. Returns what was built and any problems; fix the plan and build again if needed.',
    input_schema: { type: 'object', properties: {} },
  },
];

const INCENTIVE_TOOLS: ToolDef[] = [
  {
    name: 'list_incentives',
    title: "Checking the bank's offers",
    description:
      "The bank's incentive menu: special offers a campaign may use on top of what customers are already eligible for, cheapest first, valid for the campaign's dates. Each has its mechanic, trigger (what the customer must do), the goals it fits, its cost to the bank, what it requires (product eligibility set by the bank: a campaign never grants it), who it is meant for, rules only the engine can check, budget left, and its exact terms. Never invent an offer, amount or term; use only these, by id. Give bucketId (with data access, once the bucket is sized) to see how many of that bucket meet each offer's requirements and targeting.",
    input_schema: { type: 'object', properties: { bucketId: { type: 'string', description: 'Optional: a sized bucket, to count who qualifies.' } } },
  },
];

const WAREHOUSE_TOOLS: ToolDef[] = [
  {
    name: 'ask_data',
    title: 'Asking the data',
    description:
      'For questions that need several queries or a verdict. Ask a question, or put a hypothesis to it, in plain English (e.g. "Do customers lapsed 61-90 days usually come back on their own?", "Most occasional spenders are EMI-eligible"). A data analyst writes and runs the queries. You get back its answer (the bottom line, the numbers behind it, what the data cannot tell) AND its workbook: every query it ran with its purpose, SQL and the rows that came back. Check the answer against the rows. Everything is filed in the notebook. For a quick count, use run_sql_query yourself. Give sizeBucket to have it size a bucket whose rule can\'t be written in signals (buckets with signal rules are sized by the app). Exact checks (who qualifies for an offer) use list_incentives, not this.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question or hypothesis, in plain English. Mention a bucket by name if it is about one.' },
        sizeBucket: { type: 'string', description: 'Optional: a bucket id to size (its rule as you defined it, after earlier buckets in priority order).' },
      },
      required: ['question'],
    },
  },
  {
    name: 'get_table_schema',
    title: 'Reading the data warehouse',
    description: "Lists the bank's warehouse tables, their columns, row counts, example values, and the date the data runs to (treat that date as 'today' for recency).",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'run_sql_query',
    title: 'Querying the data',
    description:
      'Run ONE read-only SQLite SELECT (or WITH … SELECT) against the warehouse. Returns up to 200 rows. Aggregate in SQL rather than pulling raw rows. Say in `purpose` what you are trying to learn. Every query is filed in the notebook with its rows under a short id (the reply says which, e.g. Q7): cite it as [Q7] after any sentence that uses its numbers. In a long turn, older results here may be shortened; re-read them with get_context rather than re-running.',
    input_schema: { type: 'object', properties: { sql: { type: 'string' }, purpose: { type: 'string' } }, required: ['sql', 'purpose'] },
  },
];

/** Questions with no options, not declared yes/no, that aren't yes/no questions (e.g. "How many…?", "…, or …?"): they need options. */
export function needsOptions(raw: unknown): string[] {
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  return list
    .filter((q) => q && typeof q.text === 'string' && q.text.trim())
    .filter((q) => q.answerType !== 'yesno' && !(Array.isArray(q.options) && q.options.length) && !(Array.isArray(q.suggestions) && q.suggestions.length))
    .filter((q) => {
      const t = String(q.text).replace(/\*/g, '').trim();
      const yesNo = /^(is|are|do|does|did|should|shall|can|could|will|would|has|have|may|must)\b/i.test(t) && !/,?\s+or\s+/i.test(t);
      return !yesNo;
    })
    .map((q) => String(q.text).replace(/\*/g, '').trim().slice(0, 80));
}

export function toolsFor(warehouse: boolean, incentives = false): ToolDef[] {
  const extra = [...(warehouse ? WAREHOUSE_TOOLS : []), ...(incentives ? INCENTIVE_TOOLS : [])];
  if (!extra.length) return BASE_TOOLS;
  const i = BASE_TOOLS.findIndex((t) => t.name === 'build_campaign');
  return [...BASE_TOOLS.slice(0, i), ...extra, ...BASE_TOOLS.slice(i)];
}

const LOOKUP_DONE: Record<string, string> = {
  list_event_types: 'Looked up trigger events',
  list_audience_attributes: 'Looked up customer fields',
  list_channels: 'Checked channels',
  check_template_availability: 'Checked message templates',
  list_step_types: 'Looked up journey step types',
};

export const TOOL_TITLES: Record<string, { running: string; done: string }> = {
  ...Object.fromEntries(AGENT_TOOLS.map((t) => [t.name, { running: t.title, done: LOOKUP_DONE[t.name] ?? t.title }])),
  ask_questions: { running: 'Putting questions to you', done: 'Asked you questions' },
  get_campaign: { running: 'Reading the campaign', done: 'Read the campaign' },
  create_campaign: { running: 'Creating the campaign', done: 'Created the campaign' },
  edit_campaign: { running: 'Editing the campaign', done: 'Edited the campaign' },
  create_bucket: { running: 'Creating a bucket', done: 'Created a bucket' },
  edit_bucket: { running: 'Editing a bucket', done: 'Edited a bucket' },
  get_context: { running: 'Reading the context', done: 'Read the context' },
  list_links: { running: "Checking the bank's links", done: "Checked the bank's links" },
  list_signals: { running: 'Checking customer signals', done: 'Checked customer signals' },
  ask_data: { running: 'Asking the data', done: 'Asked the data' },
  list_incentives: { running: "Checking the bank's offers", done: "Checked the bank's offers" },
  add_context: { running: 'Adding to the context', done: 'Added to the context' },
  set_flags: { running: 'Updating progress', done: 'Updated progress' },
  edit_journey: { running: 'Editing a journey', done: 'Edited a journey' },
  get_table_schema: { running: 'Reading the data warehouse', done: 'Read the data warehouse' },
  run_sql_query: { running: 'Querying the data', done: 'Queried the data' },
  build_campaign: { running: 'Building the campaign', done: 'Built the campaign' },
};

export interface ToolEnv {
  tenant: TenantConfig;
  availableChannels: Channel[];
  goalStatement: string;
  /** Everything the manager has written in this chat (the brief and messages): an [M] source. */
  managerSaid?: string[];
  sessionId: string;
  /** Set when the tenant has a warehouse. */
  warehouseBank?: string;
  /** Lookup results already fetched this turn, keyed by name+input. */
  lookupCache: Map<string, unknown>;
  /** The bank's link registry. */
  links?: BankLink[];
  /** Bank-wide delivery policy: undelivered WhatsApp/RCS goes again by SMS. */
  smsFallback?: boolean;
}

export interface ToolOutcome {
  state: AgentState;
  /** What goes back to the model as the tool_result. */
  forModel: string;
  /** One line for the activity row. */
  summary: string;
  doneTitle?: string;
  ok: boolean;
  result?: unknown;
  asked?: AgentQuestion[];
  /** This call means the manager acts next (questions asked, sign-off requested). */
  endsTurn?: boolean;
  build?: { graph: unknown; campaign: unknown; notes: string[] };
}

const flagLine = (s: AgentState) =>
  Object.entries(s.flags)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');


/**
 * The campaign object as get_campaign returns it. Journeys come with each
 * step's address, which is what edit_journey takes.
 */
export function campaignView(state: AgentState, part: string): unknown | null {
  // Step ids are the backend's; the agent never sees them.
  const c = { ...state.campaign, buckets: state.campaign.buckets.map((b) => ({ ...b, journey: stripJourneyIds(b.journey) })), everyoneElse: state.campaign.everyoneElse ? { ...state.campaign.everyoneElse, journey: stripJourneyIds(state.campaign.everyoneElse.journey) ?? undefined } : null };
  const withOutline = (steps: BpStep[] | null | undefined) => (steps?.length ? { journey: steps, outline: outline(steps) } : { journey: null });
  const { buckets, everyoneElse, ...shell } = c;
  if (part === 'shell') return { ...shell, everyoneElse: everyoneElse ? { approach: everyoneElse.approach, outline: outline(everyoneElse.journey ?? []) } : null };
  if (part === 'everyone_else') return everyoneElse ? { approach: everyoneElse.approach, ...withOutline(everyoneElse.journey) } : null;
  if (part === 'all')
    return {
      ...shell,
      everyoneElse: everyoneElse ? { approach: everyoneElse.approach, outline: outline(everyoneElse.journey ?? []) } : null,
      buckets: buckets.map(({ journey, ...b }) => ({ ...b, outline: journey?.length ? outline(journey) : null })),
      built: state.flags.campaignBuilt,
    };
  const b = buckets.find((x) => x.id === part);
  return b ? { ...b, ...withOutline(b.journey) } : null;
}

/** Counts a sizing entry's SQL against the warehouse and records the size (or why it failed) in its data. */
function sizeEntries(raw: unknown, env: ToolEnv): { entries: unknown[]; lines: string[] } {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? [raw] : [];
  const lines: string[] = [];
  const entries = list.map((item) => {
    const e = (item ?? {}) as { kind?: unknown; bucketId?: unknown; data?: Record<string, unknown> };
    const sql = typeof e.data?.sql === 'string' ? e.data.sql : undefined;
    if (e.kind !== 'sizing' || !sql) return item;
    if (!env.warehouseBank) {
      lines.push(`${String(e.bucketId ?? '?')}: not sized (no data warehouse for this bank).`);
      return { ...e, data: { ...e.data, error: 'No data warehouse for this bank' } };
    }
    try {
      const n = countCustomers(env.warehouseBank, sql);
      lines.push(`${String(e.bucketId ?? '?')}: ${n.toLocaleString('en-IN')} customers.`);
      return { ...e, data: { ...e.data, size: n } };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lines.push(`${String(e.bucketId ?? '?')}: the SQL failed (${msg}); fix it and add the sizing again.`);
      return { ...e, data: { ...e.data, error: msg } };
    }
  });
  return { entries, lines };
}

export function runToolCall(name: string, input: Record<string, unknown>, state: AgentState, env: ToolEnv): ToolOutcome {
  const out = runToolCallInner(name, input, state, env);
  if (!out.ok || !env.links || !['create_bucket', 'edit_bucket', 'edit_journey', 'create_campaign', 'edit_campaign'].includes(name) || out.state.campaign === state.campaign) return out;
  // A link that cannot be sent is refused like any other hard rule — but only
  // when this edit introduced it; problems already there are left to the build
  // checks and repair turns, so they never block an unrelated edit.
  const lanes = (c: AgentState['campaign']) => [...c.buckets.map((b) => b.journey), c.everyoneElse?.journey ?? null];
  const fb = env.smsFallback ?? true;
  const before = new Set(lanes(state.campaign).flatMap((j) => linkProblemsIn(j, env.links!, fb)));
  const fresh = lanes(out.state.campaign).flatMap((j) => linkProblemsIn(j, env.links!, fb)).filter((p) => !before.has(p));
  if (!fresh.length) return out;
  const usable = env.links.filter((l) => l.status === 'active').map((l) => `${l.ref}${l.shortUrl ? '' : ' (not for SMS)'}`).join(', ');
  return { state, ok: false, summary: 'Link not usable', forModel: `Nothing was saved: ${fresh.join('; ')}. Usable links: ${usable || 'none'}. Pick one of these, or leave the link out if the message only informs or nothing fits (then say so).` };
}

function runToolCallInner(name: string, input: Record<string, unknown>, state: AgentState, env: ToolEnv): ToolOutcome {
  switch (name) {
    case 'ask_questions': {
      // Without options a question becomes Yes / No. Only allow that for a real yes/no question.
      const missing = needsOptions(input.questions);
      if (missing.length)
        return {
          state,
          ok: false,
          summary: 'Questions need options',
          forModel: `Nothing was asked. ${missing.map((t) => `"${t}"`).join(', ')} ${missing.length === 1 ? 'is not a yes/no question but has' : 'are not yes/no questions but have'} no options, so the manager would only see Yes / No. Give each one 2-4 options (answerType "single" or "multi"), or rephrase it as a yes/no question, and ask all the questions again in one call.`,
        };
      const { state: next, added, dropped } = addQuestions(state, input.questions);
      if (!added.length) return { state, ok: false, forModel: 'No usable questions: each needs aspect, text and answerType.', summary: 'No usable questions' };
      const aspects = [...new Set(added.map((q) => q.aspect))];
      return {
        state: next,
        ok: true,
        asked: added,
        endsTurn: true,
        doneTitle: `Asked you ${added.length} question${added.length === 1 ? '' : 's'}`,
        summary: aspects.join(' · '),
        result: added.map((q) => ({ aspect: q.aspect, question: q.text, ...(q.why ? { why: q.why } : {}), type: q.answerType, options: q.options ?? [] })),
        forModel: `${added.length} question(s) are on the manager's form${dropped ? ` (${dropped} dropped: missing text)` : ''}.${added.some((q) => !q.why) ? ` These have no why, so the manager cannot see why you ask: ${added.filter((q) => !q.why).map((q) => q.id).join(', ')}.` : ''} questionsAnswered is now false. If the manager told you anything this turn that is not filed yet, file it now. Then write one or two sentences — what you understood so far — and end your turn. Do not repeat the questions in your message.`,
      };
    }

    case 'get_campaign': {
      const part = typeof input.part === 'string' && input.part.trim() ? input.part.trim() : 'all';
      const view = campaignView(state, part);
      if (!view) return { state, ok: false, forModel: `No part "${part}". Use all, shell, everyone_else, or one of these bucket ids: ${state.campaign.buckets.map((b) => b.id).join(', ') || '(none yet)'}.`, summary: `No part "${part}"` };
      return { state, ok: true, doneTitle: part === 'all' ? 'Read the campaign' : `Read the campaign (${part})`, summary: part, result: view, forModel: JSON.stringify(view) };
    }

    case 'create_campaign':
    case 'edit_campaign': {
      const c = state.campaign;
      const exists = !!(c.name || c.goal || c.entry || c.membership || c.buckets.length);
      if (name === 'create_campaign' && exists) return { state, ok: false, forModel: 'Not saved: the campaign already exists. Change it with edit_campaign.', summary: 'Campaign already exists' };
      if (name === 'edit_campaign' && !exists) return { state, ok: false, forModel: 'Not saved: there is no campaign yet. Create it with create_campaign.', summary: 'No campaign yet' };
      const res = updateCampaign(state, input);
      if (res.error) return { state, ok: false, forModel: `Not saved: ${res.error}`, summary: res.error };
      const { buckets: _b, ...shell } = res.state.campaign;
      void _b;
      return { state: res.state, ok: true, doneTitle: name === 'create_campaign' ? 'Created the campaign' : 'Edited the campaign', summary: res.said, result: shell, forModel: `Saved. ${res.said} Flags now: ${flagLine(res.state)}.` };
    }

    case 'create_bucket':
    case 'edit_bucket': {
      const known = state.campaign.buckets.some((b) => b.id === input.id);
      if (name === 'create_bucket' && known) return { state, ok: false, forModel: `Not saved: bucket "${String(input.id)}" already exists. Change it with edit_bucket.`, summary: 'Bucket already exists' };
      if (name === 'edit_bucket' && !known) return { state, ok: false, forModel: `Not saved: there is no bucket "${String(input.id)}". Create it with create_bucket. Buckets now: ${state.campaign.buckets.map((b) => b.id).join(', ') || 'none'}.`, summary: 'No such bucket' };
      if (input.remove === true) {
        const res = removeBucket(state, String(input.id ?? ''), typeof input.reason === 'string' ? input.reason : '');
        if (res.error) return { state, ok: false, forModel: res.error, summary: res.error };
        return { state: res.state, ok: true, doneTitle: 'Removed a bucket', summary: String(input.id), forModel: `Removed and saved. Buckets now: ${res.state.campaign.buckets.map((x) => x.id).join(', ') || 'none'}. Its context is kept as history.` };
      }
      const { remove: _r, reason: _why, ...fields } = input;
      void _r;
      void _why;
      const isNew = !state.campaign.buckets.some((b) => b.id === fields.id);
      const res = upsertBucket(state, fields);
      if (res.error || !res.bucket) return { state, ok: false, forModel: `Not saved: ${res.error}`, summary: res.error ?? 'Not saved' };
      const b = res.bucket;
      return {
        state: res.state,
        ok: true,
        doneTitle: `${isNew ? 'Added' : 'Updated'} bucket "${b.name}"`,
        summary: [b.journey?.length ? `${b.journey.length}-step journey` : 'no journey yet', b.holdoutPct ? `${b.holdoutPct}% holdout` : ''].filter(Boolean).join(' · '),
        result: { id: b.id, name: b.name, priority: b.priority, rule: b.rule, holdoutPct: b.holdoutPct, journeySteps: b.journey?.length ?? 0 },
        forModel: `Saved. ${res.said} Buckets now: ${res.state.campaign.buckets.map((x) => `${x.priority}. ${x.id}${x.journey?.length ? ' [journey]' : ''}`).join('; ')}.${isNew ? ' File its reasoning (behaviour, rationale, evidence, metric) with add_context.' : ''}`,
      };
    }

    case 'list_links': {
      const list = (env.links ?? []).filter((l) => l.status === 'active').map(forAgent);
      const retired = (env.links ?? []).filter((l) => l.status === 'retired').map((l) => l.ref);
      return {
        state,
        ok: true,
        doneTitle: "Checked the bank's links",
        summary: `${list.length} link${list.length === 1 ? '' : 's'}${list.some((l) => !l.smsReady) ? `, ${list.filter((l) => !l.smsReady).length} not ready for SMS` : ''}`,
        result: list,
        forModel: list.length ? `${JSON.stringify(list)}${retired.length ? ` Retired (do not use): ${retired.join(', ')}.` : ''}` : 'This bank has no links registered. Messages can only inform, or point customers to the app in words; say so to the manager.',
      };
    }

    case 'list_signals': {
      const list = signalsForAgent(signalsFor(env.tenant));
      const data = list.filter((x) => x.kind !== 'journey').length;
      return {
        state,
        ok: true,
        doneTitle: 'Checked customer signals',
        summary: `${list.length} signals${data ? '' : ' (journey only: no data access)'}`,
        result: list,
        forModel: `${JSON.stringify(list)}${data ? '' : ' This bank has no data access, so only journey signals exist: buckets are hypotheses from the manager and your judgement.'}`,
      };
    }

    case 'list_incentives': {
      const all = incentivesFor(env.tenant);
      if (!all.length) return { state, ok: true, summary: 'No incentive menu', forModel: 'This bank has no incentive menu: campaigns persuade with communication only. Never offer or invent an incentive.' };
      const signals = signalsFor(env.tenant);
      const valid = all.filter((i) => validFor(i, state.campaign.schedule, todayIST())).sort((a, b) => a.maxCostPerCustomer - b.maxCostPerCustomer);
      const bucketId = typeof input.bucketId === 'string' ? input.bucketId : '';
      const sizing = bucketId ? bucketContext(state.context.entries)[bucketId]?.sql : undefined;
      let note = '';
      if (bucketId && !env.warehouseBank) note = ' This bank has no data access, so who qualifies can only be judged from the rules; the engine checks each customer when it issues an offer.';
      else if (bucketId && !sizing) note = ` Bucket "${bucketId}" has no sizing query yet, so who qualifies can't be counted. Size it first (add_context kind "sizing").`;
      const list = valid.map((i) => {
        const base = incentiveForAgent(i, signals);
        if (!bucketId || !sizing || !env.warehouseBank) return base;
        const q = qualifyingShare(env.warehouseBank, signals, sizing, i);
        if ('error' in q) return { ...base, qualifying: q.error };
        const pct = (n: number) => (q.size ? Math.round((100 * n) / q.size) : 0);
        return { ...base, qualifying: { bucketSize: q.size, meetRequirements: q.meetRequires, meetRequirementsPct: pct(q.meetRequires), qualify: q.qualify, qualifyPct: pct(q.qualify) } };
      });
      const dropped = all.length - valid.length;
      return {
        state,
        ok: true,
        doneTitle: "Checked the bank's offers",
        summary: `${list.length} offer${list.length === 1 ? '' : 's'}${bucketId ? ` for ${bucketId}` : ''}`,
        result: list,
        forModel: `${JSON.stringify(list)}${dropped ? ` ${dropped} more not valid for the campaign's dates or out of budget.` : ''}${note} MOCK library: standard credit card offers with dummy figures.`,
      };
    }

    case 'get_context': {
      const filter = {
        ...(typeof input.kind === 'string' ? { kind: input.kind } : {}),
        ...(typeof input.bucketId === 'string' ? { bucketId: input.bucketId } : {}),
        ...(typeof input.topic === 'string' ? { topic: input.topic } : {}),
      };
      const list = input.history === true ? entryHistory(state.context.entries, filter) : currentEntries(state.context.entries, filter);
      const view = list.map(({ id, at, kind, topic, bucketId, text, source, data }) => ({ id, at, kind, topic, ...(bucketId ? { bucketId } : {}), text, source, ...(data ? { data } : {}) }));
      return { state, ok: true, doneTitle: 'Read the context', summary: `${view.length} entr${view.length === 1 ? 'y' : 'ies'}`, result: view, forModel: view.length ? JSON.stringify(view) : 'Nothing in the context matches.' };
    }

    case 'add_context': {
      const sized = sizeEntries(input.entries, env);
      const res = addContext(state, sized.entries);
      if (!res.added.length) return { state, ok: false, forModel: 'Nothing added: each entry needs kind, topic and text.', summary: 'Nothing added' };
      // Say plainly when an entry took over a slot that already had a current value.
      const before = new Map(currentEntries(state.context.entries).map((e) => [contextKey(e), e]));
      const replaced = res.added
        .map((e) => before.get(contextKey(e)))
        .filter((e): e is NonNullable<typeof e> => !!e && e.kind !== 'sizing')
        .map((e) => `${e.kind}${e.bucketId ? `/${e.bucketId}` : ''} "${e.topic}" (was: "${e.text.slice(0, 120)}")`);
      const kinds = [...new Set(res.added.map((e) => e.kind))];
      return {
        state: res.state,
        ok: true,
        doneTitle: `Added to the context (${kinds.join(', ')})`,
        summary: res.added.map((e) => `${e.bucketId ? `${e.bucketId} · ` : ''}${e.topic}`).join('; ').slice(0, 160),
        result: res.added,
        forModel: `Saved ${res.added.length} entr${res.added.length === 1 ? 'y' : 'ies'}${res.dropped ? ` (${res.dropped} dropped: missing kind, topic or text)` : ''}.${sized.lines.length ? ` Sizing: ${sized.lines.join(' ')}` : ''}${replaced.length ? ` These REPLACED the current entry on the same topic (the old one is kept only as history): ${replaced.join('; ')}. If you meant to add a new fact rather than update that one, add the old text back and give the new fact its own topic.` : ''}`,
      };
    }

    case 'set_flags': {
      const changes = Array.isArray(input.changes) ? input.changes : [];
      let next = state;
      const applied: string[] = [];
      const refused: string[] = [];
      for (const c of changes) {
        const ch = (c ?? {}) as Record<string, unknown>;
        if (typeof ch.flag === 'string' && isAgentFlag(ch.flag) && typeof ch.value === 'boolean') {
          next = setFlag(next, ch.flag, ch.value, 'agent', typeof ch.reason === 'string' ? ch.reason : '');
          applied.push(`${ch.flag}=${ch.value}`);
        } else refused.push(String(ch.flag));
      }
      return {
        state: next,
        ok: applied.length > 0,
        summary: applied.join(', ') || 'No change',
        result: applied,
        forModel: `${applied.length ? `Set ${applied.join(', ')}.` : 'Nothing changed.'}${refused.length ? ` Not yours to set: ${refused.join(', ')} (the manager or the app sets those).` : ''} Flags now: ${flagLine(next)}.`,
      };
    }

    case 'edit_journey': {
      // Operations sometimes arrive as JSON text: read them rather than treating them as none.
      let rawOps: unknown = input.operations;
      if (typeof rawOps === 'string') {
        try {
          rawOps = JSON.parse(rawOps);
        } catch {
          rawOps = null;
        }
      }
      if (!Array.isArray(rawOps) || !rawOps.length) return { state, ok: false, summary: 'No operations', forModel: 'Not changed: operations must be a non-empty list (a JSON array) of {op, path, step}.' };
      const ops = rawOps;
      const res = editJourney(state, String(input.bucketId ?? ''), ops as never);
      if (res.error) return { state, ok: false, forModel: `Not changed: ${res.error}`, summary: res.error };
      return { state: res.state, ok: true, doneTitle: 'Edited a journey', summary: res.said, result: { bucketId: input.bucketId, operations: ops }, forModel: `${res.said} The canvas is out of date until you call build_campaign.` };
    }

    case 'get_table_schema': {
      if (!env.warehouseBank) return { state, ok: false, forModel: 'This tenant has no data warehouse.', summary: 'No warehouse' };
      const cached = env.lookupCache.get('schema');
      const schema = cached ?? warehouseSchema(env.warehouseBank);
      env.lookupCache.set('schema', schema);
      const s = schema as ReturnType<typeof warehouseSchema>;
      return {
        state,
        ok: true,
        summary: `${s.tables.length} tables${s.dataAsOf ? `, data to ${s.dataAsOf}` : ''}`,
        result: s,
        forModel: cached ? 'You already have the schema above in this turn. Use it.' : JSON.stringify(s),
      };
    }

    case 'run_sql_query': {
      if (!env.warehouseBank) return { state, ok: false, forModel: 'This tenant has no data warehouse.', summary: 'No warehouse' };
      const sql = String(input.sql ?? '');
      try {
        const r = runWarehouseQuery(env.warehouseBank, sql);
        // Every query is filed in the notebook with its rows: the evidence stays inspectable, and
        // compaction can shorten old results in the conversation without losing them.
        // Each query gets a short id the agent cites inline ("[Q7]"); its own topic, so re-running
        // a purpose never replaces an older query a note cites. Rows kept as the agent saw them.
        const purpose = typeof input.purpose === 'string' && input.purpose.trim() ? input.purpose.trim() : 'query';
        const qid = nextQid(state.context);
        const filed = addContext(state, [
          {
            kind: 'research',
            topic: `query: ${qid} ${purpose.replace(/\s+/g, ' ').slice(0, 80)}`,
            text: `${purpose} (${r.rows.length}${r.truncated ? '+' : ''} rows)`,
            source: 'data',
            data: { qid, purpose, sql, columns: r.columns, rows: r.rows, truncated: r.truncated },
          },
        ]).state;
        return {
          state: filed,
          ok: true,
          summary: `${typeof input.purpose === 'string' ? input.purpose : 'Query'} · ${r.rows.length}${r.truncated ? '+' : ''} rows`,
          result: { sql, purpose: input.purpose, rows: r.rows.slice(0, 50), truncated: r.truncated || r.rows.length > 50, ms: r.ms },
          forModel: JSON.stringify({ filedAs: qid, cite: `[${qid}]`, columns: r.columns, rows: r.rows, truncated: r.truncated }),
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { state, ok: false, summary: msg, result: { sql, error: msg }, forModel: `Query failed: ${msg}` };
      }
    }

    case 'build_campaign':
      return buildCampaign(state, env);

    default: {
      if (!AGENT_TOOLS.some((t) => t.name === name)) return { state, ok: false, forModel: `Unknown tool ${name}.`, summary: 'Unknown tool' };
      const key = `${name}:${JSON.stringify(input ?? {})}`;
      if (env.lookupCache.has(key)) {
        return { state, ok: true, summary: 'Already fetched this turn', result: env.lookupCache.get(key), forModel: 'You already have this result above in this turn. Use it.' };
      }
      const run = runTool(name, input ?? {}, { tenant: env.tenant });
      env.lookupCache.set(key, run.result);
      return { state, ok: run.ok, summary: run.summary, result: run.result, forModel: JSON.stringify(run.result) };
    }
  }
}

export function buildCampaign(state: AgentState, env: ToolEnv): ToolOutcome {
  // Buckets with signal rules are sized by code, before anything that reads sizes.
  const sizedByApp = autoSizeBuckets(state, env.tenant);
  let next = sizedByApp.state;
  const compiled = planToBlueprint(next.campaign);
  if (!compiled.blueprint) {
    next = log(next, 'app', 'build_failed', compiled.problems.join(' '));
    return { state: next, ok: false, forModel: `Nothing to build: ${compiled.problems.join(' ')}`, summary: 'Nothing to build', result: compiled.problems };
  }
  let built;
  try {
    built = buildFromBlueprint(compiled.blueprint, {
      availableChannels: env.availableChannels,
      templateLibraryAccess: env.tenant.templateLibraryAccess === 'synthetic-demo' ? 'synthetic-demo' : 'unavailable',
      signals: signalsFor(env.tenant),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    next = log(next, 'app', 'build_failed', msg);
    return { state: next, ok: false, forModel: `The build engine failed: ${msg}. Check the buckets' rules and journeys and try again.`, summary: 'Build failed' };
  }
  const nodes = Object.values(built.graph.nodes ?? {}) as { type?: string }[];
  const sends = nodes.filter((n) => n.type === 'SEND').length;

  const proposal = buildCampaignProposal({
    scenarioId: env.sessionId,
    goalStatement: env.goalStatement,
    goal: built.goal,
    graph: built.graph,
    tenantContext: { tenantId: env.tenant.tenantId, issuer: env.tenant.issuer },
  });
  const bp = compiled.blueprint;
  const campaign = proposal.usable && bp.campaignName ? { ...proposal.campaign, name: bp.campaignName, description: bp.description ?? proposal.campaign.description } : proposal.campaign;
  const bank = bankContext() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  let validationLines: string[] = [];
  try {
    const validation = validateCampaignGraph(
      built.graph,
      { fanOut: [] },
      { quietHours: bank.hardConstraints?.quietHours, availableChannels: bank.channels?.available },
      { campaign, provenance: proposal.provenance, blockers: proposal.blockers as string[] },
    );
    // A check that fails only because sends have no bank template id yet says
    // nothing new: the template line below already covers it.
    validationLines = validation.checks
      .filter((c) => c.status === 'fail')
      .filter((c) => !/^failed: (dcn\d+ \(Send\)[^;]*;? ?)+$/.test(String(c.detail ?? '')))
      .map((c) => `Check failed: ${c.detail ?? c.id}`);
  } catch (e) {
    validationLines = [`Validation could not run: ${e instanceof Error ? e.message : String(e)}`];
  }

  const notes = [
    ...sizedByApp.notes,
    ...compiled.problems,
    ...built.issues.map((i) => `${i.path}: ${i.problem}`),
    ...built.limitations.map((l) => `Cannot express ${l.attribute}: ${l.note}`),
    ...validationLines,
  ];

  if (nodes.length <= 1) {
    next = log(next, 'app', 'build_failed', 'The build produced no journey');
    return { state: next, ok: false, forModel: `Nothing was built. Problems: ${notes.join(' | ') || 'none reported'}. Fix the plan and build again.`, summary: 'Nothing built', result: notes };
  }
  const summary = `${compiled.bucketsIncluded.length} buckets, ${sends} messages, ${nodes.length} steps`;
  const knockOns = checkJourneys(next.campaign, env.links, env.smsFallback ?? true, true);
  const openEndings = endingGaps(next.campaign);
  const offers = offerProblems(next.campaign, next.context, env.tenant);
  const cites = citationProblems(next.campaign, next.context, env.tenant, !!env.warehouseBank, env.managerSaid ?? [env.goalStatement], offers.cost);
  next = setFlag(next, 'campaignBuilt', true, 'app', summary);
  next = log(next, 'app', 'campaign_built', `Built: ${summary}${notes.length ? `, ${notes.length} note(s)` : ''}`);
  return {
    state: next,
    ok: true,
    doneTitle: 'Built the campaign',
    summary: `${summary}${notes.length ? ` · ${notes.length} note(s)` : ''}`,
    result: { buckets: compiled.bucketsIncluded, messages: sends, steps: nodes.length, notes, ...(knockOns.length ? { toFix: knockOns } : {}), ...(openEndings.length ? { endingsToDecide: openEndings } : {}), ...(offers.cost.mode !== 'none' ? { potentialSpend: costLine(offers.cost) } : {}), ...(offers.problems.length ? { offersToFix: offers.problems } : {}) },
    build: { graph: built.graph, campaign, notes },
    forModel: `Built on the canvas as one campaign: ${summary} (buckets: ${compiled.bucketsIncluded.join(', ')}).${notes.length ? ` Notes: ${notes.join(' | ')}` : ' No problems reported.'}${knockOns.length ? ` FIX BEFORE YOU FINISH — a change left these problems further down the tree: ${knockOns.join(' | ')} Fix each one (edit_journey / edit_bucket), build again, and list what you fixed under "Also changed because of this".` : ''}${openEndings.length ? ` ENDINGS NOT DECIDED YET: ${openEndings.join(' | ')} Decide these for the journeys you designed or changed in this conversation turn; for journeys you did not touch, do not change them unasked — mention in one line that their endings are not decided.` : ''}${offers.cost.mode !== 'none' ? ` POTENTIAL SPEND ON OFFERS (worked out by code; quote these figures, never your own): ${costLine(offers.cost)}.${offers.cost.notes.length ? ` ${offers.cost.notes.join(' ')}` : ''}` : ''}${offers.problems.length ? ` OFFERS AND ROUTES TO FIX BEFORE YOU FINISH: ${offers.problems.join(' | ')}` : ''}${cites.errors.length ? ` CITATIONS TO FIX BEFORE YOU FINISH: ${cites.errors.join(' | ')}` : ''}${cites.stats.uncited ? ` (${cites.stats.uncited} figure${cites.stats.uncited === 1 ? '' : 's'} from data ha${cites.stats.uncited === 1 ? 's' : 've'} no source yet, e.g. ${cites.warnings.slice(0, 2).join(' / ')}. Add [Q…] where they came from a query.)` : ''} Tell the manager plainly what was built, anything that needs their attention, and that they can ask you to change any bucket or any step.`,
  };
}
