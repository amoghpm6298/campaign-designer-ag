// The two stores on disk — the campaign object (what executes) and the
// campaign context (what supports it) — and the tools the agent uses on each.
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadStores, saveCampaignObject, saveContext, sessionFolder, splitLegacy } from '../../server/campaignFiles';
import { persistIfChanged, withStoresFromDisk } from '../../server/agent/loop';
import { addContext, addQuestions, initialState, recordAnswers, recordSkips } from '../../server/agent/state';
import { runToolCall, type ToolEnv } from '../../server/agent/tools';
import { stripJourneyIds } from '../../server/agent/stepIds';
import { statusBlock } from '../../server/agent/prompt';
import { resolveTenant } from '../../server/tenants';
import { bucketContext, currentEntries, entryHistory } from '../../src/designer/v2/contextView';
import type { AgentState } from '../../server/agent/types';

const env = (): ToolEnv => ({ tenant: resolveTenant('TEN-YES')!, availableChannels: ['SMS', 'WHATSAPP'], goalStatement: 'x', sessionId: 's1', lookupCache: new Map() });
const journey = [
  { kind: 'send', name: 'First', stage: 'first-touch', describe: 'x', objective: ['activation'], channelPreference: ['WHATSAPP'] },
  { kind: 'wait', durationHours: 48 },
  { kind: 'send', name: 'Reminder', stage: 'reminder', describe: 'y', objective: ['activation'], channelPreference: ['SMS'] },
];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cd-stores-'));
});

/** A campaign built the way the agent builds one: execution through campaign tools, reasoning through add_context. */
function built(): AgentState {
  let s = runToolCall('edit_campaign', { name: 'Activation', goal: { eventCategory: 'Card Events', eventType: 'Card Activated' }, membership: { type: 'open', refresh: 'daily' } }, initialState(), env()).state;
  s = runToolCall('edit_bucket', { id: 'fresh', name: 'Fresh', priority: 1, rule: [{ entity: 'Card', conditions: [] }], holdoutPct: 10, journey }, s, env()).state;
  s = runToolCall(
    'add_context',
    {
      entries: [
        { kind: 'brief', topic: 'incentive', text: 'No incentive available', source: 'manager' },
        { kind: 'bucket', bucketId: 'fresh', topic: 'behaviour', text: 'Issued in the last 7 days', source: 'agent' },
        { kind: 'bucket', bucketId: 'fresh', topic: 'thesis', text: 'Has not got round to it', source: 'agent' },
        { kind: 'bucket', bucketId: 'fresh', topic: 'evidence', text: 'Judgement', source: 'agent', data: { level: 'hypothesis' } },
        { kind: 'note', topic: 'everyone_else', text: 'No clear lever', source: 'agent' },
      ],
    },
    s,
    env(),
  ).state;
  return s;
}

describe('the two files', () => {
  it('round-trip separately: the campaign file holds only what executes', () => {
    const s = built();
    saveCampaignObject('cd-a1', 'TEN-YES', s.campaign, dir);
    saveContext('cd-a1', 'TEN-YES', s.context, dir);
    expect(readdirSync(sessionFolder('cd-a1', dir)).sort()).toEqual(['campaign.json', 'context.json']);
    const back = loadStores('cd-a1', dir);
    expect(back.campaign).toEqual(s.campaign);
    expect(back.context).toEqual(s.context);
    const raw = readFileSync(join(sessionFolder('cd-a1', dir), 'campaign.json'), 'utf8');
    for (const w of ['behaviour', 'thesis', 'evidence', 'incentive', 'sql', 'segmentationLogic']) expect(raw).not.toContain(w);
    expect(Object.keys(s.campaign.buckets[0]).sort()).toEqual(['holdoutPct', 'id', 'journey', 'name', 'priority', 'rule']);
  });

  it('are empty for a chat with nothing yet, and refuse anything that is not a session id', () => {
    expect(loadStores('cd-none', dir)).toEqual({ campaign: null, context: null });
    for (const bad of ['../x', 'a/b', '', 'x.json', '..']) expect(() => sessionFolder(bad, dir)).toThrow();
  });

  it('leave no temp file behind', () => {
    saveCampaignObject('cd-a1', 'TEN-YES', built().campaign, dir);
    expect(readdirSync(sessionFolder('cd-a1', dir))).toEqual(['campaign.json']);
  });

  it('migrate an old single mixed file into the two', () => {
    writeFileSync(
      join(dir, 'cd-old.json'),
      JSON.stringify({
        sessionId: 'cd-old',
        tenantId: 'TEN-YES',
        updatedAt: '2026-11-12T10:00:00Z',
        campaign: {
          brief: { findings: [{ aspect: 'Incentive', text: 'None', source: 'manager' }] },
          campaign: { name: 'Old', goal: null, entry: null, membership: { type: 'locked' }, segmentationLogic: 'By recency', everyoneElse: { approach: 'none', why: 'Nothing to say' } },
          buckets: [{ id: 'b1', name: 'B1', priority: 1, rule: [], journey, behaviour: 'New', thesis: 'Busy', evidence: 'hypothesis', evidenceNotes: 'Guess', metric: 'Activations', sql: 'SELECT 1', size: 42 }],
        },
      }),
    );
    const { campaign, context } = loadStores('cd-old', dir);
    expect(existsSync(join(dir, 'cd-old.json'))).toBe(false);
    expect({ ...campaign!.buckets[0], journey: stripJourneyIds(campaign!.buckets[0].journey) }).toEqual({ id: 'b1', name: 'B1', priority: 1, rule: [], journey });
    expect(campaign!.buckets[0].journey!.every((st) => typeof (st as { id?: string }).id === 'string')).toBe(true);
    expect(campaign!.everyoneElse).toEqual({ approach: 'none' });
    const v = bucketContext(context!.entries).b1;
    expect(v).toMatchObject({ behaviour: 'New', thesis: 'Busy', evidence: 'hypothesis', metric: 'Activations', size: 42, sql: 'SELECT 1' });
    expect(currentEntries(context!.entries, { kind: 'note', topic: 'segmentation' })[0].text).toBe('By recency');
    expect(splitLegacy({}).campaign.buckets).toEqual([]);
  });
});

describe('the context', () => {
  it('keeps history: a newer entry on the same topic becomes current, the old one stays', () => {
    let s = built();
    s = addContext(s, [{ kind: 'brief', topic: 'Incentive', text: '₹200 cashback on first spend', source: 'manager' }]).state;
    expect(currentEntries(s.context.entries, { kind: 'brief', topic: 'incentive' }).map((e) => e.text)).toEqual(['₹200 cashback on first spend']);
    expect(entryHistory(s.context.entries, { kind: 'brief', topic: 'incentive' }).map((e) => e.text)).toEqual(['No incentive available', '₹200 cashback on first spend']);
  });

  it('adding to the context never makes the built campaign out of date', () => {
    let s = runToolCall('build_campaign', {}, built(), env()).state;
    expect(s.flags.campaignBuilt).toBe(true);
    s = runToolCall('add_context', { entries: [{ kind: 'research', topic: 'kyc', text: 'KYC rejections are high this quarter', source: 'manager' }] }, s, env()).state;
    expect(s.flags.campaignBuilt).toBe(true);
  });

  it('the app files every answer and every skip, without the agent', () => {
    let s = addQuestions(initialState(), [
      { aspect: 'Incentive', text: 'Any incentive?', answerType: 'open' },
      { aspect: 'Timing', text: 'How long?', answerType: 'open' },
    ]).state;
    s = recordAnswers(s, { q1: 'None' }, '');
    s = recordSkips(s, ['q2']);
    const answers = currentEntries(s.context.entries, { kind: 'answer' });
    expect(answers.map((e) => [e.topic, e.text])).toEqual([
      ['Incentive: Any incentive?', 'None'],
      ['Timing: How long?', '(skipped)'],
    ]);
    expect(answers[1].data?.skipped).toBe(true);
  });

  it('gives each bucket its reasoning for the cards', () => {
    expect(bucketContext(built().context.entries).fresh).toMatchObject({ behaviour: 'Issued in the last 7 days', thesis: 'Has not got round to it', evidence: 'hypothesis' });
  });
});

describe('the tools, each on its own store', () => {
  it('campaign tools never touch the context, and context tools never touch the campaign', () => {
    const s = built();
    const edited = runToolCall('edit_bucket', { id: 'fresh', name: 'Fresh issuance' }, s, env()).state;
    expect(edited.context).toBe(s.context);
    const noted = runToolCall('add_context', { entries: [{ kind: 'note', topic: 'measurement', text: 'Activation rate vs holdout', source: 'agent' }] }, s, env()).state;
    expect(noted.campaign).toBe(s.campaign);
  });

  it('get_campaign returns only what executes, with step addresses', () => {
    const s = built();
    const all = JSON.stringify(runToolCall('get_campaign', {}, s, env()).result);
    for (const w of ['behaviour', 'thesis', 'incentive']) expect(all).not.toContain(w);
    const one = runToolCall('get_campaign', { part: 'fresh' }, s, env()).result as { journey: unknown[]; outline: string[] };
    expect(one.journey).toHaveLength(3);
    expect(one.outline[0]).toMatch(/^0 send/);
    expect(runToolCall('get_campaign', { part: 'nope' }, s, env()).ok).toBe(false);
  });

  it('get_context filters, and can return history', () => {
    const s = built();
    const fresh = runToolCall('get_context', { bucketId: 'fresh' }, s, env()).result as { topic: string }[];
    expect(fresh.map((e) => e.topic)).toEqual(['behaviour', 'thesis', 'evidence']);
    expect((runToolCall('get_context', { kind: 'brief' }, s, env()).result as unknown[]).length).toBe(1);
  });

  it('edit_campaign takes execution fields only and points reasoning to the context', () => {
    const out = runToolCall('edit_campaign', { segmentationLogic: 'By recency' }, built(), env());
    expect(out.ok).toBe(false);
    expect(out.forModel).toMatch(/add_context/);
  });

  it('edit_bucket removes a bucket and keeps its context as history', () => {
    const out = runToolCall('edit_bucket', { id: 'fresh', remove: true, reason: 'merged' }, built(), env());
    expect(out.state.campaign.buckets).toHaveLength(0);
    expect(currentEntries(out.state.context.entries, { bucketId: 'fresh' })).toHaveLength(3);
  });

  it('add_context tells the agent when a new entry replaces a current one', () => {
    const s = built();
    const reused = runToolCall('add_context', { entries: [{ kind: 'note', topic: 'everyone_else', text: 'KYC rejections are high', source: 'manager' }] }, s, env());
    expect(reused.forModel).toMatch(/REPLACED the current entry/);
    expect(reused.forModel).toContain('No clear lever');
    const fresh = runToolCall('add_context', { entries: [{ kind: 'research', topic: 'kyc_rejections', text: 'KYC rejections are high', source: 'manager' }] }, s, env());
    expect(fresh.forModel).not.toMatch(/REPLACED/);
  });

  it('a sizing entry without a warehouse is kept, marked not sized', () => {
    const out = runToolCall('add_context', { entries: [{ kind: 'sizing', bucketId: 'fresh', topic: 'size', text: '', data: { sql: 'SELECT 1' } }] }, built(), env());
    expect(bucketContext(out.state.context.entries).fresh.sizeError).toMatch(/No data warehouse/);
  });
});

describe('write-through from the agent loop', () => {
  it('each store is saved the moment it changes; a read saves nothing', () => {
    const before = withStoresFromDisk(initialState(), 'cd-w1', dir);
    expect(before.campaign.buckets).toHaveLength(0);
    const after = built();
    expect(persistIfChanged(before, after, 'cd-w1', 'TEN-YES', dir)).toEqual({ campaign: true, context: true });
    expect(loadStores('cd-w1', dir).campaign!.buckets[0].id).toBe('fresh');
    const read = runToolCall('get_campaign', {}, after, env());
    expect(persistIfChanged(after, read.state, 'cd-w1', 'TEN-YES', dir)).toEqual({ campaign: false, context: false });
    const noted = runToolCall('add_context', { entries: [{ kind: 'research', topic: 'x', text: 'y', source: 'data' }] }, after, env());
    expect(persistIfChanged(after, noted.state, 'cd-w1', 'TEN-YES', dir)).toEqual({ campaign: false, context: true });
  });

  it('the next turn starts from the files, not from what the browser sent', () => {
    const s = built();
    saveCampaignObject('cd-w2', 'TEN-YES', s.campaign, dir);
    saveContext('cd-w2', 'TEN-YES', s.context, dir);
    const next = withStoresFromDisk(initialState(), 'cd-w2', dir);
    expect(next.campaign.buckets[0].id).toBe('fresh');
    expect(next.context.entries).toHaveLength(s.context.entries.length);
  });

  it('the status block summarises both stores instead of pasting them', () => {
    const block = statusBlock(built());
    expect(block).toContain('### Campaign object');
    expect(block).toContain('fresh "Fresh" [journey]');
    expect(block).toContain('### Context (current entries)');
    expect(block).toContain('brief: Incentive');
    expect(block).not.toContain('"stage":');
  });
});
