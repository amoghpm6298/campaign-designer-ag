// The campaign agent: the campaign object and its context, flags, timeline,
// questions, the toolkit, the campaign → builder compiler, the warehouse tools
// and the prompt. Nothing here calls a model.
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import {
  addQuestions,
  applyJourneyOps,
  initialState,
  normaliseQuestions,
  normaliseState,
  outline,
  recordAnswers,
  updateCampaign,
  upsertBucket,
} from '../../server/agent/state';
import { runToolCall, toolsFor, type ToolEnv } from '../../server/agent/tools';
import { stripJourneyIds } from '../../server/agent/stepIds';
import { planToBlueprint } from '../../server/agent/compile';
import { systemPrompt, statusBlock } from '../../server/agent/prompt';
import { buildFromBlueprint, type BpStep } from '../../server/blueprint';
import { resolveTenant } from '../../server/tenants';
import { checkReadOnly, warehousePath } from '../../server/warehouse';
import { FLAG_ORDER, type AgentState } from '../../server/agent/types';
import { dcAddFormValid } from '../../src/reducer/defaultConfig';
import { buildTrace, composeReply, emptyField, mergeEvent } from '../../src/designer/v2/logic';
import type { V2Event } from '../../src/designer/v2/types';

const env = (warehouse = false): ToolEnv => ({
  tenant: resolveTenant('TEN-IBL')!,
  availableChannels: ['WHATSAPP', 'SMS', 'EMAIL'] as never,
  goalStatement: 'Convert big purchases to EMI',
  sessionId: 't',
  warehouseBank: warehouse ? 'indusind' : undefined,
  lookupCache: new Map(),
});

const send = (name: string, ch = 'WHATSAPP'): BpStep => ({
  kind: 'send',
  name,
  objective: ['emi'],
  stage: 'first-touch',
  describe: name,
  channelPreference: [ch],
  copy: `${name} copy`,
  cta: 'Convert now',
});
const journey: BpStep[] = [send('First nudge'), { kind: 'wait', durationHours: 48 }, send('Reminder', 'SMS')];

function twoBuckets(): AgentState {
  let s = updateCampaign(initialState(), {
    name: 'EMI conversion',
    entry: { entity: 'Customer' },
    membership: { type: 'open', refresh: 'weekly' },
    everyoneElse: { approach: 'none', why: 'No clear lever' },
  }).state;
  s = upsertBucket(s, {
    id: 'electronics',
    name: 'Electronics spenders',
    priority: 1,
    rule: [{ entity: 'Transaction', conditions: [], lookbackDays: 30, existence: 'exists' }],
    holdoutPct: 10,
    journey,
  }).state;
  s = upsertBucket(s, {
    id: 'dormant',
    name: 'Dormant',
    priority: 2,
    rule: [{ entity: 'Transaction', conditions: [], lookbackDays: 90, existence: 'none' }],
    journey,
  }).state;
  return s;
}

describe('flags and questions', () => {
  it('start all false and survive a round trip', () => {
    const s = initialState();
    expect(FLAG_ORDER.every((f) => s.flags[f] === false)).toBe(true);
    expect(normaliseState(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });

  it('questionsAnswered follows the form; blanks stay open', () => {
    let s = addQuestions(initialState(), [
      { aspect: 'Goal', text: 'What should change?', answerType: 'single', options: ['A', 'B'] },
      { aspect: 'Timing', text: 'When?', answerType: 'open' },
    ]).state;
    s = recordAnswers(s, { q1: 'A' }, '');
    expect(s.flags.questionsAnswered).toBe(false);
    s = recordAnswers(s, { q2: 'Diwali' }, '');
    expect(s.flags.questionsAnswered).toBe(true);
  });

  it('normalises aspects, strips Other, downgrades thin choice questions, caps at 12', () => {
    const { questions } = normaliseQuestions(
      [
        { aspect: 'goal', text: 'One?', answerType: 'single', options: ['A', 'B', 'Other'] },
        { aspect: 'Goal ', text: 'Two?', answerType: 'multi', options: ['Only one'] },
      ],
      [],
      0,
    );
    expect(questions.map((q) => q.aspect)).toEqual(['Goal', 'Goal']);
    expect(questions[0].options).toEqual(['A', 'B']);
    expect(questions[1].answerType).toBe('open');
    const many = Array.from({ length: 20 }, (_, i) => ({ aspect: 'A', text: `Q${i}?`, answerType: 'open' }));
    expect(normaliseQuestions(many, [], 0).questions).toHaveLength(12);
  });

});

describe('buckets, rebuilds and precise edits', () => {
  it('keeps buckets in priority order', () => {
    let s = twoBuckets();
    s = upsertBucket(s, { id: 'travel', name: 'Travel', priority: 0, rule: [] }).state;
    expect(s.campaign.buckets.map((b) => b.id)).toEqual(['travel', 'electronics', 'dormant']);
  });

  it('there are no approvals: changing a bucket after a build only marks the campaign out of date', () => {
    let s = runToolCall('build_campaign', {}, twoBuckets(), env()).state;
    expect(s.flags.campaignBuilt).toBe(true);
    s = upsertBucket(s, { id: 'dormant', rule: [{ entity: 'Transaction', conditions: [], lookbackDays: 120, existence: 'none' }] }).state;
    expect(s.flags.campaignBuilt).toBe(false);
    expect(stripJourneyIds(s.campaign.buckets.find((b) => b.id === 'electronics')!.journey)).toEqual(journey);
  });

  it('the outline gives every step an address, including inside forks', () => {
    const j: BpStep[] = [
      send('First'),
      { kind: 'experiment', label: 'x', tests: 'wording', arms: [{ label: 'A', pct: 50, steps: [send('A1')] }, { label: 'B', pct: 50, steps: [send('B1'), { kind: 'wait', durationHours: 24 }] }] },
    ];
    const lines = outline(j);
    expect(lines[0]).toMatch(/^0 send/);
    expect(lines.some((l) => l.startsWith('1.arms.1.steps.1 wait'))).toBe(true);
  });

  it('edit_journey changes only the addressed steps', () => {
    const j: BpStep[] = [send('First'), { kind: 'wait', durationHours: 48 }, send('Reminder', 'SMS')];
    const res = applyJourneyOps(j, [
      { op: 'replace', path: '2', step: send('Reminder', 'WHATSAPP') },
      { op: 'replace', path: '1', step: { kind: 'wait', durationHours: 72 } },
      { op: 'insert_after', path: '2', step: { kind: 'exit', reason: 'done' } },
    ]);
    expect(res.errors).toEqual([]);
    expect((res.journey[2] as { channelPreference: string[] }).channelPreference).toEqual(['WHATSAPP']);
    expect(res.journey[1]).toEqual({ kind: 'wait', durationHours: 72 });
    expect(res.journey).toHaveLength(4);
    expect(res.journey[0]).toEqual(j[0]);
    expect(j[1]).toEqual({ kind: 'wait', durationHours: 48 });
  });

  it('edit_journey reaches into an experiment arm and leaves other buckets alone', () => {
    let s = upsertBucket(twoBuckets(), {
      id: 'dormant',
      journey: [{ kind: 'experiment', label: 'x', tests: 'wording', arms: [{ label: 'A', pct: 50, steps: [send('A1')] }, { label: 'B', pct: 50, steps: [send('B1')] }] }],
    }).state;
    s = runToolCall('build_campaign', {}, s, env()).state;
    const out = runToolCall('edit_journey', { bucketId: 'dormant', operations: [{ op: 'replace', path: '0.arms.1.steps.0', step: send('B1 new', 'SMS') }] }, s, env());
    expect(out.ok).toBe(true);
    const b = out.state.campaign.buckets.find((x) => x.id === 'dormant')!;
    const arm = (b.journey![0] as Extract<BpStep, { kind: 'experiment' }>).arms[1];
    expect((arm.steps[0] as { name: string }).name).toBe('B1 new');
    expect(stripJourneyIds(out.state.campaign.buckets.find((x) => x.id === 'electronics')!.journey)).toEqual(journey);
    expect(out.state.flags.campaignBuilt).toBe(false);
  });

  it('edit_journey refuses a bad address without changing anything', () => {
    const out = runToolCall('edit_journey', { bucketId: 'dormant', operations: [{ op: 'replace', path: '9', step: send('x') }] }, twoBuckets(), env());
    expect(out.ok).toBe(false);
  });
});

describe('plan → one campaign', () => {
  it('compiles a first-match chain of Audience-rule conditions, with a holdout split, that the builder accepts', () => {
    const { blueprint, bucketsIncluded } = planToBlueprint(twoBuckets().campaign);
    expect(bucketsIncluded).toEqual(['Electronics spenders', 'Dormant']);
    expect(blueprint!.entry).toMatchObject({ kind: 'audience', repeat: { every: 'weekly' } });
    const first = blueprint!.steps[0] as Extract<BpStep, { kind: 'condition' }>;
    expect(first.audience?.name).toBe('Electronics spenders');
    expect(first.yes[0]).toMatchObject({ kind: 'experiment', tests: 'holdout' });
    expect((first.no[0] as Extract<BpStep, { kind: 'condition' }>).audience?.name).toBe('Dormant');

    const built = buildFromBlueprint(blueprint!, ['WHATSAPP', 'SMS', 'EMAIL'] as never);
    const nodes = Object.values(built.graph.nodes) as { type: string; _config?: Record<string, unknown> }[];
    const audienceSplits = nodes.filter((n) => n.type === 'SPLIT' && n._config?.customSource === 'Audience rule');
    expect(audienceSplits).toHaveLength(2);
    for (const n of audienceSplits) expect(dcAddFormValid('SPLIT', n._config as never)).toBe(true);
    expect(nodes.filter((n) => n.type === 'SEND').length).toBe(4);
    expect(nodes.some((n) => n.type === 'RANDOM_SPLIT')).toBe(true);
    const entry = nodes.find((n) => n.type === 'ENTRY_SEGMENT')!;
    expect(entry._config).toMatchObject({ repeat: true, recurrenceType: 'Weekly' });
  });

  it('locked membership is a single pull at launch', () => {
    const s = updateCampaign(twoBuckets(), { membership: { type: 'locked' } }).state;
    expect(planToBlueprint(s.campaign).blueprint!.entry).not.toHaveProperty('repeat');
  });

  it('reports buckets it cannot build instead of guessing', () => {
    const s = upsertBucket(twoBuckets(), { id: 'nojourney', name: 'No journey yet', rule: [{ entity: 'Customer', conditions: [] }] }).state;
    expect(planToBlueprint(s.campaign).problems.join(' ')).toMatch(/No journey yet/);
  });
});

describe('the toolkit', () => {
  it('offers the warehouse tools only to a tenant with a warehouse', () => {
    expect(toolsFor(false).map((t) => t.name)).not.toContain('run_sql_query');
    expect(toolsFor(true).map((t) => t.name)).toContain('run_sql_query');
    for (const n of ['ask_questions', 'get_campaign', 'edit_campaign', 'edit_bucket', 'edit_journey', 'build_campaign']) {
      expect(toolsFor(false).map((t) => t.name)).toContain(n);
    }
    for (const n of ['update_brief', 'update_campaign', 'upsert_bucket', 'remove_bucket']) {
      expect(toolsFor(false).map((t) => t.name)).not.toContain(n);
    }
  });

  it('set_flags only touches agent-owned flags', () => {
    const out = runToolCall('set_flags', { changes: [{ flag: 'goalClear', value: true, reason: 'x' }, { flag: 'campaignBuilt', value: true, reason: 'x' }] }, initialState(), env());
    expect(out.state.flags.goalClear).toBe(true);
    expect(out.state.flags.campaignBuilt).toBe(false);
  });

  it('build_campaign builds straight away, with no approval needed', () => {
    const out = runToolCall('build_campaign', {}, twoBuckets(), env());
    expect(out.ok).toBe(true);
    expect(out.state.flags.campaignBuilt).toBe(true);
  });

});

describe('the warehouse', () => {
  it('only allows single read statements', () => {
    expect(checkReadOnly('SELECT 1')).toBeNull();
    expect(checkReadOnly('with a as (select 1) select * from a')).toBeNull();
    expect(checkReadOnly('DELETE FROM customers')).not.toBeNull();
    expect(checkReadOnly('SELECT 1; DROP TABLE customers')).not.toBeNull();
  });

  it.runIf(existsSync(warehousePath('indusind')))('queries and sizes buckets against the IndusInd mock data', () => {
    const q = runToolCall('run_sql_query', { sql: 'SELECT category, COUNT(*) AS n FROM transactions GROUP BY category ORDER BY n DESC', purpose: 'categories' }, initialState(), env(true));
    expect(q.ok).toBe(true);
    const sized = runToolCall(
      'add_context',
      { entries: [{ kind: 'sizing', bucketId: 'elec', topic: 'size', text: '', data: { sql: "SELECT DISTINCT customer_id FROM transactions WHERE category = 'electronics'" } }] },
      initialState(),
      env(true),
    );
    expect(sized.ok).toBe(true);
    expect(sized.state.context.entries[0].data?.size).toBeGreaterThan(1000);
  });
});

describe('the prompt', () => {
  it('is one prompt: questions, build in one go, changes through chat — no approvals', () => {
    for (const w of [true, false]) {
      const p = systemPrompt(w);
      expect(p).toMatch(/## 1\. Questions/);
      expect(p).toMatch(/## 2\. Design and build, in one go/);
      expect(p).toMatch(/## 3\. Changes, through chat/);
      expect(p).toMatch(/There are no approvals/);
      expect(p).not.toMatch(/request_signoff/);
      expect(p.length).toBeLessThan(18500); // raised for endings + after-journey guidance
    }
    expect(systemPrompt(true)).toMatch(/data warehouse/);
    expect(systemPrompt(false)).toMatch(/your own knowledge and judgement/);
  });

  it('the status block carries every flag', () => {
    const block = statusBlock(initialState());
    for (const f of FLAG_ORDER) expect(block).toContain(`(${f}): false`);
  });
});

describe('UI helpers', () => {
  const ev = (p: Partial<V2Event>): V2Event => ({ runId: 'r', seq: 1, at: '', type: 'model.tool_call.started', status: 'running', title: '', ...p });

  it('merging a completion keeps the input sent at the start', () => {
    let list = mergeEvent([], ev({ seq: 1, correlationId: 't1', data: { tool: 'x', input: { a: 1 } } }));
    list = mergeEvent(list, ev({ seq: 5, correlationId: 't1', type: 'model.tool_call.completed', status: 'ok', data: { tool: 'x', result: ['SMS'] } }));
    expect(list[0].data?.input).toEqual({ a: 1 });
    expect(list[0].data?.result).toEqual(['SMS']);
  });

  it('the trace interleaves text and tools in order', () => {
    let list: V2Event[] = [];
    list = mergeEvent(list, ev({ seq: 1, type: 'model.text.delta', correlationId: 'text-0', data: { text: 'Let me check.' } }));
    list = mergeEvent(list, ev({ seq: 2, correlationId: 'tool-1', title: 'Checked channels' }));
    list = mergeEvent(list, ev({ seq: 3, type: 'model.text.delta', correlationId: 'text-1', data: { text: 'Done.' } }));
    expect(buildTrace(list).map((t) => t.kind)).toEqual(['text', 'tool', 'text']);
  });

  it('the form composes single, multi + Other and open answers, and omits blanks', () => {
    const qs = [
      { id: 'q1', aspect: 'Goal', text: 'What?', answerType: 'single' as const, options: ['A', 'B'] },
      { id: 'q2', aspect: 'Why not', text: 'Why?', answerType: 'multi' as const, options: ['X', 'Y'] },
      { id: 'q3', aspect: 'Timing', text: 'When?', answerType: 'open' as const },
    ];
    const { answers } = composeReply(qs, { q1: { ...emptyField(), picked: ['B'] }, q2: { picked: ['X'], other: true, text: 'UPI' } });
    expect(answers).toEqual({ q1: 'B', q2: 'X, Other: UPI' });
  });
});

describe('step normalisation', () => {
  it('a wait written in days is converted to hours, wherever it is nested', async () => {
    const { normaliseSteps } = await import('../../server/agent/state');
    const out = normaliseSteps([
      { kind: 'wait', delayDays: 5 } as never,
      { kind: 'branch', label: 'b', paths: [{ label: 'p', statuses: ['READ'], steps: [{ kind: 'wait', durationDays: 2 } as never] }] } as never,
    ]);
    expect(out[0]).toEqual({ kind: 'wait', durationHours: 120 });
    expect((out[1] as { paths: { steps: unknown[] }[] }).paths[0].steps[0]).toEqual({ kind: 'wait', durationHours: 48 });
  });

  it('the build engine never builds a wait with no duration', () => {
    const built = buildFromBlueprint(
      { campaignName: 'x', description: '', goal: null, entry: { kind: 'audience', entity: 'Customer' }, steps: [send('a'), { kind: 'wait' } as never, send('b')] },
      ['WHATSAPP', 'SMS'] as never,
    );
    const pause = (Object.values(built.graph.nodes) as { type: string; _config?: { duration?: number } }[]).find((n) => n.type === 'PAUSE');
    expect(pause?._config?.duration).toBe(24);
    expect(built.issues.some((i) => /no duration/.test(i.problem))).toBe(true);
  });
});

describe('skipping questions', () => {
  it('skipped questions count as dealt with, are marked skipped, and tell the agent to assume', async () => {
    const { recordSkips } = await import('../../server/agent/state');
    let s = addQuestions(initialState(), [
      { aspect: 'Goal', text: 'A?', answerType: 'open' },
      { aspect: 'Timing', text: 'B?', answerType: 'open' },
    ]).state;
    s = recordAnswers(s, { q1: 'Activation' }, '');
    s = recordSkips(s, ['q2']);
    expect(s.flags.questionsAnswered).toBe(true);
    expect(s.questions[1].skipped).toBe(true);
    expect(s.questions[0].skipped).toBeUndefined();
    expect(statusBlock(s)).toContain('[SKIPPED — assume and state it] (Timing) B?');
  });

  it('a skip never overwrites an answer', async () => {
    const { recordSkips } = await import('../../server/agent/state');
    let s = addQuestions(initialState(), [{ aspect: 'Goal', text: 'A?', answerType: 'open' }]).state;
    s = recordAnswers(s, { q1: 'Activation' }, '');
    s = recordSkips(s, ['q1']);
    expect(s.questions[0].answer).toBe('Activation');
    expect(s.questions[0].skipped).toBeUndefined();
  });
});
