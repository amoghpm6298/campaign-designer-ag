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
import { checkJourneys, endingGaps, linkProblemsIn, planToBlueprint } from './compile';
import { forAgent, type BankLink } from '../links';
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
    entity: { type: 'string', description: 'Customer, Account, Card, Transaction or Milestone (see list_audience_attributes).' },
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
      'Ask the manager questions. They appear as a form, grouped by aspect, with tappable answers. Each question asks ONE thing in one short sentence (no examples inside the question: put them in options). Every question gets tappable answers; the form always adds "Other" for a custom answer, so never write "Other". answerType: "yesno" for a yes/no question (no options needed), "single" when one answer applies, "multi" when several can. For single/multi give 1-4 short options in the manager\'s voice; one option means "this is what I propose". Even for personal questions (patterns they have seen, reasons), propose your best guesses as options. After calling this, file anything outstanding, write one or two sentences and end your turn.',
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
              answerType: { type: 'string', enum: ['yesno', 'single', 'multi'] },
              options: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'single/multi only: 1-4 answers. Leave out for yesno.' },
            },
            required: ['aspect', 'text', 'answerType'],
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
    name: 'edit_campaign',
    title: 'Editing the campaign',
    description:
      'Change campaign settings in the CAMPAIGN OBJECT, saved straight to file. Execution fields only; send only what you are changing. name, description; goal {eventCategory, eventType} = the event that proves success (it exits anyone who reaches it); entry = who is eligible at all (everyone who has not reached the goal yet), as {entity, conditions[], groups[]} using real attributes; membership {type: "locked" (fixed as of launch) | "open" (newly matching customers join), refresh: daily|weekly|monthly}; everyoneElse {approach: "journey" | "none", journey: steps[]} for customers who match no bucket. afterJourney {no_response, not_reachable, declined, converted: days | "leave"} and maxAttempts (the stopping rule) for recurring campaigns. Reasons and notes go in the context (add_context), not here.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        goal: { type: 'object', properties: { eventCategory: { type: 'string' }, eventType: { type: 'string' }, conditions: { type: 'array', items: CONDITION } }, required: ['eventCategory', 'eventType'] },
        entry: { type: 'object', properties: { entity: { type: 'string' }, conditions: { type: 'array', items: CONDITION }, groups: { type: 'array', items: GROUP } }, required: ['entity'] },
        membership: { type: 'object', properties: { type: { type: 'string', enum: ['locked', 'open'] }, refresh: { type: 'string', enum: ['daily', 'weekly', 'monthly'] } }, required: ['type'] },
        everyoneElse: { type: 'object', properties: { approach: { type: 'string', enum: ['journey', 'none'] }, journey: STEPS }, required: ['approach'] },
        maxAttempts: { type: 'number', description: 'Recurring campaigns: the stopping rule. The most times one customer goes through this campaign (usually 2). After their last time they leave for good, whatever their ending.' },
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
    name: 'edit_bucket',
    title: 'Editing a bucket',
    description:
      'Add, change or remove ONE bucket in the CAMPAIGN OBJECT, saved straight to file. Execution fields only: id (short slug), name, priority (lower is checked first; first match wins, so buckets are mutually exclusive), rule (ANDed entity blocks the engine evaluates, using real attributes from list_audience_attributes), holdoutPct (0-30, a no-message share to measure this journey), journey (this bucket\'s own steps). Match by id; when changing, send only what changes. remove: true deletes it. The bucket\'s reasoning (behaviour, thesis, evidence, metric) and its sizing go in the context with add_context. For a small change to a journey use edit_journey.',
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
      'Add entries to the CAMPAIGN CONTEXT, saved straight to file. Nothing is overwritten: a newer entry on the same kind + bucket + topic becomes the current one and the old one is kept as history. Each entry: {kind, topic, bucketId?, text, source: "manager" | "data" | "assumption" | "agent", data?}. Kinds: "brief" (what you concluded or assumed, topic = aspect such as Goal, Success, Incentive, Timing, Guardrails, Membership); "bucket" (with bucketId; topic "behaviour" = plain-language definition, "thesis" = why stuck and the lever, "evidence" with data {level: "measured" | "manager" | "hypothesis"} and the numbers or quotes as text, "metric"); "sizing" (with bucketId, topic "size", data {sql}: warehouse only, a SELECT returning the bucket\'s customer_id values; the app counts it); "research" (what the data showed); "note" (campaign-level reasoning, topic "segmentation", "measurement", "guardrails" or "everyone_else"). The manager\'s answers are filed by the app as kind "answer".',
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
      'Change ONE bucket\'s journey precisely, saved straight to file, without rewriting it: a list of operations, each {op: "replace" | "insert_after" | "insert_before" | "remove", path, step}. path is the step\'s address from get_campaign (e.g. "2", "1.arms.0.steps.3", "4.paths.1.steps.0", "4.otherwise.0"). step is a full step for replace/insert. Use bucketId "everyone_else" for the everyone-else journey. Leave every other step as it is. Rebuild afterwards.',
    input_schema: {
      type: 'object',
      properties: {
        bucketId: { type: 'string' },
        operations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['replace', 'insert_after', 'insert_before', 'remove'] },
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

const WAREHOUSE_TOOLS: ToolDef[] = [
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
      'Run ONE read-only SQLite SELECT (or WITH … SELECT) against the warehouse. Returns up to 200 rows. Aggregate in SQL rather than pulling raw rows. Say in `purpose` what you are trying to learn.',
    input_schema: { type: 'object', properties: { sql: { type: 'string' }, purpose: { type: 'string' } }, required: ['sql', 'purpose'] },
  },
];

export function toolsFor(warehouse: boolean): ToolDef[] {
  if (!warehouse) return BASE_TOOLS;
  const i = BASE_TOOLS.findIndex((t) => t.name === 'build_campaign');
  return [...BASE_TOOLS.slice(0, i), ...WAREHOUSE_TOOLS, ...BASE_TOOLS.slice(i)];
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
  edit_campaign: { running: 'Editing the campaign', done: 'Edited the campaign' },
  edit_bucket: { running: 'Editing a bucket', done: 'Edited a bucket' },
  get_context: { running: 'Reading the context', done: 'Read the context' },
  list_links: { running: "Checking the bank's links", done: "Checked the bank's links" },
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
  if (!out.ok || !env.links || !['edit_bucket', 'edit_journey', 'edit_campaign'].includes(name) || out.state.campaign === state.campaign) return out;
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
        result: added.map((q) => ({ aspect: q.aspect, question: q.text, type: q.answerType, options: q.options ?? [] })),
        forModel: `${added.length} question(s) are on the manager's form${dropped ? ` (${dropped} dropped: missing text)` : ''}. questionsAnswered is now false. If the manager told you anything this turn that is not filed yet, file it now. Then write one or two sentences — what you understood so far — and end your turn. Do not repeat the questions in your message.`,
      };
    }

    case 'get_campaign': {
      const part = typeof input.part === 'string' && input.part.trim() ? input.part.trim() : 'all';
      const view = campaignView(state, part);
      if (!view) return { state, ok: false, forModel: `No part "${part}". Use all, shell, everyone_else, or one of these bucket ids: ${state.campaign.buckets.map((b) => b.id).join(', ') || '(none yet)'}.`, summary: `No part "${part}"` };
      return { state, ok: true, doneTitle: part === 'all' ? 'Read the campaign' : `Read the campaign (${part})`, summary: part, result: view, forModel: JSON.stringify(view) };
    }

    case 'edit_campaign': {
      const res = updateCampaign(state, input);
      if (res.error) return { state, ok: false, forModel: `Not saved: ${res.error}`, summary: res.error };
      const { buckets: _b, ...shell } = res.state.campaign;
      void _b;
      return { state: res.state, ok: true, doneTitle: 'Edited the campaign', summary: res.said, result: shell, forModel: `Saved. ${res.said} Flags now: ${flagLine(res.state)}.` };
    }

    case 'edit_bucket': {
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
        forModel: `Saved. ${res.said} Buckets now: ${res.state.campaign.buckets.map((x) => `${x.priority}. ${x.id}${x.journey?.length ? ' [journey]' : ''}`).join('; ')}.${isNew ? ' File its reasoning (behaviour, thesis, evidence, metric) with add_context.' : ''}`,
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
      const ops = Array.isArray(input.operations) ? input.operations : [];
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
        return {
          state,
          ok: true,
          summary: `${typeof input.purpose === 'string' ? input.purpose : 'Query'} · ${r.rows.length}${r.truncated ? '+' : ''} rows`,
          result: { sql, purpose: input.purpose, rows: r.rows.slice(0, 50), truncated: r.truncated || r.rows.length > 50, ms: r.ms },
          forModel: JSON.stringify({ columns: r.columns, rows: r.rows, truncated: r.truncated }),
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
  let next = state;
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
  next = setFlag(next, 'campaignBuilt', true, 'app', summary);
  next = log(next, 'app', 'campaign_built', `Built: ${summary}${notes.length ? `, ${notes.length} note(s)` : ''}`);
  return {
    state: next,
    ok: true,
    doneTitle: 'Built the campaign',
    summary: `${summary}${notes.length ? ` · ${notes.length} note(s)` : ''}`,
    result: { buckets: compiled.bucketsIncluded, messages: sends, steps: nodes.length, notes, ...(knockOns.length ? { toFix: knockOns } : {}), ...(openEndings.length ? { endingsToDecide: openEndings } : {}) },
    build: { graph: built.graph, campaign, notes },
    forModel: `Built on the canvas as one campaign: ${summary} (buckets: ${compiled.bucketsIncluded.join(', ')}).${notes.length ? ` Notes: ${notes.join(' | ')}` : ' No problems reported.'}${knockOns.length ? ` FIX BEFORE YOU FINISH — a change left these problems further down the tree: ${knockOns.join(' | ')} Fix each one (edit_journey / edit_bucket), build again, and list what you fixed under "Also changed because of this".` : ''}${openEndings.length ? ` ENDINGS NOT DECIDED YET: ${openEndings.join(' | ')} Decide these for the journeys you designed or changed in this conversation turn; for journeys you did not touch, do not change them unasked — mention in one line that their endings are not decided.` : ''} Tell the manager plainly what was built, anything that needs their attention, and that they can ask you to change any bucket or any step.`,
  };
}
