import { describe, it, expect } from 'vitest';
import { buildCanvasModel, diffChangedSteps, fmtWait, waitHours } from '../../src/designer/v2/canvasModel';
import type { Bucket, PlanFile } from '../../src/designer/v2/types';

const send = (name: string, extra: Record<string, unknown> = {}) => ({ kind: 'send', name, stage: 'first-touch', describe: name, channelPreference: ['WHATSAPP'], ...extra });
const bucket = (id: string, priority: number, journey: unknown[] | null, extra: Partial<Bucket> = {}): Bucket => ({
  id, name: id, priority, behaviour: '', rule: [], evidence: 'hypothesis', evidenceNotes: '', thesis: '', metric: '', journey, ...extra,
});
const plan = (buckets: Bucket[], ee: unknown = { approach: 'none' }): PlanFile => ({
  brief: { findings: [] },
  campaign: { name: 'C', goal: { eventCategory: 'Card Events', eventType: 'Card Activated' }, entry: null, membership: { type: 'open', refresh: 'daily' }, everyoneElse: ee as never },
  buckets,
});

describe('canvas model', () => {
  it('lays buckets out left to right in priority order, everyone else last', () => {
    const m = buildCanvasModel(plan([bucket('b2', 2, [send('x')]), bucket('b1', 1, [send('y')])]));
    const heads = m.nodes.filter((n) => n.data.kind === 'bucket' || n.data.kind === 'everyone').sort((a, b) => a.x - b.x);
    expect(heads.map((n) => n.id)).toEqual(['b1:head', 'b2:head', 'everyone_else:head']);
    expect(m.edges.filter((e) => e.sideways).map((e) => e.label)).toEqual(['Not matched', 'Not matched']);
    expect(m.nodes[0].id).toBe('entry');
  });

  it('puts one goal check after every send', () => {
    const m = buildCanvasModel(plan([bucket('b1', 1, [send('a'), { kind: 'wait', durationHours: 48 }, send('b')])]));
    const sends = m.nodes.filter((n) => n.data.kind === 'send');
    const checks = m.nodes.filter((n) => n.data.kind === 'goalcheck');
    expect(sends).toHaveLength(2);
    expect(checks.map((c) => c.id)).toEqual(sends.map((s) => `${s.id}:gc`));
    expect(m.edges.some((e) => e.source === 'b1:0:gc' && e.target === 'b1:1')).toBe(true);
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
    expect(ids).toEqual(expect.arrayContaining(['b1:0.arms.0.steps.0', 'b1:0.arms.1.steps.0', 'b1:1.paths.0.steps.0', 'b1:2.yes.0']));
  });

  it('gives everyone else its own journey when it has one', () => {
    const m = buildCanvasModel(plan([bucket('b1', 1, [send('a')])], { approach: 'journey', journey: [send('e')] }));
    expect(m.nodes.some((n) => n.id === 'everyone_else:0' && n.data.kind === 'send')).toBe(true);
  });

  it('is empty before there is anything to draw', () => {
    expect(buildCanvasModel(null).nodes).toHaveLength(0);
    expect(buildCanvasModel({ brief: { findings: [] }, campaign: null, buckets: [] }).nodes).toHaveLength(0);
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
