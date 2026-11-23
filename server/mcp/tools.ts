// The MCP's tools: a thin door onto the same agent the app uses. Every
// campaign made here is an ordinary campaign: same files, same chat, same
// canvas link. The caller's agent never designs anything itself.
import type { AgentQuestion, AgentState } from '../agent/types';
import { copyCampaign, deleteCampaign, findDeleted, listCampaigns, loadChat, loadEngineCampaign, loadStores, loadSubmission, loadWithdrawals, withdrawCampaign, LOCKED } from '../campaignFiles';
import { campaignCost } from '../costModel';
import { resolveTenant } from '../tenants';
import { toEngineCampaign } from '../engineExport';
import { currentEntries } from '../../src/designer/v2/contextView';
import type { AnswerItem } from '../../src/designer/v2/types';
import { isRunning, runningStep, startTurn, waitForTurn, type StoredChat } from './runner';
import { campaignBrief } from './brief';
import { submitChecked } from '../submit';
import { campaignDetails } from './details';
import { submittedStage } from '../../src/designer/v2/lifecycle';
import { scheduleText } from '../agent/schedule';
import { VIEW_HOURS, makeViewToken } from '../viewLinks';

/** Who is calling: the shared token's label and the one bank it may work on. */
export interface Caller {
  label: string;
  tenantId: string;
  /** e.g. https://ai.product.hyperface.co/campaigndesigneragent */
  appUrl: string;
}

type Result = Record<string, unknown>;
class ToolError extends Error {}

/**
 * The canvas link. With LINK_SECRET set it is a signed view link: this one
 * campaign, read-only, no password, for 24 hours. Every call hands out a fresh one.
 */
const linkInfo = (c: Caller, id: string): { link: string; linkExpiresAt?: string; linkNote: string } => {
  const plainLink = `${c.appUrl}/designer.html?c=${encodeURIComponent(id)}&bank=${encodeURIComponent(c.tenantId)}`;
  const secret = process.env.LINK_SECRET;
  if (!secret) return { link: plainLink, linkNote: 'Opening it needs the app password.' };
  const token = makeViewToken(secret, id);
  return {
    link: `${plainLink}&view=${token}`,
    linkExpiresAt: new Date(Number(token.split('.')[0]) * 1000).toISOString(),
    linkNote: `Opens this campaign read-only, no password needed, for ${VIEW_HOURS} hours. After that, call get_link for a fresh one.`,
  };
};
const newId = () => `cv-${Date.now().toString(36)}`;
const plain = (s: string) => s.replace(/\*\*/g, '');

const QUESTION_TYPES: Record<string, string> = { yesno: 'yesno', single: 'single', multi: 'multi', open: 'multi' };

export const MCP_TOOLS = [
  {
    name: 'create_campaign',
    description:
      'Create a new campaign for the bank this token is set up for. Hyperface\'s campaign designer designs it (buckets of customers and a message journey for each); with questions: "ask" it may first come back with clarifying questions, with "assume" it decides those itself and builds. Returns at once with a campaignId and a canvas link; then follow it with get_campaign. Put everything you know into brief: the more it has, the fewer questions and the better the design. Before calling, ask your human whether they have any data to share, and include it: it is the single biggest improvement to the design.',
    inputSchema: {
      type: 'object',
      properties: {
        brief: {
          type: 'string',
          description:
            'The campaign brief. Anything from one line ("get dormant cardholders spending again before Diwali") to a full brief: goal, audience, how success is judged, any incentive that already exists (exact terms), timing and dates, message limits, notes, constraints, past results, data, or a whole pasted document. Long is fine. DATA HELPS MOST: segment or customer counts, spend or usage patterns, past campaign results (sent, response, conversion by channel), activation or dormancy rates, opt-in rates, top spend categories. The designer uses it to shape and size the buckets and journeys, and marks them as based on your data; it never invents numbers itself.',
        },
        questions: {
          type: 'string',
          enum: ['ask', 'assume'],
          description: '"ask" (default): the designer may come back with clarifying questions (get_campaign then lists them, with answer_questions allowed). "assume": no questions come back; it makes its own calls, lists them as assumptions, and builds straight away. Choose "assume" when your human wants a first draft fast or cannot answer now; they can still correct anything with request_changes.',
        },
      },
      required: ['brief'],
    },
  },
  {
    name: 'get_campaign',
    description:
      'Where a campaign is. Every campaign response has state and allowedActions. state is one of: "draft" (being designed: the designer is working, has questions for you, or replied), "ready" (designed and built), "scheduled" / "active" / "ended" (submitted for execution and locked: before, between or after its dates), "deleted". allowedActions lists the only tools you may call next for it (get_campaign, get_link and list_campaigns are always allowed); when it is empty the designer is working, so call again. In draft with questions, they are listed with options and why; when ready or submitted there is a brief (summary, dates, buckets, journeys, assumptions) to tell your human what was built. waitSeconds (up to 50) waits for the designer before answering: poll with it, not in a tight loop. A design usually takes 3-7 minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        campaignId: { type: 'string' },
        waitSeconds: { type: 'number', description: 'Wait up to this many seconds (max 50) while the agent is working.' },
        details: {
          type: 'boolean',
          description:
            'true: also return the full design under "details", along with the brief: every setting (goal, entry rules, dates, membership, stopping rule, what happens after the journey), every bucket\'s rule and reasoning, every step of every journey (message copy, CTA, link, channel, timing, waits, goal checks, branches and their paths, A/B arms, endings), the designer\'s notebook (your answers, its notes and assumptions per topic, campaign-level reasoning, research; each with its source), and the version history. Large (often 20-60 KB): use it only when your human wants to inspect or review the design itself, not for routine status checks.',
        },
      },
      required: ['campaignId'],
    },
  },
  {
    name: 'answer_questions',
    description:
      'Answer the agent\'s questions (listed by get_campaign when allowedActions includes answer_questions). Answer with one of the question\'s options, or any text of your own. Ask your human when you do not know; never invent business facts (incentives, limits, dates). Skipped or unanswered questions are assumed by the agent, which says what it assumed. Returns at once; then poll get_campaign.',
    inputSchema: {
      type: 'object',
      properties: {
        campaignId: { type: 'string' },
        answers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Question id → answer text.' },
        skip: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string', enum: ['all'] }], description: 'Question ids to skip, or "all".' },
      },
      required: ['campaignId'],
    },
  },
  {
    name: 'request_changes',
    description:
      'Ask the agent to change a campaign, in plain words, exactly as a person would in the app ("make the dormant bucket SMS-first", "drop the email retry"). Also how to reply when the agent asked something in its message. Returns at once; then poll get_campaign.',
    inputSchema: { type: 'object', properties: { campaignId: { type: 'string' }, request: { type: 'string' } }, required: ['campaignId', 'request'] },
  },
  {
    name: 'submit_campaign',
    description:
      'Submit a ready campaign for execution. Only call this after your human has explicitly said the campaign is good to go, and has confirmed its start and end dates (shown in the brief). Pass startDate and endDate (YYYY-MM-DD) if the campaign has none or your human wants different ones: the start must be today or later, the end after the start; a recurring campaign can use a far-off end date. Refused if a journey does not fit between the dates. It locks the campaign: no further changes (stop_campaign to change it).',
    inputSchema: {
      type: 'object',
      properties: {
        campaignId: { type: 'string' },
        startDate: { type: 'string', description: 'YYYY-MM-DD, today or later. Optional if the campaign already has dates.' },
        endDate: { type: 'string', description: 'YYYY-MM-DD, after startDate. Optional if the campaign already has dates.' },
      },
      required: ['campaignId'],
    },
  },
  {
    name: 'copy_campaign',
    description:
      'Make a new editable draft from an existing campaign (any state, even submitted), then adapt it with request_changes. The copy keeps the campaign, the designer\'s reasoning and the chat, so the designer adapts it instead of starting over; the original is never changed. ' +
      'USE IT when your human wants a variant of something that already exists: the same campaign for a new season or month ("make this the Christmas version"), a different audience or bank segment with the same idea, a different channel mix or cadence, or an A/B alternative to compare with the original. Also to change a submitted campaign while leaving it running as it is. ' +
      'DO NOT use it when the goal itself is different (e.g. from card activation to EMI conversion): the buckets were built around the old goal, so create_campaign gives a cleaner design. Same bank only. Returns the new campaignId and link; name is optional (default "Copy of …").',
    inputSchema: { type: 'object', properties: { campaignId: { type: 'string' }, name: { type: 'string', description: 'Name for the copy, e.g. "Christmas Dormant Reactivation".' } }, required: ['campaignId'] },
  },
  {
    name: 'stop_campaign',
    description:
      'Stop a submitted (scheduled or active) campaign. It goes back to ready: editable again (request_changes works), and submit_campaign can send it out again later with new dates. Customers\' progress is not kept, so submitting again starts it fresh. Only after your human asks for it. Who stopped it and when is recorded.',
    inputSchema: { type: 'object', properties: { campaignId: { type: 'string' } }, required: ['campaignId'] },
  },
  {
    name: 'delete_campaign',
    description:
      'Delete a campaign that has NOT been submitted (a draft, e.g. a test). Refused for a submitted campaign: stop it first. Only after your human asks for it. It disappears from the list and its links stop working; Hyperface keeps a copy, so a mistaken delete can be recovered by the Smart Engage team.',
    inputSchema: { type: 'object', properties: { campaignId: { type: 'string' } }, required: ['campaignId'] },
  },
  {
    name: 'get_link',
    description: 'A fresh canvas link for a campaign. Links open the campaign read-only with no password for 24 hours; call this when one has expired.',
    inputSchema: { type: 'object', properties: { campaignId: { type: 'string' } }, required: ['campaignId'] },
  },
  {
    name: 'list_campaigns',
    description: 'Every campaign for this token\'s bank, newest first, with its state, allowedActions, dates and canvas link.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function chatFor(caller: Caller, id: string): StoredChat {
  if (typeof id !== 'string' || !id) throw new ToolError('campaignId is required.');
  let chat: StoredChat | null;
  try {
    chat = loadChat(id) as StoredChat | null;
  } catch {
    throw new ToolError(`No campaign "${id}".`);
  }
  if (!chat && !isRunning(id)) throw new ToolError(`No campaign "${id}".`);
  if (chat && chat.tenantId !== caller.tenantId) throw new ToolError(`No campaign "${id}" for this bank.`);
  return chat ?? { sessionId: id, tenantId: caller.tenantId, turns: [], state: null };
}

/** The questions the agent is waiting on: asked in its last message and not answered yet. */
function openQuestions(chat: StoredChat): AgentQuestion[] {
  const last = [...chat.turns].reverse().find((t) => t.role === 'assistant');
  const asked = new Set((last?.questions ?? []).map((q) => q.id));
  return ((chat.state as AgentState | null)?.questions ?? []).filter((q) => asked.has(q.id) && !q.answer?.trim());
}

/** The one vocabulary for where a campaign is. */
export type CampaignState = 'draft' | 'ready' | 'scheduled' | 'active' | 'ended' | 'deleted';

/** What the caller may do next, per state (get_campaign, get_link and list_campaigns are always available). */
const ACTIONS = {
  working: [] as string[],
  questions: ['answer_questions', 'request_changes', 'delete_campaign'],
  draft: ['request_changes', 'delete_campaign'],
  ready: ['request_changes', 'submit_campaign', 'copy_campaign', 'delete_campaign'],
  scheduled: ['stop_campaign', 'copy_campaign'],
  active: ['stop_campaign', 'copy_campaign'],
  ended: ['copy_campaign'],
  deleted: [] as string[],
};

const stageOf = (sub: Parameters<typeof submittedStage>[0]): 'scheduled' | 'active' | 'ended' => {
  const st = submittedStage(sub);
  return st === 'submitted' ? 'active' : st; // submitted before dates existed: treat as running
};

/** A deleted campaign of this bank, if there is one. */
function deletedState(caller: Caller, id: string): Result | null {
  const d = findDeleted(id);
  if (!d || d.tenantId !== caller.tenantId) return null;
  return { campaignId: id, state: 'deleted', deletedAt: d.deletedAt, allowedActions: ACTIONS.deleted, message: 'This campaign was deleted. The Smart Engage team can recover it if that was a mistake.' };
}

export function campaignStatus(caller: Caller, id: string): Result {
  let chat: StoredChat;
  try {
    chat = chatFor(caller, id);
  } catch (e) {
    const gone = deletedState(caller, id);
    if (gone) return gone;
    throw e;
  }
  const base: Result = { campaignId: id, ...linkInfo(caller, id) };
  const sub = loadSubmission(id);
  if (sub) {
    const st = loadStores(id);
    const state = stageOf(sub);
    return {
      ...base,
      state,
      allowedActions: ACTIONS[state],
      submittedAt: sub.at,
      submittedBy: sub.by,
      startDate: sub.startDate,
      endDate: sub.endDate,
      brief: st.campaign ? campaignBrief(st.campaign, st.context, campaignCost(st.campaign, st.context, resolveTenant(caller.tenantId))) : null,
    };
  }
  const ws = loadWithdrawals(id);
  if (ws.length) Object.assign(base, { lastStopped: { at: ws[ws.length - 1].at, by: ws[ws.length - 1].by } });
  const flags = (chat.state as AgentState | null)?.flags;
  // Ready means built AND up to date: a turn that stopped with unbuilt changes is not ready to submit.
  const wasBuilt = flags ? !!flags.campaignBuilt : !!chat.lastBuilt;
  const unfinished = !!flags && !flags.campaignBuilt && !!chat.lastBuilt;
  if (isRunning(id)) return { ...base, state: 'draft', allowedActions: ACTIONS.working, doing: runningStep(id), next: 'The designer is working. Call get_campaign with waitSeconds: 50.' };
  const last = [...chat.turns].reverse().find((t) => t.role === 'assistant');
  if (!last) return { ...base, state: 'draft', allowedActions: ACTIONS.working, doing: 'Starting', next: 'Call get_campaign with waitSeconds: 50.' };
  if (last.error) return { ...base, state: 'draft', allowedActions: ACTIONS.draft, error: last.error, next: 'Something failed. Try request_changes again; if it keeps failing, tell your human.' };
  const message = plain(last.content ?? '');
  const open = openQuestions(chat);
  if (open.length)
    return {
      ...base,
      state: 'draft',
      allowedActions: ACTIONS.questions,
      message,
      questions: open.map((q) => ({
        id: q.id,
        topic: q.aspect,
        question: plain(q.text),
        ...(q.why ? { why: q.why } : {}),
        type: QUESTION_TYPES[q.answerType] ?? 'single',
        options: q.answerType === 'yesno' ? ['Yes', 'No'] : q.options ?? [],
        otherAllowed: true,
      })),
      next: 'Relay these questions to your human and send the answers with answer_questions (skip what they do not know).',
    };
  if (unfinished)
    return {
      ...base,
      state: 'draft',
      allowedActions: ACTIONS.draft,
      message,
      next: 'The designer stopped before finishing: its latest changes are not built yet. Send request_changes with "continue" to let it finish, then get_campaign.',
    };
  if (wasBuilt) {
    const stores = loadStores(id);
    const c = stores.campaign;
    const summary = listCampaigns(caller.tenantId).find((x) => x.sessionId === id);
    return {
      ...base,
      state: 'ready',
      allowedActions: ACTIONS.ready,
      name: c?.name ?? summary?.name,
      message,
      brief: c ? campaignBrief(c, stores.context, campaignCost(c, stores.context, resolveTenant(caller.tenantId))) : null,
      assumptions: currentEntries(stores.context?.entries ?? [], { kind: 'brief' })
        .filter((e) => e.source === 'assumption')
        .map((e) => `${e.topic}: ${e.text}`),
      version: summary?.version ?? 0,
      next: 'Show your human the summary, dates and link. Send changes with request_changes; submit only when they say it is good to go and confirm the dates.',
    };
  }
  return { ...base, state: 'draft', allowedActions: ACTIONS.draft, message, next: 'The designer replied without building. Relay its message and answer with request_changes.' };
}

export async function callTool(caller: Caller, name: string, args: Record<string, unknown>): Promise<Result> {
  switch (name) {
    case 'create_campaign':
    case 'start_campaign': {
      // "start_campaign" and "idea" are the names it first shipped with; still accepted.
      const raw = typeof args.brief === 'string' ? args.brief : typeof args.idea === 'string' ? args.idea : '';
      const idea = raw.trim();
      if (!idea) throw new ToolError('brief is required: describe the campaign, from one line to a full brief.');
      const questionMode = args.questions === 'assume' ? 'assume' : 'ask';
      const id = newId();
      const r = startTurn(id, caller.tenantId, { content: idea }, { questionMode });
      if (!r.ok) throw new ToolError(r.error);
      return {
        campaignId: id,
        ...linkInfo(caller, id),
        state: 'draft',
        allowedActions: ACTIONS.working,
        questionMode,
        next: questionMode === 'assume' ? 'Call get_campaign with waitSeconds: 50 until state is "ready"; its assumptions come with it.' : 'Call get_campaign with waitSeconds: 50 until it changes (it may come back with questions).',
      };
    }

    case 'get_campaign': {
      const id = String(args.campaignId ?? '');
      const wait = Math.min(50, Math.max(0, Number(args.waitSeconds) || 0));
      if (wait && isRunning(id)) await waitForTurn(id, wait * 1000);
      const st = campaignStatus(caller, id);
      if (args.details === true && st.state !== 'deleted' && !isRunning(id)) {
        const stores = loadStores(id);
        if (stores.campaign) {
          const tenant = resolveTenant(caller.tenantId);
          st.details = campaignDetails(id, stores.campaign, stores.context, { cost: campaignCost(stores.campaign, stores.context, tenant), engine: loadEngineCampaign(id) ?? toEngineCampaign(stores.campaign, tenant).engine });
        }
      }
      return st;
    }

    case 'answer_questions': {
      const id = String(args.campaignId ?? '');
      const chat = chatFor(caller, id);
      const open = openQuestions(chat);
      if (!open.length) throw new ToolError('There are no open questions on this campaign. Use request_changes to talk to the agent.');
      const given = (args.answers && typeof args.answers === 'object' ? args.answers : {}) as Record<string, unknown>;
      const unknown = Object.keys(given).filter((k) => !open.some((q) => q.id === k));
      if (unknown.length) throw new ToolError(`No open question with id ${unknown.join(', ')}. Open: ${open.map((q) => q.id).join(', ')}.`);
      const skipAll = args.skip === 'all';
      const skipIds = new Set(Array.isArray(args.skip) ? args.skip.map(String) : []);
      const answers: Record<string, string> = {};
      for (const q of open) {
        const a = typeof given[q.id] === 'string' ? (given[q.id] as string).trim() : '';
        if (a && !skipAll && !skipIds.has(q.id)) answers[q.id] = a;
      }
      const skipped = open.filter((q) => !answers[q.id]).map((q) => q.id);
      // The same message and answer set the app's form sends.
      const lines: string[] = [];
      let aspect = '';
      for (const q of open) {
        if (q.aspect !== aspect) {
          aspect = q.aspect;
          lines.push(`${lines.length ? '\n' : ''}**${aspect}**`);
        }
        lines.push(answers[q.id] ? `- ${plain(q.text)} → ${answers[q.id]}` : `- Skipped: ${plain(q.text)}`);
      }
      const content = Object.keys(answers).length ? lines.join('\n') : 'Skipped these questions.';
      const answerSet: AnswerItem[] = open.map((q) => ({ aspect: q.aspect, question: plain(q.text), ...(q.why ? { why: q.why } : {}), ...(answers[q.id] ? { answer: answers[q.id] } : { skipped: true }) }));
      const r = startTurn(id, caller.tenantId, { content, answerSet }, { answers, skipped });
      if (!r.ok) throw new ToolError(r.error);
      return { campaignId: id, ...linkInfo(caller, id), state: 'draft', allowedActions: ACTIONS.working, answered: Object.keys(answers).length, skipped: skipped.length, next: 'Call get_campaign with waitSeconds: 50 until it changes.' };
    }

    case 'request_changes': {
      const id = String(args.campaignId ?? '');
      chatFor(caller, id);
      const request = typeof args.request === 'string' ? args.request.trim() : '';
      if (!request) throw new ToolError('request is required: say what to change, in plain words.');
      const r = startTurn(id, caller.tenantId, { content: request });
      if (!r.ok) throw new ToolError(r.error);
      return { campaignId: id, ...linkInfo(caller, id), state: 'draft', allowedActions: ACTIONS.working, next: 'Call get_campaign with waitSeconds: 50 until it changes.' };
    }

    case 'submit_campaign': {
      const id = String(args.campaignId ?? '');
      const chat = chatFor(caller, id);
      if (loadSubmission(id)) throw new ToolError(LOCKED);
      if (isRunning(id)) throw new ToolError('The agent is still working on this campaign. Wait until get_campaign says "ready".');
      const st = campaignStatus(caller, id);
      if (st.state !== 'ready') throw new ToolError(`Only a ready campaign can be submitted; this one is "${String(st.state)}"${(st.allowedActions as string[]).length ? ` (now: ${(st.allowedActions as string[]).join(', ')})` : ' and the designer is still working'}.`);
      const r = submitChecked(id, chat.tenantId, caller.label, { startDate: args.startDate as string | undefined, endDate: args.endDate as string | undefined }, 'ask with request_changes');
      if (!r.ok) throw new ToolError(r.error.replace('Give a startDate and an endDate (YYYY-MM-DD).', 'Confirm them with your human and pass startDate and endDate (YYYY-MM-DD).'));
      const sub = r.submission;
      const sch = { startDate: sub.startDate!, endDate: sub.endDate! };
      return {
        campaignId: id,
        ...linkInfo(caller, id),
        state: stageOf(sub),
        allowedActions: ACTIONS[stageOf(sub)],
        submittedAt: sub.at,
        submittedBy: sub.by,
        startDate: sch.startDate,
        endDate: sch.endDate,
        message: `Submitted for execution, to run ${scheduleText(sch)}. The campaign is now locked.`,
      };
    }

    case 'copy_campaign': {
      const id = String(args.campaignId ?? '');
      const chat = chatFor(caller, id);
      if (isRunning(id)) throw new ToolError('The agent is still working on this campaign. Copy it once it has finished.');
      let copy: { sessionId: string; name: string };
      try {
        copy = copyCampaign(id, chat.tenantId, typeof args.name === 'string' ? args.name : undefined);
      } catch (e) {
        throw new ToolError((e as Error).message);
      }
      return {
        ...campaignStatus(caller, copy.sessionId),
        copiedFrom: id,
        message: `Copied as "${copy.name}", a new editable draft. The original is unchanged. Adapt the copy with request_changes.`,
      };
    }

    case 'stop_campaign':
    case 'withdraw_campaign': {
      // "withdraw_campaign" is the name it first shipped with; still accepted.
      const id = String(args.campaignId ?? '');
      const chat = chatFor(caller, id);
      const subNow = loadSubmission(id);
      if (!subNow) throw new ToolError('This campaign is not submitted, so there is nothing to stop.');
      if (stageOf(subNow) === 'ended') throw new ToolError('This campaign has ended, so there is nothing to stop. To run it again, copy_campaign and submit the copy with new dates.');
      const w = withdrawCampaign(id, chat.tenantId, caller.label);
      return {
        ...campaignStatus(caller, id),
        stoppedAt: w.at,
        stoppedBy: w.by,
        message: 'Stopped. The campaign is ready again: it can be changed, and submit_campaign sends it out again (customers start fresh).',
      };
    }

    case 'delete_campaign': {
      const id = String(args.campaignId ?? '');
      const chat = chatFor(caller, id);
      if (loadSubmission(id)) throw new ToolError('This campaign is submitted for execution, so it cannot be deleted. Stop it first if your human really wants it gone.');
      if (isRunning(id)) throw new ToolError('The agent is still working on this campaign. Wait for it to finish, then delete.');
      deleteCampaign(id, chat.tenantId);
      return { campaignId: id, state: 'deleted', allowedActions: ACTIONS.deleted, message: 'Deleted. It no longer appears in list_campaigns and its links no longer work. Hyperface keeps a copy, so the Smart Engage team can recover it if this was a mistake.' };
    }

    case 'get_link': {
      const id = String(args.campaignId ?? '');
      chatFor(caller, id);
      return { campaignId: id, ...linkInfo(caller, id) };
    }

    case 'list_campaigns':
      return {
        campaigns: listCampaigns(caller.tenantId).map((c) => ({
          campaignId: c.sessionId,
          name: c.name,
          ...(() => {
            const st = campaignStatus(caller, c.sessionId);
            return { state: st.state, allowedActions: st.allowedActions };
          })(),
          buckets: c.buckets,
          messages: c.messages,
          startDate: c.schedule?.startDate ?? null,
          endDate: c.schedule?.endDate ?? null,
          updatedAt: c.updatedAt,
          ...linkInfo(caller, c.sessionId),
        })),
      };

    default:
      throw new ToolError(`No tool "${name}".`);
  }
}

export const isToolError = (e: unknown): e is ToolError => e instanceof ToolError;
