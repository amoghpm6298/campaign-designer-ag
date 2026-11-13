// Point-and-edit: the block the manager pointed at (in plain words for the
// agent), knock-on checks, versions with a code diff, direct edits and restore.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initialState } from '../../server/agent/state';
import { runToolCall, type ToolEnv } from '../../server/agent/tools';
import { resolveTenant } from '../../server/tenants';
import { focusSection } from '../../server/agent/focus';
import { checkJourneys } from '../../server/agent/compile';
import { diffCampaigns, templateSummary } from '../../server/agent/versionDiff';
import { listVersions, getVersion, recordVersion, ensureBaseline } from '../../server/campaignVersions';
import { saveCampaignObject, saveContext, loadStores } from '../../server/campaignFiles';
import { directEdit, restoreVersion } from '../../server/agent/directEdit';
import type { AgentState } from '../../server/agent/types';

const env = (): ToolEnv => ({ tenant: resolveTenant('TEN-YES')!, availableChannels: ['SMS', 'WHATSAPP'], goalStatement: 'x', sessionId: 's1', lookupCache: new Map() });
const send = (name: string, ch = 'WHATSAPP') => ({ kind: 'send', name, stage: 'first-touch', describe: name, objective: ['activation'], channelPreference: [ch] });
const journey = [
  send('First'),
  { kind: 'experiment', label: 'Wording', tests: 'wording', arms: [{ label: 'Benefit', pct: 50, steps: [send('A')] }, { label: 'Simple', pct: 50, steps: [send('B')] }] },
  { kind: 'wait', durationHours: 48 },
  { kind: 'branch', label: 'Did they read it?', paths: [{ label: 'Read', statuses: ['READ'], steps: [send('R')] }] },
];

function built(): AgentState {
  let s = runToolCall('edit_campaign', { name: 'Activation', goal: { eventCategory: 'Card Events', eventType: 'Card Activated' }, entry: { entity: 'Card' }, membership: { type: 'open', refresh: 'daily' }, everyoneElse: { approach: 'none' } }, initialState(), env()).state;
  s = runToolCall('edit_bucket', { id: 'fresh', name: 'Fresh', priority: 1, rule: [{ entity: 'Card', conditions: [] }], holdoutPct: 10, journey }, s, env()).state;
  s = runToolCall('edit_bucket', { id: 'old', name: 'Old', priority: 2, rule: [{ entity: 'Card', conditions: [] }], journey: [send('Nudge')] }, s, env()).state;
  s = runToolCall('add_context', { entries: [{ kind: 'bucket', bucketId: 'fresh', topic: 'thesis', text: 'Busy, not unwilling', source: 'agent' }] }, s, env()).state;
  return s;
}
const stepId = (s: AgentState, bucket: number, path: (j: Record<string, unknown>[]) => Record<string, unknown>) => String(path(s.campaign.buckets[bucket].journey as unknown as Record<string, unknown>[]).id);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cd-edit-'));
  process.env.CAMPAIGN_DIR = dir;
});

describe('the block the manager pointed at', () => {
  it('is described in plain words with its current address, never an id', () => {
    const s = built();
    const id = stepId(s, 0, (j) => (j[1].arms as { steps: Record<string, unknown>[] }[])[0].steps[0]);
    const text = focusSection(s, { kind: 'step', bucketId: 'fresh', stepId: id })!;
    expect(text).toContain('The manager wants a change on this block');
    expect(text).toContain('Bucket 1 "Fresh"');
    expect(text).toContain('arm "Benefit"');
    expect(text).toContain('1.arms.0.steps.0');
    expect(text).toContain('Busy, not unwilling');
    expect(text).not.toContain(id);
  });

  it('covers buckets, the entry, the goal and everyone else, and says when the block is gone', () => {
    const s = built();
    expect(focusSection(s, { kind: 'bucket', bucketId: 'old' })).toMatch(/Bucket 2 "Old".*as a whole/);
    expect(focusSection(s, { kind: 'entry' })).toMatch(/one-time or recurring/);
    expect(focusSection(s, { kind: 'goal' })).toMatch(/Card Activated/);
    expect(focusSection(s, { kind: 'everyone_else' })).toMatch(/Everyone else/);
    expect(focusSection(s, { kind: 'step', bucketId: 'fresh', stepId: 'sgone0000' })).toMatch(/no longer exists/);
    expect(focusSection(s, null)).toBeNull();
  });
});

describe('knock-on checks', () => {
  it('catch a split that does not add to 100, a read-branch after SMS, and steps after an exit', () => {
    const s = built();
    // The tools refuse a split that does not total 100, so build the broken
    // campaign directly to prove the build-time checks catch it anyway.
    const j = JSON.parse(JSON.stringify(s.campaign.buckets[0].journey));
    j[0].channelPreference = ['SMS'];
    j[1].arms = [{ ...j[1].arms[0], pct: 80 }, { ...j[1].arms[1], pct: 10 }];
    const withExit: AgentState = {
      ...s,
      campaign: { ...s.campaign, buckets: [{ ...s.campaign.buckets[0], journey: j }, { ...s.campaign.buckets[1], journey: [{ kind: 'exit', reason: 'x' }, ...(s.campaign.buckets[1].journey ?? [])] }] },
    };
    const problems = checkJourneys(withExit.campaign).join(' | ');
    expect(problems).toMatch(/80% \+ 10% = 90%/);
    expect(problems).toMatch(/goes by SMS/);
    expect(problems).toMatch(/comes after an exit/);
    expect(checkJourneys(s.campaign)).toEqual([]);
    expect(runToolCall('build_campaign', {}, withExit, env()).forModel).toMatch(/FIX BEFORE YOU FINISH/);
  });
});

describe('versions', () => {
  it('the diff is exact: one changed step, one removed bucket, a setting', () => {
    const s = built();
    let t = runToolCall('edit_journey', { bucketId: 'fresh', operations: [{ op: 'replace', path: '2', step: { kind: 'wait', durationHours: 72 } }] }, s, env()).state;
    t = runToolCall('edit_bucket', { id: 'old', remove: true }, t, env()).state;
    t = runToolCall('edit_campaign', { membership: { type: 'open', refresh: 'weekly' } }, t, env()).state;
    const d = diffCampaigns(s.campaign, t.campaign);
    expect(d.bucketsRemoved).toEqual(['Old']);
    expect(d.bucketsChanged[0].steps).toEqual({ added: [], changed: ['wait: 2 days → 3 days'], removed: [] });
    expect(d.settings).toEqual(['refresh: recurring, daily → recurring, weekly']);
    expect(templateSummary(d)).toMatch(/Refresh: recurring, daily → recurring, weekly; removed bucket "Old"; "Fresh": wait: 2 days → 3 days/);
  });

  it('one version per change, none when nothing changed; history is never rewritten', () => {
    const s = built();
    expect(recordVersion({ sessionId: 'cd-v1', campaign: s.campaign, source: 'chat', request: 'build it' }, dir)!.n).toBe(1);
    expect(recordVersion({ sessionId: 'cd-v1', campaign: s.campaign, source: 'chat', request: 'nothing' }, dir)).toBeNull();
    const t = runToolCall('edit_bucket', { id: 'old', remove: true }, s, env()).state;
    expect(recordVersion({ sessionId: 'cd-v1', campaign: t.campaign, source: 'chat', request: 'remove old' }, dir)!.n).toBe(2);
    expect(listVersions('cd-v1', dir).map((v) => [v.n, v.source, v.counts.removed])).toEqual([[1, 'chat', 0], [2, 'chat', 1]]);
    expect(getVersion('cd-v1', 1, dir)!.campaign).toEqual(s.campaign);
  });
});

describe('direct edits and restore (code only, no model)', () => {
  const seed = (s: AgentState) => {
    saveCampaignObject('cd-d1', 'TEN-YES', s.campaign);
    saveContext('cd-d1', 'TEN-YES', s.context);
  };

  it('frequency, holdout, split and wait each change only that field and become a version', () => {
    const s = built();
    seed(s);
    const r1 = directEdit('cd-d1', 'TEN-YES', { op: 'membership', type: 'open', refresh: 'weekly' });
    expect(r1.ok).toBe(true);
    expect(r1.campaign!.membership).toEqual({ type: 'open', refresh: 'weekly' });
    expect(r1.version!.summary).toBe('Refresh: recurring, daily → recurring, weekly');
    expect(r1.timeline!.note).toMatch(/Changed directly/);

    expect(directEdit('cd-d1', 'TEN-YES', { op: 'holdout', bucketId: 'fresh', pct: 20 }).campaign!.buckets[0].holdoutPct).toBe(20);

    const testId = stepId(s, 0, (j) => j[1]);
    expect(directEdit('cd-d1', 'TEN-YES', { op: 'split', bucketId: 'fresh', stepId: testId, pcts: [80, 10] }).error).toMatch(/100%/);
    const r3 = directEdit('cd-d1', 'TEN-YES', { op: 'split', bucketId: 'fresh', stepId: testId, pcts: [80, 20] });
    expect(((r3.campaign!.buckets[0].journey![1] as { arms: { pct: number }[] }).arms).map((a) => a.pct)).toEqual([80, 20]);

    const waitId = stepId(s, 0, (j) => j[2]);
    const r4 = directEdit('cd-d1', 'TEN-YES', { op: 'wait', bucketId: 'fresh', stepId: waitId, days: 3 });
    expect((r4.campaign!.buckets[0].journey![2] as { durationHours: number }).durationHours).toBe(72);
    // Only those fields changed; the other bucket is untouched.
    expect(r4.campaign!.buckets[1]).toEqual(s.campaign.buckets[1]);
    // The ids stay put through direct edits.
    expect(stepId({ ...s, campaign: r4.campaign! }, 0, (j) => j[1])).toBe(testId);
    // A starting version, then one per edit (the refused split made none).
    expect(listVersions('cd-d1').map((v) => v.source)).toEqual(['migration', 'direct', 'direct', 'direct', 'direct']);
    expect(loadStores('cd-d1').context!.entries.filter((e) => e.kind === 'note').length).toBe(4);
  });

  it('restore brings back an old version as a new one', () => {
    const s = built();
    seed(s);
    ensureBaseline('cd-d1', s.campaign);
    directEdit('cd-d1', 'TEN-YES', { op: 'holdout', bucketId: 'fresh', pct: 25 });
    const r = restoreVersion('cd-d1', 'TEN-YES', 1);
    expect(r.ok).toBe(true);
    expect(r.campaign).toEqual(s.campaign);
    expect(r.version!.n).toBe(3);
    expect(r.version!.summary).toMatch(/^Restored v1/);
    expect(loadStores('cd-d1').campaign).toEqual(s.campaign);
    expect(getVersion('cd-d1', 2)!.campaign.buckets[0].holdoutPct).toBe(25);
    expect(restoreVersion('cd-d1', 'TEN-YES', 99).ok).toBe(false);
  });
});
