// The MCP's tools: a thin door onto the same agent the app uses. Every
// campaign made here is an ordinary campaign: same files, same chat, same
// canvas link. The caller's agent never designs anything itself.
import { checkJourneys } from '../agent/compile';
import type { AgentQuestion, AgentState } from '../agent/types';
import { copyCampaign, deleteCampaign, listCampaigns, loadChat, loadStores, loadSubmission, loadWithdrawals, submitCampaign, withdrawCampaign, LOCKED } from '../campaignFiles';
import { currentEntries } from '../../src/designer/v2/contextView';
import type { AnswerItem } from '../../src/designer/v2/types';
import { isRunning, runningStep, startTurn, waitForTurn, type StoredChat } from './runner';
import { campaignBrief } from './brief';
import { submittedStage } from '../../src/designer/v2/lifecycle';
import { directEdit } from '../agent/directEdit';
import { daysBetween, longestPathHours, parseSchedule, scheduleText } from '../agent/schedule';
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
    name: 'start_campaign',
    description:
      'Start a new campaign from a broad idea, for the bank this token is set up for. Hyperface\'s campaign agent designs it (buckets and journeys); with questions: "ask" it may first come back with clarifying questions, with "assume" it decides those itself and builds. This returns at once with a campaignId and a canvas link; then call get_campaign to follow it. Put everything you already know into the idea: goal, audience, incentive, timing, limits.',
    inputSchema: {
      type: 'object',
      properties: {
        idea: { type: 'string', description: 'What the campaign should achieve, in plain words.' },
        questions: {
          type: 'string',
          enum: ['ask', 'assume'],
          description: '"ask" (default): the agent may come back with clarifying questions (status "needs_answers"). "assume": no questions come back; the agent makes its own calls, lists them as assumptions, and builds straight away. Choose "assume" when your human wants a first draft fast or cannot answer now; they can still correct anything with request_changes.',
        },
      },
      required: ['idea'],
    },
  },
  {
    name: 'get_campaign',
    description:
      'Where a campaign is. When "ready" (or submitted: scheduled, active, ended) it carries a brief: the campaign in words, goal, who joins, how many buckets, each bucket\'s who / why stuck / journey in words, and the agent\'s assumptions; use it to tell your human what was built. status is one of: "working" (the agent is designing; call again), "needs_answers" (answer its questions with answer_questions), "ready" (designed and built: show your human the summary and the link), "waiting_for_reply" (the agent replied without building: respond with request_changes), "scheduled" / "active" / "ended" (submitted for execution and locked: before its start date, between its dates, after its end date), "error". waitSeconds (up to 50) waits for the agent to finish before answering, so poll with it instead of calling in a tight loop. A design usually takes 3-7 minutes.',
    inputSchema: {
      type: 'object',
      properties: { campaignId: { type: 'string' }, waitSeconds: { type: 'number', description: 'Wait up to this many seconds (max 50) while the agent is working.' } },
      required: ['campaignId'],
    },
  },
  {
    name: 'answer_questions',
    description:
      'Answer the agent\'s questions (from get_campaign when status is "needs_answers"). Answer with one of the question\'s options, or any text of your own. Ask your human when you do not know; never invent business facts (incentives, limits, dates). Skipped or unanswered questions are assumed by the agent, which says what it assumed. Returns at once; then poll get_campaign.',
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
      'Submit a ready campaign for execution. Only call this after your human has explicitly said the campaign is good to go, and has confirmed its start and end dates (shown in the brief). Pass startDate and endDate (YYYY-MM-DD) if the campaign has none or your human wants different ones: the start must be today or later, the end after the start; a recurring campaign can use a far-off end date. Refused if a journey does not fit between the dates. It locks the campaign: no further changes (withdraw_campaign to change or pause it).',
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
      'Make a new editable draft from an existing campaign (any status, even submitted), then adapt it with request_changes. The copy keeps the campaign, the designer\'s reasoning and the chat, so the designer adapts it instead of starting over; the original is never changed. ' +
      'USE IT when your human wants a variant of something that already exists: the same campaign for a new season or month ("make this the Christmas version"), a different audience or bank segment with the same idea, a different channel mix or cadence, or an A/B alternative to compare with the original. Also to change a submitted campaign while leaving it as it is. ' +
      'DO NOT use it when the goal itself is different (e.g. from card activation to EMI conversion): the buckets were built around the old goal, so start_campaign gives a cleaner design. Same bank only. Returns the new campaignId and link; name is optional (default "Copy of …").',
    inputSchema: { type: 'object', properties: { campaignId: { type: 'string' }, name: { type: 'string', description: 'Name for the copy, e.g. "Christmas Dormant Reactivation".' } }, required: ['campaignId'] },
  },
  {
    name: 'withdraw_campaign',
    description:
      'Take a submitted campaign back from execution. This is also how to PAUSE a campaign: withdraw it. It becomes editable again (request_changes works), and submit_campaign sends it back for execution (resume). Only after your human asks for it. Who withdrew it and when is recorded.',
    inputSchema: { type: 'object', properties: { campaignId: { type: 'string' } }, required: ['campaignId'] },
  },
  {
    name: 'delete_campaign',
    description:
      'Delete a campaign that has NOT been submitted (a draft, e.g. a test). Refused for a submitted campaign: withdraw it first. Only after your human asks for it. It disappears from the list and its links stop working; Hyperface keeps a copy, so a mistaken delete can be recovered by the Campaign Designer team.',
    inputSchema: { type: 'object', properties: { campaignId: { type: 'string' } }, required: ['campaignId'] },
  },
  {
    name: 'get_link',
    description: 'A fresh canvas link for a campaign. Links open the campaign read-only with no password for 24 hours; call this when one has expired.',
    inputSchema: { type: 'object', properties: { campaignId: { type: 'string' } }, required: ['campaignId'] },
  },
  {
    name: 'list_campaigns',
    description: 'Every campaign for this token\'s bank, newest first, with its status and canvas link.',
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

export function campaignStatus(caller: Caller, id: string): Result {
  const chat = chatFor(caller, id);
  const base: Result = { campaignId: id, ...linkInfo(caller, id) };
  const sub = loadSubmission(id);
  if (sub) {
    const st = loadStores(id);
    return { ...base, status: submittedStage(sub), submitted: true, submittedAt: sub.at, submittedBy: sub.by, startDate: sub.startDate, endDate: sub.endDate, brief: st.campaign ? campaignBrief(st.campaign, st.context) : null };
  }
  const ws = loadWithdrawals(id);
  if (ws.length) Object.assign(base, { lastWithdrawn: { at: ws[ws.length - 1].at, by: ws[ws.length - 1].by } });
  if (isRunning(id)) return { ...base, status: 'working', doing: runningStep(id) };
  const last = [...chat.turns].reverse().find((t) => t.role === 'assistant');
  if (!last) return { ...base, status: 'working', doing: 'Starting' };
  if (last.error) return { ...base, status: 'error', error: last.error, next: 'Try request_changes again; if it keeps failing, tell your human.' };
  const message = plain(last.content ?? '');
  const open = openQuestions(chat);
  if (open.length)
    return {
      ...base,
      status: 'needs_answers',
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
    };
  const state = chat.state as AgentState | null;
  if (chat.lastBuilt || state?.flags?.campaignBuilt) {
    const stores = loadStores(id);
    const c = stores.campaign;
    const summary = listCampaigns(caller.tenantId).find((x) => x.sessionId === id);
    return {
      ...base,
      status: 'ready',
      name: c?.name ?? summary?.name,
      message,
      brief: c ? campaignBrief(c, stores.context) : null,
      assumptions: currentEntries(stores.context?.entries ?? [], { kind: 'brief' })
        .filter((e) => e.source === 'assumption')
        .map((e) => `${e.topic}: ${e.text}`),
      version: summary?.version ?? 0,
      next: 'Show your human the summary and the link. Send changes with request_changes; submit only when they say it is good to go.',
    };
  }
  return { ...base, status: 'waiting_for_reply', message, next: 'Reply to the agent with request_changes.' };
}

export async function callTool(caller: Caller, name: string, args: Record<string, unknown>): Promise<Result> {
  switch (name) {
    case 'start_campaign': {
      const idea = typeof args.idea === 'string' ? args.idea.trim() : '';
      if (!idea) throw new ToolError('idea is required: describe the campaign in plain words.');
      const questionMode = args.questions === 'assume' ? 'assume' : 'ask';
      const id = newId();
      const r = startTurn(id, caller.tenantId, { content: idea }, { questionMode });
      if (!r.ok) throw new ToolError(r.error);
      return {
        campaignId: id,
        ...linkInfo(caller, id),
        status: 'working',
        questions: questionMode,
        next: questionMode === 'assume' ? 'Call get_campaign with waitSeconds: 50 until it is "ready"; its assumptions come with it.' : 'Call get_campaign with waitSeconds: 50 until the status changes (it may be "needs_answers").',
      };
    }

    case 'get_campaign': {
      const id = String(args.campaignId ?? '');
      chatFor(caller, id);
      const wait = Math.min(50, Math.max(0, Number(args.waitSeconds) || 0));
      if (wait && isRunning(id)) await waitForTurn(id, wait * 1000);
      return campaignStatus(caller, id);
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
      return { campaignId: id, ...linkInfo(caller, id), status: 'working', answered: Object.keys(answers).length, skipped: skipped.length, next: 'Call get_campaign with waitSeconds: 50 until the status changes.' };
    }

    case 'request_changes': {
      const id = String(args.campaignId ?? '');
      chatFor(caller, id);
      const request = typeof args.request === 'string' ? args.request.trim() : '';
      if (!request) throw new ToolError('request is required: say what to change, in plain words.');
      const r = startTurn(id, caller.tenantId, { content: request });
      if (!r.ok) throw new ToolError(r.error);
      return { campaignId: id, ...linkInfo(caller, id), status: 'working', next: 'Call get_campaign with waitSeconds: 50 until the status changes.' };
    }

    case 'submit_campaign': {
      const id = String(args.campaignId ?? '');
      const chat = chatFor(caller, id);
      if (loadSubmission(id)) throw new ToolError(LOCKED);
      if (isRunning(id)) throw new ToolError('The agent is still working on this campaign. Wait until get_campaign says "ready".');
      const st = campaignStatus(caller, id);
      if (st.status !== 'ready') throw new ToolError(`Only a ready campaign can be submitted; this one is "${String(st.status)}".`);
      // Dates given with the call set (or change) the campaign's own dates first, with the same rules as anywhere else.
      if (args.startDate !== undefined || args.endDate !== undefined) {
        const cur = loadStores(id).campaign?.schedule;
        const r = directEdit(id, chat.tenantId, { op: 'schedule', startDate: String(args.startDate ?? cur?.startDate ?? ''), endDate: String(args.endDate ?? cur?.endDate ?? '') });
        if (!r.ok) throw new ToolError(`Not submitted: ${r.error}`);
      }
      const c = loadStores(id).campaign;
      if (!c) throw new ToolError('There is no campaign yet.');
      const sch = c.schedule;
      if (!sch) throw new ToolError('Not submitted: the campaign has no start and end dates. Confirm them with your human and pass startDate and endDate (YYYY-MM-DD).');
      const checked = parseSchedule(sch);
      if ('error' in checked) throw new ToolError(`Not submitted: ${checked.error.replace(' Nothing was changed.', '')} Pass new startDate and endDate.`);
      const windowDays = daysBetween(sch.startDate, sch.endDate);
      const tooLong = [...c.buckets.map((b) => ({ name: b.name, journey: b.journey })), ...(c.everyoneElse?.approach === 'journey' ? [{ name: 'Everyone else', journey: c.everyoneElse.journey }] : [])]
        .map((l) => ({ name: l.name, days: Math.ceil(longestPathHours(l.journey) / 24) }))
        .filter((l) => l.days > windowDays);
      if (tooLong.length)
        throw new ToolError(`Not submitted: the campaign runs ${windowDays} days (${sch.startDate} → ${sch.endDate}), but ${tooLong.map((l) => `"${l.name}" takes about ${l.days} days`).join(', ')}. Pass later dates, or ask for shorter journeys with request_changes.`);
      const broken = checkJourneys(c, undefined, true, true);
      if (broken.length) throw new ToolError(`Not submitted: these need fixing first (send them with request_changes):\n- ${broken.join('\n- ')}`);
      const sub = submitCampaign(id, chat.tenantId, caller.label, sch);
      return {
        campaignId: id,
        ...linkInfo(caller, id),
        status: submittedStage(sub),
        submitted: true,
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

    case 'withdraw_campaign': {
      const id = String(args.campaignId ?? '');
      const chat = chatFor(caller, id);
      if (!loadSubmission(id)) throw new ToolError('This campaign is not submitted, so there is nothing to withdraw.');
      const w = withdrawCampaign(id, chat.tenantId, caller.label);
      return {
        ...campaignStatus(caller, id),
        withdrawnAt: w.at,
        withdrawnBy: w.by,
        message: 'Withdrawn from execution (paused). The campaign can be changed again; submit_campaign sends it back for execution.',
      };
    }

    case 'delete_campaign': {
      const id = String(args.campaignId ?? '');
      const chat = chatFor(caller, id);
      if (loadSubmission(id)) throw new ToolError('This campaign is submitted for execution, so it cannot be deleted. Withdraw it first if your human really wants it gone.');
      if (isRunning(id)) throw new ToolError('The agent is still working on this campaign. Wait for it to finish, then delete.');
      deleteCampaign(id, chat.tenantId);
      return { campaignId: id, status: 'deleted', message: 'Deleted. It no longer appears in list_campaigns and its links no longer work. Hyperface keeps a copy, so the Campaign Designer team can recover it if this was a mistake.' };
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
          status: c.submitted ? submittedStage(c.submitted) : isRunning(c.sessionId) ? 'working' : c.built ? 'ready' : 'draft',
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
