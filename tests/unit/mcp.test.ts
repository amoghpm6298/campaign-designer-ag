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
import type { AgentRequest, AgentResponse, AgentState, CampaignObject } from '../../server/agent/types';

const TOKEN = 'test-token-0123456789abcdef';
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
    expect(list.result.tools.map((t) => t.name)).toEqual(['start_campaign', 'get_campaign', 'answer_questions', 'request_changes', 'submit_campaign', 'list_campaigns']);
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
    expect(st.data.buckets).toEqual([{ name: 'Dormant', who: null, size: 'unknown' }]);

    // The chat file has the app's own shape: user turns (with the answer set), assistant turns with questions.
    const chat = loadChat(id) as { tenantId: string; turns: { role: string; answerSet?: unknown[]; questions?: unknown[] }[]; lastBuilt: boolean; state: { campaign: { buckets: unknown[] } } };
    expect(chat.tenantId).toBe('TEN-YES');
    expect(chat.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(chat.turns[1].questions).toHaveLength(2);
    expect(chat.turns[2].answerSet).toHaveLength(2);
    expect(chat.lastBuilt).toBe(true);
    expect(chat.state.campaign.buckets).toEqual([]); // the campaign lives in campaign.json, as in the app

    const sub = await tool('submit_campaign', { campaignId: id });
    expect(sub.data).toMatchObject({ status: 'submitted', submittedBy: 'growth' });
    expect((await tool('get_campaign', { campaignId: id })).data.status).toBe('submitted');
    expect(listCampaigns('TEN-YES')[0].submitted?.by).toBe('growth');

    // Locked everywhere.
    expect((await tool('request_changes', { campaignId: id, request: 'more' })).text).toMatch(/locked/);
    expect(directEdit(id, 'TEN-YES', { op: 'holdout', bucketId: 'b1', value: 5 } as never).error).toMatch(/locked/);
  });

  it('a token only sees its own bank\'s campaigns', async () => {
    const id = String((await tool('start_campaign', { idea: 'x' })).data.campaignId);
    await waitForTurn(id, 2000);
    expect(isRunning(id)).toBe(false);
    const other = parseTokens(`risk:other-token-0123456789ab:TEN-IBL`);
    const r = await handleMcpHttp({ method: 'POST', auth: 'Bearer other-token-0123456789ab', body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_campaign', arguments: { campaignId: id } } }, tokens: other, appUrl: '' });
    expect(JSON.stringify(r.json)).toMatch(/No campaign .* for this bank/);
  });
});
