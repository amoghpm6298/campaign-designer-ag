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
import { planToBlueprint } from './compile';
import {
  addQuestions,
  editJourney,
  isAgentFlag,
  log,
  MAX_QUESTIONS_PER_CALL,
  outline,
  removeBucket,
  setBucketSize,
  setFlag,
  updateBrief,
  updateCampaign,
  upsertBucket,
} from './state';
import { AGENT_FLAGS, type AgentQuestion, type AgentState } from './types';
import type { BpStep } from '../blueprint';

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
      'Ask the manager questions. They appear as a form, grouped by aspect, with tappable answers. Each question asks ONE thing in one short sentence (no examples inside the question: put them in options). answerType: "single" (one answer applies), "multi" (several can apply), "open" (only when the realistic answers cannot be listed). For single/multi give 2-6 short options in the manager\'s voice, including "Not sure" or "We don\'t track this" where it fits. Never write "Other": the form always adds it. For open you may give up to 3 example replies. After calling this, file anything outstanding, write one or two sentences and end your turn.',
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
              answerType: { type: 'string', enum: ['single', 'multi', 'open'] },
              options: { type: 'array', items: { type: 'string' }, maxItems: 6 },
              suggestions: { type: 'array', items: { type: 'string' }, maxItems: 3 },
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
      'Read the campaign as it is saved on file. part: "all" (default: brief, campaign shell and every bucket with its journey outline), "brief", "shell", "everyone_else", or a bucket id (that bucket in full, with its journey and each step\'s address). Read before you change something you have not looked at this turn.',
    input_schema: { type: 'object', properties: { part: { type: 'string' } } },
  },
  {
    name: 'edit_campaign',
    title: 'Editing the campaign',
    description:
      'Change campaign-level settings, saved straight to file. Send only what you are changing. brief: what you have learned {findings: [{aspect, text, source: "manager" | "data" | "assumption"}], summary}. name, description; goal {eventCategory, eventType} = the event that proves success (it exits anyone who reaches it); entry = who is eligible at all (everyone who has not reached the goal yet), as {entity, conditions[], groups[]} using real attributes; membership {type: "locked" (fixed as of launch) | "open" (newly matching customers join), refresh: daily|weekly|monthly}; segmentationLogic (why these buckets, in this priority order); guardrails; measurement; everyoneElse {approach: "journey" | "none", why, journey: steps[]} for customers who match no bucket.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        description: { type: 'string' },
        goal: { type: 'object', properties: { eventCategory: { type: 'string' }, eventType: { type: 'string' }, conditions: { type: 'array', items: CONDITION } }, required: ['eventCategory', 'eventType'] },
        entry: { type: 'object', properties: { entity: { type: 'string' }, conditions: { type: 'array', items: CONDITION }, groups: { type: 'array', items: GROUP } }, required: ['entity'] },
        membership: { type: 'object', properties: { type: { type: 'string', enum: ['locked', 'open'] }, refresh: { type: 'string', enum: ['daily', 'weekly', 'monthly'] } }, required: ['type'] },
        segmentationLogic: { type: 'string' },
        guardrails: { type: 'string' },
        measurement: { type: 'string' },
        brief: {
          type: 'object',
          description: 'What you have learned, filed by aspect. A finding for an aspect replaces the previous one for that aspect.',
          properties: {
            findings: {
              type: 'array',
              items: {
                type: 'object',
                properties: { aspect: { type: 'string' }, text: { type: 'string' }, source: { type: 'string', enum: ['manager', 'data', 'assumption'] } },
                required: ['aspect', 'text', 'source'],
              },
            },
            replaceFindings: { type: 'boolean' },
            summary: { type: 'string' },
          },
        },
        everyoneElse: { type: 'object', properties: { approach: { type: 'string', enum: ['journey', 'none'] }, why: { type: 'string' }, journey: STEPS }, required: ['approach'] },
      },
      $defs: { step: STEP_DEF },
    },
  },
  {
    name: 'edit_bucket',
    title: 'Editing a bucket',
    description:
      'Add, change or remove ONE behavioural bucket, saved straight to file. Match by id; when changing, send only the fields you are changing. remove: true deletes it (with a reason). Fields: id (short slug), name, priority (lower is checked first; first match wins, so buckets are mutually exclusive), behaviour (plain-language definition), rule (ANDed entity blocks the builder evaluates, using real attributes from list_audience_attributes), sql (warehouse only: a SELECT returning the bucket\'s customer_id values, used to size it), evidence ("measured" from data, "manager" said it, "hypothesis" your judgement), evidenceNotes (the numbers or quotes behind it), thesis (why they are stuck and the lever that moves them), metric, holdoutPct (0-30, a no-message arm to measure this journey), journey (this bucket\'s own steps). Changing a bucket\'s definition normally means re-thinking its thesis and journey too; for a small change to a journey use edit_journey instead.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
        priority: { type: 'number' },
        behaviour: { type: 'string' },
        rule: { type: 'array', items: GROUP },
        sql: { type: 'string' },
        evidence: { type: 'string', enum: ['measured', 'manager', 'hypothesis'] },
        evidenceNotes: { type: 'string' },
        thesis: { type: 'string' },
        metric: { type: 'string' },
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
      'Change ONE bucket\'s journey precisely, saved straight to file, without rewriting it: a list of operations, each {op: "replace" | "insert_after" | "insert_before" | "remove", path, step}. path is the step\'s address from get_campaign (e.g. "2", "1.arms.0.steps.3", "4.paths.1.steps.0"). step is a full step for replace/insert. Use bucketId "everyone_else" for the everyone-else journey. Leave every other step as it is. Rebuild afterwards.',
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
 * The campaign as get_campaign returns it. Journeys come with each step's
 * address, which is what edit_journey takes.
 */
export function campaignView(state: AgentState, part: string): unknown | null {
  const pf = state.planFile;
  const c = pf.campaign;
  const withOutline = (steps: BpStep[] | null | undefined) => (steps?.length ? { journey: steps, outline: outline(steps) } : { journey: null });
  const shell = c ? { ...c, everyoneElse: c.everyoneElse ? { approach: c.everyoneElse.approach, why: c.everyoneElse.why, outline: outline(c.everyoneElse.journey ?? []) } : null } : null;
  if (part === 'brief') return pf.brief;
  if (part === 'shell') return shell;
  if (part === 'everyone_else') return c?.everyoneElse ? { approach: c.everyoneElse.approach, why: c.everyoneElse.why, ...withOutline(c.everyoneElse.journey) } : null;
  if (part === 'all')
    return {
      brief: pf.brief,
      campaign: shell,
      buckets: pf.buckets.map(({ journey, ...b }) => ({ ...b, outline: journey?.length ? outline(journey) : null })),
      built: state.flags.campaignBuilt,
    };
  const b = pf.buckets.find((x) => x.id === part);
  return b ? { ...b, ...withOutline(b.journey) } : null;
}

export function runToolCall(name: string, input: Record<string, unknown>, state: AgentState, env: ToolEnv): ToolOutcome {
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
        result: added.map((q) => ({ aspect: q.aspect, question: q.text, type: q.answerType, options: q.options ?? q.suggestions ?? [] })),
        forModel: `${added.length} question(s) are on the manager's form${dropped ? ` (${dropped} dropped: missing text)` : ''}. questionsAnswered is now false. If the manager told you anything this turn that is not filed yet, file it now. Then write one or two sentences — what you understood so far — and end your turn. Do not repeat the questions in your message.`,
      };
    }

    case 'get_campaign': {
      const part = typeof input.part === 'string' && input.part.trim() ? input.part.trim() : 'all';
      const view = campaignView(state, part);
      if (!view) return { state, ok: false, forModel: `No part "${part}". Use all, brief, shell, everyone_else, or one of these bucket ids: ${state.planFile.buckets.map((b) => b.id).join(', ') || '(none yet)'}.`, summary: `No part "${part}"` };
      return { state, ok: true, doneTitle: part === 'all' ? 'Read the campaign' : `Read the campaign (${part})`, summary: part, result: view, forModel: JSON.stringify(view) };
    }

    case 'edit_campaign': {
      const { brief, ...shell } = input as { brief?: Record<string, unknown> } & Record<string, unknown>;
      const hasShell = Object.values(shell).some((v) => v !== undefined);
      if (!brief && !hasShell) return { state, ok: false, forModel: 'Nothing to change: send brief and/or the campaign fields you are changing.', summary: 'Nothing to change' };
      let next = state;
      const said: string[] = [];
      if (brief) {
        const res = updateBrief(next, brief);
        if (res.error) return { state, ok: false, forModel: `Not saved: ${res.error}`, summary: res.error };
        next = res.state;
        said.push(res.said);
      }
      if (hasShell) {
        const res = updateCampaign(next, shell);
        if (res.error) return { state, ok: false, forModel: `Not saved: ${res.error}`, summary: res.error };
        next = res.state;
        said.push(res.said);
      }
      return {
        state: next,
        ok: true,
        doneTitle: hasShell ? 'Edited the campaign' : 'Updated the brief',
        summary: said.join(' '),
        result: { ...(brief ? { brief: next.planFile.brief } : {}), ...(hasShell ? { campaign: next.planFile.campaign } : {}) },
        forModel: `Saved. ${said.join(' ')} Flags now: ${flagLine(next)}.`,
      };
    }

    case 'edit_bucket': {
      if (input.remove === true) {
        const res = removeBucket(state, String(input.id ?? ''), typeof input.reason === 'string' ? input.reason : '');
        if (res.error) return { state, ok: false, forModel: res.error, summary: res.error };
        return { state: res.state, ok: true, doneTitle: 'Removed a bucket', summary: String(input.id), forModel: `Removed and saved. Buckets now: ${res.state.planFile.buckets.map((x) => x.id).join(', ') || 'none'}.` };
      }
      const { remove: _r, reason: _why, ...fields } = input;
      void _r;
      void _why;
      const isNew = !state.planFile.buckets.some((b) => b.id === fields.id);
      let next = state;
      const res = upsertBucket(next, fields);
      if (res.error || !res.bucket) return { state, ok: false, forModel: `Not saved: ${res.error}`, summary: res.error ?? 'Not saved' };
      next = res.state;
      let sizeLine = '';
      if (env.warehouseBank && res.bucket.sql && res.bucket.size === undefined) {
        try {
          const n = countCustomers(env.warehouseBank, res.bucket.sql);
          next = setBucketSize(next, res.bucket.id, n);
          sizeLine = ` Sized from your SQL: ${n.toLocaleString('en-IN')} customers.`;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          next = setBucketSize(next, res.bucket.id, null, msg);
          sizeLine = ` Its SQL failed, so it is not sized: ${msg}. Fix the sql and edit the bucket again.`;
        }
      }
      const b = next.planFile.buckets.find((x) => x.id === res.bucket!.id)!;
      return {
        state: next,
        ok: true,
        doneTitle: `${isNew ? 'Added' : 'Updated'} bucket "${b.name}"`,
        summary: [b.size !== undefined ? `${b.size.toLocaleString('en-IN')} customers` : '', b.evidence, b.journey?.length ? `${b.journey.length}-step journey` : ''].filter(Boolean).join(' · '),
        result: { name: b.name, priority: b.priority, behaviour: b.behaviour, evidence: b.evidence, size: b.size, thesis: b.thesis, rule: b.rule, journeySteps: b.journey?.length ?? 0 },
        forModel: `Saved. ${res.said}${sizeLine} Buckets now: ${next.planFile.buckets.map((x) => `${x.priority}. ${x.id}${x.size !== undefined ? ` (${x.size})` : ''}${x.journey?.length ? ' [journey]' : ''}`).join('; ')}.`,
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

function buildCampaign(state: AgentState, env: ToolEnv): ToolOutcome {
  let next = state;
  const compiled = planToBlueprint(next.planFile);
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
    validationLines = validation.checks.filter((c) => c.status === 'fail').map((c) => `Check failed: ${c.detail ?? c.id}`);
  } catch (e) {
    validationLines = [`Validation could not run: ${e instanceof Error ? e.message : String(e)}`];
  }

  const notes = [
    ...compiled.problems,
    ...built.issues.map((i) => `${i.path}: ${i.problem}`),
    ...built.limitations.map((l) => `Cannot express ${l.attribute}: ${l.note}`),
    ...validationLines,
    ...(built.sendProposals.length ? [`${built.sendProposals.length} message step(s) need the bank's real template id before export.`] : []),
  ];

  if (nodes.length <= 1) {
    next = log(next, 'app', 'build_failed', 'The build produced no journey');
    return { state: next, ok: false, forModel: `Nothing was built. Problems: ${notes.join(' | ') || 'none reported'}. Fix the plan and build again.`, summary: 'Nothing built', result: notes };
  }
  const summary = `${compiled.bucketsIncluded.length} buckets, ${sends} messages, ${nodes.length} steps`;
  next = setFlag(next, 'campaignBuilt', true, 'app', summary);
  next = log(next, 'app', 'campaign_built', `Built: ${summary}${notes.length ? `, ${notes.length} note(s)` : ''}`);
  return {
    state: next,
    ok: true,
    doneTitle: 'Built the campaign',
    summary: `${summary}${notes.length ? ` · ${notes.length} note(s)` : ''}`,
    result: { buckets: compiled.bucketsIncluded, messages: sends, steps: nodes.length, notes },
    build: { graph: built.graph, campaign, notes },
    forModel: `Built on the canvas as one campaign: ${summary} (buckets: ${compiled.bucketsIncluded.join(', ')}).${notes.length ? ` Notes: ${notes.join(' | ')}` : ' No problems reported.'} Tell the manager plainly what was built, anything that needs their attention, and that they can ask you to change any bucket or any step.`,
  };
}
