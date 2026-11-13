import { describe, it, expect } from 'vitest';
import { buildCanvasModel, diffChangedSteps, fmtWait, waitHours } from '../../src/designer/v2/canvasModel';
import type { CampaignBucket, CampaignObject } from '../../src/designer/v2/types';
import { planToBlueprint } from '../../server/agent/compile';
import { buildFromBlueprint } from '../../server/blueprint';

const send = (name: string, extra: Record<string, unknown> = {}) => ({ kind: 'send', name, stage: 'first-touch', describe: name, channelPreference: ['WHATSAPP'], ...extra });
const bucket = (id: string, priority: number, journey: unknown[] | null, extra: Partial<CampaignBucket> = {}): CampaignBucket => ({
  id, name: id, priority, rule: [{ entity: 'Card', conditions: [] }], journey, ...extra,
});
const plan = (buckets: CampaignBucket[], ee: unknown = { approach: 'none' }): CampaignObject => ({
  name: 'C',
  goal: { eventCategory: 'Card Events', eventType: 'Card Activated' },
  entry: { kind: 'audience', entity: 'Card' },
  membership: { type: 'open', refresh: 'daily' },
  everyoneElse: ee as never,
  buckets,
});

describe('canvas model', () => {
  it('lays buckets out left to right in priority order, everyone else last', () => {
    const m = buildCanvasModel(plan([bucket('b2', 2, [send('x')]), bucket('b1', 1, [send('y')])]));
    const heads = m.nodes.filter((n) => n.data.kind === 'bucket' || n.data.kind === 'everyone').sort((a, b) => a.x - b.x);
    expect(heads.map((n) => n.id)).toEqual(['b1:head', 'b2:head', 'everyone_else:head']);
    // The entry branches straight into every column; no "not matched" chain, no labels.
    expect(m.edges.filter((e) => e.source === 'entry').map((e) => [e.target, e.label])).toEqual([['b1:head', undefined], ['b2:head', undefined], ['everyone_else:head', undefined]]);
    expect(m.edges.some((e) => e.label === 'Not matched' || e.label === 'Matches' || e.label === 'Check buckets in order')).toBe(false);
    expect(m.nodes[0].id).toBe('entry');
  });

  it('draws goal checks only where the agent placed them', () => {
    const m = buildCanvasModel(plan([bucket('b1', 1, [send('a'), { kind: 'wait', durationHours: 48 }, { kind: 'goalCheck' }, send('b')])]));
    const checks = m.nodes.filter((n) => n.data.kind === 'goalcheck');
    expect(checks.map((c) => c.id)).toEqual(['b1:2']);
    expect(m.edges.some((e) => e.source === 'b1:1' && e.target === 'b1:2')).toBe(true);
    expect(m.edges.some((e) => e.source === 'b1:2' && e.target === 'b1:3')).toBe(true);
  });

  it('draws a holdout only when one is set', () => {
    expect(buildCanvasModel(plan([bucket('b1', 1, [send('a')], { holdoutPct: 10 })])).nodes.some((n) => n.id === 'b1:holdout')).toBe(true);
    expect(buildCanvasModel(plan([bucket('b1', 1, [send('a')], { holdoutPct: 0 })])).nodes.some((n) => n.id === 'b1:holdout')).toBe(false);
  });

  it('labels experiment arms, branch paths and condition answers, with unique nested ids', () => {
    const m = buildCanvasModel(
      plan([
        bucket('b1', 1, [
          { kind: 'experiment', label: 'Which wording', tests: 'wording', arms: [{ label: 'Benefit', pct: 50, steps: [send('a')] }, { label: 'Simple', pct: 50, steps: [send('b')] }] },
          { kind: 'branch', label: 'What did they do', paths: [{ label: 'Read, no action', statuses: ['READ'], steps: [send('c')] }] },
          { kind: 'condition', label: 'Has app?', yes: [send('d')], no: [] },
        ]),
      ]),
    );
    const labels = m.edges.map((e) => e.label).filter(Boolean);
    expect(labels).toEqual(expect.arrayContaining(['Benefit · 50%', 'Simple · 50%', 'Read, no action', 'Anything else', 'Yes', 'No']));
    const ids = m.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The branch and condition follow the experiment, so the builder puts them on each arm, and so does the canvas.
    expect(ids).toEqual(expect.arrayContaining(['b1:0.arms.0.steps.0', 'b1:0.arms.1.steps.0', 'b1:1.paths.0.steps.0#1', 'b1:1.paths.0.steps.0#2', 'b1:2.yes.0#1']));
  });

  it('gives everyone else its own journey when it has one', () => {
    const m = buildCanvasModel(plan([bucket('b1', 1, [send('a')])], { approach: 'journey', journey: [send('e')] }));
    expect(m.nodes.some((n) => n.id === 'everyone_else:0' && n.data.kind === 'send')).toBe(true);
  });

  it('is empty before there is anything to draw', () => {
    expect(buildCanvasModel(null).nodes).toHaveLength(0);
    expect(buildCanvasModel({ goal: null, entry: null, membership: null, buckets: [], everyoneElse: null }).nodes).toHaveLength(0);
  });

  it('flags only the step that changed', () => {
    const before = plan([bucket('b1', 1, [send('a'), { kind: 'wait', durationHours: 48 }, send('b', { channelPreference: ['SMS'] })]), bucket('b2', 2, [send('z')])]);
    const after = plan([bucket('b1', 1, [send('a'), { kind: 'wait', durationHours: 48 }, send('b', { channelPreference: ['WHATSAPP'] })]), bucket('b2', 2, [send('z')])]);
    expect([...diffChangedSteps(before, after)]).toEqual(['b1:2']);
  });

  it('does not call a first build a change', () => {
    expect(diffChangedSteps(plan([bucket('b1', 1, null)]), plan([bucket('b1', 1, [send('a')])])).size).toBe(0);
  });

  it('reads waits in hours, and old day-based waits', () => {
    expect(fmtWait(waitHours({ durationHours: 48 }))).toBe('Wait 2 days');
    expect(fmtWait(waitHours({ delayDays: 3 }))).toBe('Wait 3 days');
    expect(fmtWait(waitHours({ durationHours: 6 }))).toBe('Wait 6 hours');
  });
});

describe('the canvas draws what the builder builds', () => {
  const builderSends = (c: CampaignObject) => {
    const bp = planToBlueprint(c as never).blueprint!;
    const g = buildFromBlueprint(bp, { availableChannels: ['SMS', 'WHATSAPP'], templateLibraryAccess: 'unavailable' }).graph as { nodes: Record<string, { type: string }> };
    return Object.values(g.nodes).filter((n) => n.type === 'SEND').length;
  };
  const canvasSends = (c: CampaignObject) => buildCanvasModel(c).nodes.filter((n) => n.data.kind === 'send').length;

  it('a final reminder after a branch is on each open path, as built', () => {
    const c = plan([
      bucket('b1', 1, [
        send('First'),
        { kind: 'wait', durationHours: 48 },
        { kind: 'branch', label: 'What did they do', paths: [{ label: 'Read, no action', statuses: ['READ'], steps: [send('Different angle')] }, { label: 'Not opened', statuses: ['DELIVERED'], steps: [send('Same fact again', { channelPreference: ['SMS'] })] }] },
        { kind: 'wait', durationHours: 72 },
        send('Final reminder'),
      ]),
    ]);
    expect(canvasSends(c)).toBe(5);
    expect(canvasSends(c)).toBe(builderSends(c));
    const finals = buildCanvasModel(c).nodes.filter((n) => n.data.kind === 'send' && n.data.path === '4');
    expect(finals.map((n) => n.id)).toEqual(['b1:4#1', 'b1:4#2']);
  });

  it('the same after an experiment and after a condition', () => {
    const c = plan([
      bucket('b1', 1, [
        { kind: 'experiment', label: 'Wording', tests: 'wording', arms: [{ label: 'A', pct: 50, steps: [send('A')] }, { label: 'B', pct: 50, steps: [send('B')] }] },
        send('After the test'),
      ]),
      bucket('b2', 2, [{ kind: 'condition', label: 'Has a card?', audience: { name: 'Card holders', groups: [{ entity: 'Card', conditions: [] }] }, yes: [send('Yes')], no: [send('No')] }, send('After the check')]),
    ]);
    expect(canvasSends(c)).toBe(8);
    expect(canvasSends(c)).toBe(builderSends(c));
  });

  it('a change after a fork lights up every copy', () => {
    const j = (ch: string) => [
      { kind: 'branch', label: 'x', paths: [{ label: 'Read', statuses: ['READ'], steps: [send('R')] }, { label: 'Not read', statuses: ['DELIVERED'], steps: [send('N')] }] },
      send('Final', { channelPreference: [ch] }),
    ];
    const changed = diffChangedSteps(plan([bucket('b1', 1, j('SMS'))]), plan([bucket('b1', 1, j('WHATSAPP'))]));
    expect([...changed]).toEqual(['b1:1']);
    const lit = buildCanvasModel(plan([bucket('b1', 1, j('WHATSAPP'))]), null, changed).nodes.filter((n) => n.data.changed);
    expect(lit.map((n) => n.id)).toEqual(['b1:1#1', 'b1:1#2']);
  });
});
