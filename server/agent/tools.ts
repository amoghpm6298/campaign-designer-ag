// The v2 toolkit. Every tool is offered on every turn and none is refused
// because of where the conversation is. The prompt says which tool usually
// fits when; the agent decides.

import { AGENT_TOOLS, runTool, type ToolDef } from '../agentTools';
import { BLUEPRINT_SCHEMA, STEP_DEF } from '../outputTools';
import { buildFromBlueprint, type CampaignBlueprint } from '../blueprint';
import { buildCampaignProposal } from '../../agent-proto/campaignFields';
import { validateCampaignGraph } from '../../agent-proto/validate';
import { bankContext } from '../knowledge';
import type { TenantConfig } from '../tenants';
import type { Channel } from '../../src/data/sharedConstants';
import {
  addQuestions,
  aheadOfFlags,
  isAgentFlag,
  log,
  requestSignoff,
  setFlag,
  signOff,
  updatePlanFile,
  MAX_QUESTIONS_PER_CALL,
} from './state';
import { AGENT_FLAGS, type AgentQuestion, type AgentState } from './types';

const LOOKUP_DONE: Record<string, string> = {
  list_event_types: 'Looked up trigger events',
  list_audience_attributes: 'Looked up customer fields',
  list_channels: 'Checked channels',
  check_template_availability: 'Checked message templates',
  list_step_types: 'Looked up journey step types',
};

export const V2_TOOLS: ToolDef[] = [
  {
    name: 'ask_questions',
    title: 'Putting questions to you',
    description:
      'Ask the manager questions. They appear as a form, grouped by aspect, with tappable answers. Each question asks ONE thing in one short sentence (no examples inside the question: put them in options). Pick answerType per question: "single" (one answer applies), "multi" (several can apply), "open" (only when the realistic answers cannot be listed). For single/multi give 2-6 short options in the manager\'s voice, including "Not sure" or "We don\'t track this" where it fits. Never write "Other": the form always adds it. For open you may give up to 3 example replies. After calling this, write one or two sentences and end your turn: the manager answers in the form.',
    input_schema: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          maxItems: MAX_QUESTIONS_PER_CALL,
          items: {
            type: 'object',
            properties: {
              aspect: { type: 'string', description: 'Short label of the campaign aspect this belongs to, 1-3 words, e.g. "Goal", "Success", "Who", "Why not", "Timing", "Offer".' },
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
    name: 'update_plan_file',
    title: 'Updating the plan file',
    description:
      'Write to the plan file the manager sees. section "brief": findings [{aspect, text, source: "manager"|"assumption"}] — a finding for an aspect replaces the previous one for that aspect — plus an optional one-paragraph summary. section "strategy": {hypothesis, approach, alternative, whyNotAlternative, measurement, risks[]}. section "journey": the full journey recipe {campaignName, description, goal, entry, steps[]} — use real event names, fields and operators from the lookups. Editing a section the manager already signed off re-opens it for sign-off.',
    input_schema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ['brief', 'strategy', 'journey'] },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              aspect: { type: 'string' },
              text: { type: 'string' },
              source: { type: 'string', enum: ['manager', 'assumption'] },
            },
            required: ['aspect', 'text', 'source'],
          },
        },
        replaceFindings: { type: 'boolean', description: 'true replaces all findings instead of merging by aspect.' },
        summary: { type: 'string' },
        strategy: {
          type: 'object',
          properties: {
            hypothesis: { type: 'string' },
            approach: { type: 'string' },
            alternative: { type: 'string' },
            whyNotAlternative: { type: 'string' },
            measurement: { type: 'string' },
            risks: { type: 'array', items: { type: 'string' } },
          },
        },
        journey: { ...BLUEPRINT_SCHEMA },
      },
      required: ['section'],
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
            properties: {
              flag: { type: 'string', enum: AGENT_FLAGS },
              value: { type: 'boolean' },
              reason: { type: 'string' },
            },
            required: ['flag', 'value', 'reason'],
          },
        },
      },
      required: ['changes'],
    },
  },
  {
    name: 'request_signoff',
    title: 'Asking you to sign off',
    description:
      'Mark the brief or the plan ready and ask the manager to sign it off. They see Sign off / Request changes buttons. After calling this, summarise in a few sentences what they are agreeing to and end your turn.',
    input_schema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ['brief', 'plan'] },
        note: { type: 'string', description: 'One line on what is being signed off.' },
      },
      required: ['section'],
    },
  },
  {
    name: 'record_user_acceptance',
    title: 'Noting your approval',
    description:
      'The manager approved the brief or plan in chat instead of clicking Sign off (e.g. "looks good, go ahead"). Record it with their exact words.',
    input_schema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ['brief', 'plan'] },
        quote: { type: 'string', description: 'Their words, verbatim.' },
      },
      required: ['section', 'quote'],
    },
  },
  ...AGENT_TOOLS,
  {
    name: 'build_campaign',
    title: 'Building the campaign',
    description:
      'Build the journey in the plan file as a real campaign on the canvas. Optionally pass a journey to save and build in one step. Returns what was built and any problems; fix the journey with update_plan_file and build again if needed.',
    input_schema: {
      type: 'object',
      properties: { journey: { ...BLUEPRINT_SCHEMA } },
      $defs: { step: STEP_DEF },
    },
  },
];

export const V2_TOOL_TITLES: Record<string, { running: string; done: string }> = {
  ...Object.fromEntries(AGENT_TOOLS.map((t) => [t.name, { running: t.title, done: LOOKUP_DONE[t.name] ?? t.title }])),
  ask_questions: { running: 'Putting questions to you', done: 'Asked you questions' },
  update_plan_file: { running: 'Updating the plan file', done: 'Updated the plan file' },
  set_flags: { running: 'Updating progress', done: 'Updated progress' },
  request_signoff: { running: 'Asking you to sign off', done: 'Asked you to sign off' },
  record_user_acceptance: { running: 'Noting your approval', done: 'Noted your approval' },
  build_campaign: { running: 'Building the campaign', done: 'Built the campaign' },
};

export interface ToolEnv {
  tenant: TenantConfig;
  availableChannels: Channel[];
  goalStatement: string;
  sessionId: string;
  /** Lookup results already fetched this turn, keyed by name+input. */
  lookupCache: Map<string, unknown>;
}

export interface ToolOutcome {
  state: AgentState;
  /** What goes back to the model as the tool_result. */
  forModel: string;
  /** One line for the activity row. */
  summary: string;
  /** Overrides the row title, e.g. "Asked you 9 questions". */
  doneTitle?: string;
  ok: boolean;
  /** Structured result shown in the expanded row. */
  result?: unknown;
  /** Set when this call asked questions. */
  asked?: AgentQuestion[];
  /** Set when this call should end the turn (questions asked, sign-off requested). */
  endsTurn?: boolean;
  build?: { graph: unknown; campaign: unknown; notes: string[] };
}

const flagLine = (s: AgentState) =>
  Object.entries(s.flags)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');

export function runV2Tool(name: string, input: Record<string, unknown>, state: AgentState, env: ToolEnv): ToolOutcome {
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
        forModel: `${added.length} question(s) are on the manager's form${dropped ? ` (${dropped} dropped: missing text)` : ''}. questionsAnswered is now false. If the manager told you anything this turn that is not in the brief yet, file it now (update_plan_file, set_flags). Then write one or two sentences — what you understood so far — and end your turn. Do not repeat the questions in your message.`,
      };
    }

    case 'update_plan_file': {
      const res = updatePlanFile(state, input);
      if (res.error) return { state, ok: false, forModel: `Not saved: ${res.error}`, summary: res.error };
      let next = res.state;
      if (input.section === 'strategy' || input.section === 'journey') {
        const ahead = aheadOfFlags(state, 'plan');
        if (ahead && !state.timeline.some((t) => t.type === 'acted_ahead_of_flags' && t.note === ahead)) next = log(next, 'app', 'acted_ahead_of_flags', ahead);
      }
      const section = String(input.section);
      return {
        state: next,
        ok: true,
        doneTitle: `Updated the ${section}`,
        summary: res.said,
        result: section === 'brief' ? next.planFile.brief : section === 'strategy' ? next.planFile.strategy : { steps: (next.planFile.journey?.blueprint.steps ?? []).length },
        forModel: `${res.said} Flags now: ${flagLine(next)}.`,
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

    case 'request_signoff': {
      const section = input.section === 'plan' ? 'plan' : 'brief';
      const next = requestSignoff(state, section, typeof input.note === 'string' ? input.note : '');
      return {
        state: next,
        ok: true,
        endsTurn: true,
        doneTitle: `Asked you to sign off the ${section}`,
        summary: typeof input.note === 'string' ? input.note : '',
        forModel: `The manager now sees Sign off / Request changes for the ${section}. Summarise what they are agreeing to in a few sentences and end your turn. Do not call more tools.`,
      };
    }

    case 'record_user_acceptance': {
      const section = input.section === 'plan' ? 'plan' : 'brief';
      const quote = typeof input.quote === 'string' ? input.quote.trim() : '';
      const next = signOff(state, section, 'agent', quote ? `"${quote}"` : '');
      return {
        state: next,
        ok: true,
        doneTitle: `Noted your approval of the ${section}`,
        summary: quote,
        forModel: `${section === 'brief' ? 'briefSignedOff' : 'planSignedOff'} is now true. Flags now: ${flagLine(next)}.`,
      };
    }

    case 'build_campaign':
      return buildCampaign(input, state, env);

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

function buildCampaign(input: Record<string, unknown>, state: AgentState, env: ToolEnv): ToolOutcome {
  let next = state;
  if (input.journey && typeof input.journey === 'object') {
    const saved = updatePlanFile(next, { section: 'journey', journey: input.journey });
    if (saved.error) return { state, ok: false, forModel: `Not built: ${saved.error}`, summary: saved.error };
    next = saved.state;
  }
  const bp = next.planFile.journey?.blueprint as CampaignBlueprint | undefined;
  if (!bp) return { state: next, ok: false, forModel: 'There is no journey in the plan file yet. Write one with update_plan_file(section: "journey") or pass it here.', summary: 'No journey to build' };

  const ahead = aheadOfFlags(next, 'build');
  if (ahead) next = log(next, 'app', 'acted_ahead_of_flags', ahead);

  let built;
  try {
    built = buildFromBlueprint(bp, { availableChannels: env.availableChannels, templateLibraryAccess: env.tenant.templateLibraryAccess === 'synthetic-demo' ? 'synthetic-demo' : 'unavailable' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    next = log(next, 'app', 'build_failed', msg);
    return { state: next, ok: false, forModel: `The build engine failed: ${msg}. Check the journey and try again.`, summary: 'Build failed' };
  }
  const nodeCount = Object.keys(built.graph.nodes ?? {}).length;
  const sends = Object.values(built.graph.nodes ?? {}).filter((n) => (n as { type?: string }).type === 'SEND').length;

  const proposal = buildCampaignProposal({
    scenarioId: env.sessionId,
    goalStatement: env.goalStatement,
    goal: built.goal,
    graph: built.graph,
    tenantContext: { tenantId: env.tenant.tenantId, issuer: env.tenant.issuer },
  });
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
    ...built.issues.map((i) => `${i.path}: ${i.problem}`),
    ...built.limitations.map((l) => `Cannot express ${l.attribute}: ${l.note}`),
    ...validationLines,
    ...(built.sendProposals.length ? [`${built.sendProposals.length} message step(s) need the bank's real template id before export.`] : []),
  ];

  if (nodeCount <= 1) {
    next = log(next, 'app', 'build_failed', 'The build produced no journey');
    return { state: next, ok: false, forModel: `Nothing was built. Problems: ${notes.join(' | ') || 'none reported'}. Fix the journey and build again.`, summary: 'Nothing built', result: notes };
  }
  next = setFlag(next, 'campaignBuilt', true, 'app', `${sends} messages, ${nodeCount} steps`);
  next = log(next, 'app', 'campaign_built', `Built: ${sends} messages, ${nodeCount} steps${notes.length ? `, ${notes.length} note(s)` : ''}`);
  return {
    state: next,
    ok: true,
    doneTitle: 'Built the campaign',
    summary: `${sends} messages, ${nodeCount} steps${notes.length ? ` · ${notes.length} note(s)` : ''}`,
    result: { messages: sends, steps: nodeCount, notes },
    build: { graph: built.graph, campaign, notes },
    forModel: `Built on the canvas: ${sends} message steps, ${nodeCount} steps in total.${notes.length ? ` Notes: ${notes.join(' | ')}` : ' No problems reported.'} Tell the manager plainly what was built and anything that needs their attention.`,
  };
}
