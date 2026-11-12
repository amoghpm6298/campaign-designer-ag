// The campaign on disk, and the get/edit tools the agent uses on it.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { campaignPath, loadCampaign, loadCampaignFile, saveCampaign } from '../../server/campaignFiles';
import { persistIfChanged, withCampaignFromDisk } from '../../server/agent/loop';
import { initialState } from '../../server/agent/state';
import { runToolCall, type ToolEnv } from '../../server/agent/tools';
import { statusBlock } from '../../server/agent/prompt';
import { resolveTenant } from '../../server/tenants';
import type { AgentState } from '../../server/agent/types';

const env = (): ToolEnv => ({ tenant: resolveTenant('TEN-YES')!, availableChannels: ['SMS', 'WHATSAPP'], goalStatement: 'x', sessionId: 's1', lookupCache: new Map() });
const journey = [
  { kind: 'send', name: 'First', stage: 'first-touch', describe: 'x', objective: ['activation'], channelPreference: ['WHATSAPP'] },
  { kind: 'wait', durationHours: 48 },
  { kind: 'send', name: 'Reminder', stage: 'reminder', describe: 'y', objective: ['activation'], channelPreference: ['SMS'] },
];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cd-campaigns-'));
});

function withBucket(): AgentState {
  let s = runToolCall('edit_campaign', { name: 'Activation', goal: { eventCategory: 'Card Events', eventType: 'Card Activated' }, brief: { findings: [{ aspect: 'Goal', text: 'Activate', source: 'manager' }] } }, initialState(), env()).state;
  s = runToolCall('edit_bucket', { id: 'fresh', name: 'Fresh', priority: 1, behaviour: 'New cards', evidence: 'hypothesis', thesis: 't', metric: 'm', rule: [{ entity: 'Card', conditions: [] }], journey }, s, env()).state;
  return s;
}

describe('the campaign file', () => {
  it('round-trips the campaign, and nothing else', () => {
    const s = withBucket();
    saveCampaign('cd-abc1', 'TEN-YES', s.planFile, dir);
    expect(loadCampaign('cd-abc1', dir)).toEqual(s.planFile);
    const f = loadCampaignFile('cd-abc1', dir)!;
    expect(Object.keys(f).sort()).toEqual(['campaign', 'sessionId', 'tenantId', 'updatedAt']);
    expect(Object.keys(f.campaign).sort()).toEqual(['brief', 'buckets', 'campaign']);
  });

  it('returns null for a chat with no campaign yet', () => {
    expect(loadCampaign('cd-none', dir)).toBeNull();
  });

  it('refuses anything that is not a plain session id', () => {
    for (const bad of ['../x', 'a/b', '', 'x.json', '..']) expect(() => campaignPath(bad, dir)).toThrow();
  });

  it('leaves no temp file behind', () => {
    saveCampaign('cd-abc1', 'TEN-YES', withBucket().planFile, dir);
    expect(readdirSync(dir)).toEqual(['cd-abc1.json']);
  });
});

describe('write-through from the agent loop', () => {
  it('a tool change is on disk straight away; a read is not a write', () => {
    const before = withCampaignFromDisk(initialState(), 'cd-w1', dir);
    expect(before.planFile.buckets).toHaveLength(0);
    const after = withBucket();
    expect(persistIfChanged(before, after, 'cd-w1', 'TEN-YES', dir)).toBe(true);
    expect(loadCampaign('cd-w1', dir)!.buckets[0].id).toBe('fresh');
    const read = runToolCall('get_campaign', {}, after, env());
    expect(persistIfChanged(after, read.state, 'cd-w1', 'TEN-YES', dir)).toBe(false);
  });

  it('the next turn starts from the file, not from what the browser sent', () => {
    saveCampaign('cd-w2', 'TEN-YES', withBucket().planFile, dir);
    const sent = { ...initialState(), planFile: { brief: { findings: [] }, campaign: null, buckets: [] } };
    expect(withCampaignFromDisk(sent, 'cd-w2', dir).planFile.buckets[0].id).toBe('fresh');
  });
});

describe('the campaign tools', () => {
  it('get_campaign reads all of it, or one part with step addresses', () => {
    const s = withBucket();
    const all = runToolCall('get_campaign', {}, s, env());
    expect(all.ok).toBe(true);
    expect((all.result as { buckets: { id: string; outline: string[] }[] }).buckets[0].outline[0]).toMatch(/^0/);
    const one = runToolCall('get_campaign', { part: 'fresh' }, s, env()).result as { journey: unknown[]; outline: string[] };
    expect(one.journey).toHaveLength(3);
    expect(one.outline.length).toBeGreaterThanOrEqual(3);
    expect(runToolCall('get_campaign', { part: 'brief' }, s, env()).result).toEqual(s.planFile.brief);
    expect(runToolCall('get_campaign', { part: 'nope' }, s, env()).ok).toBe(false);
  });

  it('edit_campaign changes the shell and the brief together', () => {
    const s = withBucket();
    expect(s.planFile.campaign?.name).toBe('Activation');
    expect(s.planFile.brief.findings[0].aspect).toBe('Goal');
    const out = runToolCall('edit_campaign', { membership: { type: 'open', refresh: 'daily' } }, s, env());
    expect(out.state.planFile.campaign?.membership?.type).toBe('open');
    expect(out.state.planFile.campaign?.name).toBe('Activation');
    expect(runToolCall('edit_campaign', {}, s, env()).ok).toBe(false);
  });

  it('edit_bucket adds, changes and removes, and a change after a build marks it stale', () => {
    let s = withBucket();
    s = { ...s, flags: { ...s.flags, campaignBuilt: true } };
    const changed = runToolCall('edit_bucket', { id: 'fresh', name: 'Fresh issuance' }, s, env());
    expect(changed.state.planFile.buckets[0].name).toBe('Fresh issuance');
    expect(changed.state.planFile.buckets[0].journey).toHaveLength(3);
    expect(changed.state.flags.campaignBuilt).toBe(false);
    const removed = runToolCall('edit_bucket', { id: 'fresh', remove: true, reason: 'merged' }, changed.state, env());
    expect(removed.state.planFile.buckets).toHaveLength(0);
  });

  it('the status block summarises what is on file instead of pasting it', () => {
    const block = statusBlock(withBucket());
    expect(block).toContain('## Campaign on file (read it with get_campaign)');
    expect(block).toContain('fresh "Fresh" [journey]');
    expect(block).not.toContain('"stage":');
  });
});
