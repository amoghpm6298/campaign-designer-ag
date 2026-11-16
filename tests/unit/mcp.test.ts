// The MCP for teammates' agents: token auth, the JSON-RPC surface, a headless
// turn that saves exactly what the app saves, answers, and the submit lock.
// The agent itself is replaced by a stand-in, so nothing here calls Claude.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleMcpHttp, parseTokens } from '../../server/mcp/handler';
import { setStreamForTests, isRunning, waitForTurn } from '../../server/mcp/runner';
import { addQuestions, initialState, recordAnswers } from '../../server/agent/state';
import { listCampaigns, loadChat, saveCampaignObject } from '../../server/campaignFiles';
import { directEdit } from '../../server/agent/directEdit';
import { checkViewToken, makeViewToken, viewAllows } from '../../server/viewLinks';
import { todayIST } from '../../server/agent/schedule';
import { passwordGate } from '../../server/passwordGate';
import { systemPrompt } from '../../server/agent/prompt';
import type { AgentRequest, AgentResponse, AgentState, CampaignObject } from '../../server/agent/types';

const TOKEN = 'test-token-0123456789abcdef';
/** A date `n` days from today (India), YYYY-MM-DD. */
const day = (n: number) => todayIST(new Date(Date.now() + n * 86400000));
const tokens = parseTokens(`growth:${TOKEN}:TEN-YES`);
const call = (body: unknown, token = TOKEN) => handleMcpHttp({ method: 'POST', auth: `Bearer ${token}`, body, tokens, appUrl: 'https://app.test/cd' });
const tool = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const res = (r.json as { result: { structuredContent?: Record<string, unknown>; content: { text: string }[]; isError?: boolean } }).result;
  return { data: res.structuredContent ?? {}, text: res.content[0].text, isError: !!res.isError };
};

const campaign: CampaignObject = {
  name: 'Diwali',
  goal: { eventCategory: 'Transaction Events', eventType: 'Transaction' },
  entry: { kind: 'audience', entity: 'Card' },
  membership: { type: 'locked' },
  everyoneElse: { approach: 'none' },
  buckets: [{ id: 'b1', name: 'Dormant', priority: 1, rule: [{ entity: 'Card', conditions: [] }], journey: [{ kind: 'send', name: 'Nudge', stage: 'first-touch', describe: 'x', objective: ['spend'], channelPreference: ['SMS'] }, { kind: 'wait', durationHours: 72 }, { kind: 'goalCheck' }, { kind: 'exit', reason: 'End', outcome: 'no_response' }] as never }],
};

/** Turn 1 asks two questions; turn 2 (after answers) builds. */
let seen: AgentRequest[] = [];
function fakeAgent(req: AgentRequest): AsyncGenerator<unknown, AgentResponse> {
  seen.push(req);
  return (async function* () {
    yield { type: 'model.tool_call.started', title: 'Writing journeys', correlationId: 't1', seq: 1 };
    let state: AgentState = req.state ?? initialState();
    if (!state.questions.length) {
      state = addQuestions(state, [
        { aspect: 'Incentive', text: 'Is there a **live offer**?', why: 'Messages may only mention a real offer.', answerType: 'yesno' },
        { aspect: 'Guardrails', text: 'How many messages?', answerType: 'single', options: ['2', '3-4'] },
      ]).state;
      return { sessionId: req.sessionId, runId: 'r1', reply: 'A few questions first.', state, questionItems: state.questions, graph: null } as unknown as AgentResponse;
    }
    state = recordAnswers(state, req.answers ?? {}, '');
    saveCampaignObject(req.sessionId, 'TEN-YES', campaign);
    state = { ...state, flags: { ...state.flags, campaignBuilt: true } };
    return { sessionId: req.sessionId, runId: 'r2', reply: 'Built: one bucket.', state, questionItems: [], graph: {} } as unknown as AgentResponse;
  })();
}

beforeEach(() => {
  process.env.CAMPAIGN_DIR = mkdtempSync(join(tmpdir(), 'cd-mcp-'));
  seen = [];
  setStreamForTests(fakeAgent as never);
});
afterEach(() => setStreamForTests(null));

describe('the MCP endpoint', () => {
  it('needs a valid token, and answers initialize and tools/list', async () => {
    expect((await call({ jsonrpc: '2.0', id: 1, method: 'ping' }, 'wrong-token-0123456789abcd')).status).toBe(401);
    expect((await handleMcpHttp({ method: 'POST', auth: undefined, body: {}, tokens, appUrl: '' })).status).toBe(401);
    expect((await handleMcpHttp({ method: 'POST', auth: `Bearer ${TOKEN}`, body: {}, tokens: [], appUrl: '' })).status).toBe(503);
    const init = (await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json as { result: { serverInfo: { name: string }; instructions: string } };
    expect(init.result.serverInfo.name).toBe('hyperface-campaign-designer');
    expect(init.result.instructions).toMatch(/submit_campaign only after/);
    expect((await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
    const list = (await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(['start_campaign', 'get_campaign', 'answer_questions', 'request_changes', 'submit_campaign', 'copy_campaign', 'withdraw_campaign', 'delete_campaign', 'get_link', 'list_campaigns']);
  });
});

describe('a campaign through the MCP', () => {
  it('start → questions → answers → ready → submit, saved exactly as the app saves it, on the token\'s bank', async () => {
    const start = await tool('start_campaign', { idea: 'Diwali spend push' });
    const id = String(start.data.campaignId);
    expect(start.data.link).toBe(`https://app.test/cd/designer.html?c=${id}&bank=TEN-YES`);
    expect(seen[0].tenantId).toBe('TEN-YES');

    // A second request while it works is refused.
    expect((await tool('request_changes', { campaignId: id, request: 'x' })).isError).toBe(true);

    let st = await tool('get_campaign', { campaignId: id, waitSeconds: 5 });
    expect(st.data.status).toBe('needs_answers');
    const qs = st.data.questions as { id: string; question: string; why?: string; options: string[] }[];
    expect(qs[0]).toMatchObject({ question: 'Is there a live offer?', why: 'Messages may only mention a real offer.', options: ['Yes', 'No'] });

    expect((await tool('submit_campaign', { campaignId: id })).isError).toBe(true); // not ready yet

    const ans = await tool('answer_questions', { campaignId: id, answers: { [qs[0].id]: 'No' }, skip: [qs[1].id] });
    expect(ans.data).toMatchObject({ answered: 1, skipped: 1 });
    expect(seen[1].answers).toEqual({ [qs[0].id]: 'No' });
    expect(seen[1].skipped).toEqual([qs[1].id]);

    st = await tool('get_campaign', { campaignId: id, waitSeconds: 5 });
    expect(st.data.status).toBe('ready');
    const brief = st.data.brief as { bucketCount: number; totalMessages: number; buckets: { name: string; journey: string; firstPath: string }[]; membership: string };
    expect(brief).toMatchObject({ bucketCount: 1, totalMessages: 1, membership: 'one-time: the list is fixed at launch' });
    expect(brief.buckets[0].name).toBe('Dormant');
    expect(brief.buckets[0].journey).toBe("1 message (SMS) across its paths; one straight path; customers who don't convert end as: didn't respond.");
    expect(brief.buckets[0].firstPath).toBe('SMS "Nudge" → wait 3 days → check the goal → end (didn\'t respond)');

    // The chat file has the app's own shape: user turns (with the answer set), assistant turns with questions.
    const chat = loadChat(id) as { tenantId: string; turns: { role: string; answerSet?: unknown[]; questions?: unknown[] }[]; lastBuilt: boolean; state: { campaign: { buckets: unknown[] } } };
    expect(chat.tenantId).toBe('TEN-YES');
    expect(chat.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(chat.turns[1].questions).toHaveLength(2);
    expect(chat.turns[2].answerSet).toHaveLength(2);
    expect(chat.lastBuilt).toBe(true);
    expect(chat.state.campaign.buckets).toEqual([]); // the campaign lives in campaign.json, as in the app

    // Dates: refused without them, in the past, backwards, or too short for the journey (3 days).
    expect((await tool('submit_campaign', { campaignId: id })).text).toMatch(/no start and end dates/);
    expect((await tool('submit_campaign', { campaignId: id, startDate: day(-1), endDate: day(30) })).text).toMatch(/in the past/);
    expect((await tool('submit_campaign', { campaignId: id, startDate: day(5), endDate: day(2) })).text).toMatch(/must be after startDate/);
    expect((await tool('submit_campaign', { campaignId: id, startDate: day(1), endDate: day(3) })).text).toMatch(/runs 2 days.*"Dormant" takes about 3 days/);
    const sub = await tool('submit_campaign', { campaignId: id, startDate: day(1), endDate: day(30) });
    expect(sub.data).toMatchObject({ status: 'scheduled', submitted: true, submittedBy: 'growth', startDate: day(1), endDate: day(30) }); // starts tomorrow
    expect((await tool('get_campaign', { campaignId: id })).data).toMatchObject({ startDate: day(1), endDate: day(30) });
    expect((await tool('get_campaign', { campaignId: id })).data.status).toBe('scheduled');
    expect(listCampaigns('TEN-YES')[0].submitted?.by).toBe('growth');

    // Locked everywhere.
    expect((await tool('request_changes', { campaignId: id, request: 'more' })).text).toMatch(/locked/);
    expect(directEdit(id, 'TEN-YES', { op: 'holdout', bucketId: 'b1', value: 5 } as never).error).toMatch(/locked/);
    expect((await tool('delete_campaign', { campaignId: id })).text).toMatch(/submitted for execution, so it cannot be deleted/);

    // Withdraw (= pause): editable again, recorded, and it can be resubmitted.
    const w = await tool('withdraw_campaign', { campaignId: id });
    expect(w.data).toMatchObject({ status: 'ready', withdrawnBy: 'growth' });
    expect((await tool('get_campaign', { campaignId: id })).data.lastWithdrawn).toMatchObject({ by: 'growth' });
    expect((await tool('withdraw_campaign', { campaignId: id })).text).toMatch(/not submitted/);
    expect((await tool('submit_campaign', { campaignId: id })).data.status).toBe('scheduled');

    // Copy a submitted campaign: a new editable draft with the design and chat; the original stays submitted.
    const copy = await tool('copy_campaign', { campaignId: id, name: 'Christmas push' });
    const copyId = String(copy.data.campaignId);
    expect(copyId).not.toBe(id);
    expect(copy.data).toMatchObject({ status: 'ready', copiedFrom: id });
    expect((copy.data.brief as { name: string; bucketCount: number })).toMatchObject({ name: 'Christmas push', bucketCount: 1 });
    expect((await tool('get_campaign', { campaignId: id })).data.status).toBe('scheduled');
    const copyChat = loadChat(copyId) as { turns: { content: string }[] };
    expect(copyChat.turns.at(-1)!.content).toMatch(/This is a copy of "Diwali"/);
    expect((await tool('request_changes', { campaignId: copyId, request: 'make it SMS-first' })).isError).toBe(false);
  });

  it('delete_campaign removes a draft', async () => {
    const id = String((await tool('start_campaign', { idea: 'test draft' })).data.campaignId);
    await waitForTurn(id, 2000);
    expect((await tool('delete_campaign', { campaignId: id })).data.status).toBe('deleted');
    expect(listCampaigns('TEN-YES').some((c) => c.sessionId === id)).toBe(false);
    expect((await tool('get_campaign', { campaignId: id })).isError).toBe(true);
  });

  it('a token only sees its own bank\'s campaigns', async () => {
    const id = String((await tool('start_campaign', { idea: 'x' })).data.campaignId);
    await waitForTurn(id, 2000);
    expect(isRunning(id)).toBe(false);
    const other = parseTokens(`risk:other-token-0123456789ab:TEN-IBL`);
    const r = await handleMcpHttp({ method: 'POST', auth: 'Bearer other-token-0123456789ab', body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_campaign', arguments: { campaignId: id } } }, tokens: other, appUrl: '' });
    expect(JSON.stringify(r.json)).toMatch(/No campaign .* for this bank/);
  });

  it('questions: "assume" never stops for answers: questions are skipped for the caller and it builds', async () => {
    const start = await tool('start_campaign', { idea: 'Diwali spend push', questions: 'assume' });
    expect(start.data.questions).toBe('assume');
    const id = String(start.data.campaignId);
    const st = await tool('get_campaign', { campaignId: id, waitSeconds: 5 });
    expect(st.data.status).toBe('ready');
    // The agent asked once; the same Skip the app sends went back, with every question id.
    expect(seen).toHaveLength(2);
    expect(seen[1].skipped).toHaveLength(2);
    expect(seen[1].answers).toBeUndefined();
    const chat = loadChat(id) as { questionMode: string; turns: { role: string; content: string }[] };
    expect(chat.questionMode).toBe('assume');
    expect(chat.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(chat.turns[2].content).toBe('Skipped these questions.');
  });
});

describe('signed view links', () => {
  const SECRET = 'link-secret-for-tests';
  it('are valid for 24 hours, for one campaign only', () => {
    const t = makeViewToken(SECRET, 'cv-a', 24, 0);
    expect(checkViewToken(SECRET, 'cv-a', t, 23 * 3600 * 1000)).toBe(true);
    expect(checkViewToken(SECRET, 'cv-a', t, 25 * 3600 * 1000)).toBe(false); // expired
    expect(checkViewToken(SECRET, 'cv-b', t, 0)).toBe(false); // another campaign
    expect(checkViewToken('other-secret', 'cv-a', t, 0)).toBe(false);
  });

  it('allow only reading that campaign', () => {
    const q = (s: string) => new URLSearchParams(s);
    expect(viewAllows('cv-a', 'GET', '/designer.html', q(''))).toBe(true);
    expect(viewAllows('cv-a', 'GET', '/api/campaign', q('sessionId=cv-a'))).toBe(true);
    expect(viewAllows('cv-a', 'GET', '/api/campaign', q('sessionId=cv-b'))).toBe(false);
    expect(viewAllows('cv-a', 'GET', '/api/campaigns', q('tenantId=TEN-IBL'))).toBe(false);
    expect(viewAllows('cv-a', 'POST', '/api/agent/stream', q(''))).toBe(false);
    expect(viewAllows('cv-a', 'POST', '/api/campaign/chat', q(''))).toBe(false);
    expect(viewAllows('cv-a', 'DELETE', '/api/campaign', q('sessionId=cv-a'))).toBe(false);
    expect(viewAllows('cv-a', 'POST', '/api/tenants', q(''))).toBe(true);
  });

  it('the gate lets a valid link in, then keeps it to reads of that campaign', async () => {
    const gate = passwordGate('app-password', '/cd/', SECRET)!;
    const run = (url: string, cookie = '', method = 'GET') =>
      new Promise<{ next: boolean; status?: number; setCookie?: string }>((resolve) => {
        const headers: Record<string, string> = {};
        const res = {
          statusCode: 200,
          setHeader: (k: string, v: string) => (headers[k.toLowerCase()] = v),
          end: () => resolve({ next: false, status: res.statusCode }),
        };
        void gate({ url, method, headers: { cookie } } as never, res as never, () => resolve({ next: true, setCookie: headers['set-cookie'] }));
      });
    const token = makeViewToken(SECRET, 'cv-a');
    const first = await run(`/cd/designer.html?c=cv-a&bank=TEN-IBL&view=${token}`);
    expect(first.next).toBe(true);
    const cookie = first.setCookie!.split(';')[0];
    expect(cookie).toBe(`cda_view=cv-a.${token}`);
    expect((await run('/cd/api/campaign?sessionId=cv-a', cookie)).next).toBe(true);
    expect((await run('/cd/api/campaign?sessionId=cv-b', cookie)).status).toBe(403);
    expect((await run('/cd/api/agent/stream', cookie, 'POST')).status).toBe(403);
    expect((await run(`/cd/designer.html?c=cv-a&view=${makeViewToken(SECRET, 'cv-a', -1)}`)).status).toBe(401); // expired: password page
    expect((await run('/cd/designer.html')).status).toBe(401); // no link, no cookie
    expect((await run('/cd/mcp/guide')).next).toBe(true); // the setup guide is public
  });

  it('the MCP hands out a fresh view link with its expiry; get_link renews it', async () => {
    process.env.LINK_SECRET = SECRET;
    try {
      const id = String((await tool('start_campaign', { idea: 'x' })).data.campaignId);
      await waitForTurn(id, 2000);
      const r = await tool('get_link', { campaignId: id });
      expect(String(r.data.link)).toMatch(new RegExp(`designer\\.html\\?c=${id}&bank=TEN-YES&view=\\d+\\.`));
      expect(Date.parse(String(r.data.linkExpiresAt)) - Date.now()).toBeGreaterThan(23 * 3600 * 1000);
    } finally {
      delete process.env.LINK_SECRET;
    }
  });
});

describe('the campaign brief', () => {
  it('the main agent writes it after every build', () => {
    expect(systemPrompt(false)).toMatch(/CAMPAIGN BRIEF: add_context kind "note", topic "campaign brief"/);
  });
});

describe('log in to edit, from a view link', () => {
  const gate = passwordGate('app-password', '/cd/', 'link-secret-for-tests')!;
  const get = (url: string, cookie = '') =>
    new Promise<{ status: number; location?: string; body?: string }>((resolve) => {
      const headers: Record<string, string> = {};
      const res = { statusCode: 200, setHeader: (k: string, v: string) => (headers[k.toLowerCase()] = v), end: (b?: string) => resolve({ status: res.statusCode, location: headers.location, body: b }) };
      void gate({ url, method: 'GET', headers: { cookie } } as never, res as never, () => resolve({ status: 0 }));
    });
  const back = '/cd/designer.html?c=cv-a&bank=TEN-IBL';
  it('shows the password page carrying the campaign to return to', async () => {
    const r = await get(`/cd/login?next=${encodeURIComponent(back)}`);
    expect(r.status).toBe(200);
    expect(r.body).toContain(`name="next" value="${back.replace(/&/g, '&amp;')}"`);
  });
  it('sends someone already logged in straight back to the campaign', async () => {
    const { createHash } = await import('node:crypto');
    const cookie = `cda_auth=${createHash('sha256').update('campaigndesigneragent:app-password').digest('hex')}`;
    expect(await get(`/cd/login?next=${encodeURIComponent(back)}`, cookie)).toMatchObject({ status: 303, location: back });
  });
  it('never returns anywhere outside the app', async () => {
    const r = await get(`/cd/login?next=${encodeURIComponent('https://evil.example/x')}`);
    expect(r.body).toContain('name="next" value="/cd/designer.html"');
  });
});

describe('submitted campaigns: scheduled, active, ended', () => {
  it('follow the submitted dates and today (India)', async () => {
    const { submittedStage } = await import('../../src/designer/v2/lifecycle');
    const at = (iso: string) => new Date(`${iso}T06:00:00Z`); // 11:30 in India
    const sub = { startDate: '2026-12-01', endDate: '2026-12-31' };
    expect(submittedStage(sub, at('2026-11-30'))).toBe('scheduled');
    expect(submittedStage(sub, at('2026-12-01'))).toBe('active');
    expect(submittedStage(sub, at('2026-12-31'))).toBe('active');
    expect(submittedStage(sub, at('2027-01-01'))).toBe('ended');
    expect(submittedStage({}, at('2026-12-05'))).toBe('submitted'); // submitted before dates existed
    expect(submittedStage(sub, new Date('2026-11-30T19:00:00Z'))).toBe('active'); // already 1 Dec in India
  });
});

