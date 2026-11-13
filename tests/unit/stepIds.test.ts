// Stable step ids: a backend concern. The agent never sees them; every edit keeps them.
import { describe, it, expect } from 'vitest';
import { carryIds, ensureIds, findStep, idsIn, stripJourneyIds } from '../../server/agent/stepIds';
import { initialState } from '../../server/agent/state';
import { runToolCall, type ToolEnv } from '../../server/agent/tools';
import { resolveTenant } from '../../server/tenants';
import { planToBlueprint } from '../../server/agent/compile';
import { buildFromBlueprint, type BpStep } from '../../server/blueprint';

const env = (): ToolEnv => ({ tenant: resolveTenant('TEN-YES')!, availableChannels: ['SMS', 'WHATSAPP'], goalStatement: 'x', sessionId: 's1', lookupCache: new Map() });
const send = (name: string, ch = 'WHATSAPP') => ({ kind: 'send', name, stage: 'first-touch', describe: name, objective: ['activation'], channelPreference: [ch] });
const journey = [
  send('First'),
  { kind: 'experiment', label: 'Wording', tests: 'wording', arms: [{ label: 'A', pct: 50, steps: [send('A')] }, { label: 'B', pct: 50, steps: [send('B')] }] },
  { kind: 'wait', durationHours: 48 },
  send('Final', 'SMS'),
];
const ids = (j: BpStep[] | null) => { const out: string[] = []; findAll(j, out); return out; };
function findAll(j: BpStep[] | null | undefined, out: string[]) { for (const s of (j ?? []) as Record<string, unknown>[]) { out.push(String(s.id)); for (const a of (s.arms as { steps: BpStep[] }[]) ?? []) findAll(a.steps, out); } }

function built() {
  let s = runToolCall('create_campaign', { name: 'C', goal: { eventCategory: 'Card Events', eventType: 'Card Activated' }, entry: { entity: 'Card' }, membership: { type: 'locked' }, everyoneElse: { approach: 'none' } }, initialState(), env()).state;
  s = runToolCall('create_bucket', { id: 'b1', name: 'B1', priority: 1, rule: [{ entity: 'Card', conditions: [] }], journey }, s, env()).state;
  s = runToolCall('create_bucket', { id: 'b2', name: 'B2', priority: 2, rule: [{ entity: 'Card', conditions: [] }], journey }, s, env()).state;
  return s;
}

describe('step ids', () => {
  it('every step gets a unique id, across buckets', () => {
    const s = built();
    const all = [...ids(s.campaign.buckets[0].journey), ...ids(s.campaign.buckets[1].journey)];
    expect(all).toHaveLength(12);
    expect(all.every((x) => /^s[a-z0-9]+$/.test(x))).toBe(true);
    expect(new Set(all).size).toBe(12);
  });

  it('the agent never sees them', () => {
    const s = built();
    expect(JSON.stringify(runToolCall('get_campaign', {}, s, env()).result)).not.toMatch(/"id":"s[a-z0-9]{6,}"/);
    expect(JSON.stringify(runToolCall('get_campaign', { part: 'b1' }, s, env()).result)).not.toMatch(/"id":"s[a-z0-9]{6,}"/);
  });

  it('a precise edit keeps every id, including the edited step', () => {
    const s = built();
    const before = ids(s.campaign.buckets[0].journey);
    const out = runToolCall('edit_journey', { bucketId: 'b1', operations: [{ op: 'replace', path: '3', step: send('Final', 'WHATSAPP') }] }, s, env()).state;
    expect(ids(out.campaign.buckets[0].journey)).toEqual(before);
    expect(ids(out.campaign.buckets[1].journey)).toEqual(ids(s.campaign.buckets[1].journey));
  });

  it('an insert gives only the new step a new id; the rest keep theirs even though they moved', () => {
    const s = built();
    const before = ids(s.campaign.buckets[0].journey);
    const out = runToolCall('edit_journey', { bucketId: 'b1', operations: [{ op: 'insert_after', path: '0', step: { kind: 'wait', durationHours: 24 } }] }, s, env()).state;
    const after = ids(out.campaign.buckets[0].journey);
    expect(after).toHaveLength(before.length + 1);
    expect(after.filter((x) => !before.includes(x))).toHaveLength(1);
  });

  it('a full rewrite keeps ids for the steps it carried over', () => {
    const s = built();
    const before = ids(s.campaign.buckets[0].journey);
    const rewritten = [send('First'), { kind: 'wait', durationHours: 48 }, send('Final', 'SMS'), send('Extra')];
    const out = runToolCall('edit_bucket', { id: 'b1', journey: rewritten }, s, env()).state;
    const after = ids(out.campaign.buckets[0].journey);
    expect(after[0]).toBe(before[0]);
    expect(after.slice(1, 3)).toEqual(before.slice(4, 6));
    expect(before).not.toContain(after[3]);
  });

  it('ids the model sends are ignored, and duplicates are repaired', () => {
    const j = carryIds(null, [{ ...send('X'), id: 'sfake0001' } as BpStep, { ...send('X'), id: 'sfake0001' } as BpStep])!;
    const got = ids(j);
    expect(got).not.toContain('sfake0001');
    expect(new Set(got).size).toBe(2);
    expect(ensureIds([{ ...send('Y'), id: 'sdup00001' } as BpStep, { ...send('Z'), id: 'sdup00001' } as BpStep]).changed).toBe(true);
  });

  it('a step can be found by id wherever it is, with the forks above it', () => {
    const s = built();
    const armB = (s.campaign.buckets[0].journey![1] as { arms: { steps: Record<string, unknown>[] }[] }).arms[1].steps[0];
    const hit = findStep(s.campaign.buckets[0].journey, String(armB.id))!;
    expect(hit.path).toBe('1.arms.1.steps.0');
    expect(hit.trail[0]).toMatch(/arm "B"/);
    expect(stripJourneyIds(s.campaign.buckets[0].journey)).toEqual(journey);
    expect(idsIn(s.campaign.buckets[0].journey).size).toBe(6);
  });

  it('the builder accepts steps with ids', () => {
    const s = runToolCall('build_campaign', {}, built(), env());
    expect(s.ok).toBe(true);
    const bp = planToBlueprint(built().campaign).blueprint!;
    expect(() => buildFromBlueprint(bp, { availableChannels: ['SMS', 'WHATSAPP'], templateLibraryAccess: 'unavailable' })).not.toThrow();
  });
});

describe('ids with identical steps in one journey', () => {
  it('editing one of two identical waits keeps both ids where they were', () => {
    const j = [send('First'), { kind: 'wait', durationHours: 48 }, send('Second'), { kind: 'wait', durationHours: 72 }, send('Third')];
    let s = runToolCall('create_campaign', { name: 'C', entry: { entity: 'Card' }, membership: { type: 'locked' } }, initialState(), env()).state;
    s = runToolCall('create_bucket', { id: 'b1', name: 'B1', rule: [{ entity: 'Card', conditions: [] }], journey: j }, s, env()).state;
    const before = ids(s.campaign.buckets[0].journey);
    // The first wait becomes 72h, now identical to the second wait.
    const out = runToolCall('edit_journey', { bucketId: 'b1', operations: [{ op: 'replace', path: '1', step: { kind: 'wait', durationHours: 72 } }] }, s, env()).state;
    expect(ids(out.campaign.buckets[0].journey)).toEqual(before);
  });
});

describe('a split must total 100%', () => {
  it('is refused before anything changes, with a reason to ask the manager', () => {
    let s = runToolCall('create_campaign', { name: 'C', entry: { entity: 'Card' }, membership: { type: 'locked' } }, initialState(), env()).state;
    s = runToolCall('create_bucket', { id: 'b1', name: 'B1', rule: [{ entity: 'Card', conditions: [] }], journey }, s, env()).state;
    const bad = { kind: 'experiment', label: 'Wording', tests: 'wording', arms: [{ label: 'A', pct: 80, steps: [send('A')] }, { label: 'B', pct: 10, steps: [send('B')] }] };
    const viaEdit = runToolCall('edit_journey', { bucketId: 'b1', operations: [{ op: 'replace', path: '1', step: bad }] }, s, env());
    expect(viaEdit.ok).toBe(false);
    expect(viaEdit.forModel).toMatch(/= 90%.*ask the manager/);
    expect(viaEdit.state).toBe(s);
    const viaBucket = runToolCall('edit_bucket', { id: 'b1', journey: [send('First'), bad] }, s, env());
    expect(viaBucket.ok).toBe(false);
    expect(viaBucket.state).toBe(s);
  });
});
