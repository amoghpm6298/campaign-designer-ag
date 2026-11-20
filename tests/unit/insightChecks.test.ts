// Each bucket's insight ("why stuck" + "so we"): the code check, the grader, the log.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gradeInsights, graderInput, graderSendBack, insightProblems, logInsightEvent } from '../../server/agent/insightChecks';
import { systemPrompt } from '../../server/agent/prompt';
import type { CampaignContext, CampaignObject } from '../../server/agent/types';

const camp = {
  buckets: [
    { id: 'lapsed', name: 'Lapsed', priority: 1, rule: [{ entity: 'Signal', conditions: [] }], journey: [{ id: 's1', kind: 'send', name: 'Cashback nudge', copy: 'x' }] },
    { id: 'slow', name: 'Slowing', priority: 2, rule: [], journey: [{ id: 's2', kind: 'send', name: 'Reminder', copy: 'x' }] },
  ],
} as unknown as CampaignObject;

let n = 0;
const entry = (e: Record<string, unknown>) => ({ id: `c${++n}`, at: new Date(Date.now() + n).toISOString(), source: 'agent', text: '', ...e });
const query = entry({ kind: 'research', topic: 'query: Logins by lapse group', data: { purpose: 'Logins by lapse group', rows: [{ group: 'lapsed', n: 3880, logged_30d: 2900 }, { group: 'slow', n: 7002, logged_30d: 1200 }] } });
const WHY = 'Three in four of them opened the app in the last 30 days (2,900 of 3,880) but did not use the card.';
const full = (extra: Record<string, unknown>[] = []): CampaignContext =>
  ({
    entries: [
      query,
      entry({ kind: 'bucket', bucketId: 'lapsed', topic: 'why stuck', text: WHY, data: { queries: ['query: Logins by lapse group'] } }),
      entry({ kind: 'bucket', bucketId: 'lapsed', topic: 'so we', text: 'So we reach them inside the app moment, with the offer only for non-responders.', data: { steps: ['Cashback nudge'] } }),
      entry({ kind: 'bucket', bucketId: 'slow', topic: 'why stuck', text: 'Only 1,200 of 7,002 opened the app in 30 days: they have drifted from the bank, not just the card.', data: { queries: ['Logins by lapse group'] } }),
      entry({ kind: 'bucket', bucketId: 'slow', topic: 'so we', text: 'So we lead with SMS, not app-linked WhatsApp, and no offer.' }),
      ...extra.map(entry),
    ],
  }) as unknown as CampaignContext;

describe('the code check', () => {
  it('passes when both notes exist and connect to real queries and steps', () => {
    expect(insightProblems(camp, full(), true)).toEqual([]);
  });
  it('catches missing notes, uncited findings, made-up citations and steps that do not exist', () => {
    const ctx = full([
      { kind: 'bucket', bucketId: 'lapsed', topic: 'why stuck', text: WHY, data: { queries: ['query: A query nobody ran at all'] } },
      { kind: 'bucket', bucketId: 'lapsed', topic: 'so we', text: 'So we change the second message completely.', data: { steps: ['Second message'] } },
    ]);
    const p = insightProblems(camp, ctx, true).join(' ');
    expect(p).toMatch(/"Lapsed": "why stuck" cites "query: A query nobody ran at all", which is not in the notebook/);
    expect(p).toMatch(/"so we" names "Second message", which is not a step/);
    // A paraphrase of a real step ("Cashback nudge experiment" for "Cashback nudge") is fine.
    const para = full([{ kind: 'bucket', bucketId: 'lapsed', topic: 'so we', text: 'So we reach them inside the app moment first.', data: { steps: ['Cashback nudge experiment'] } }]);
    expect(insightProblems(camp, para, true).join(' ')).not.toMatch(/not a step/);
    expect(insightProblems(camp, { entries: [] } as unknown as CampaignContext, true).join(' ')).toMatch(/no "why stuck" note[\s\S]*no "so we" note/);
    const uncited = full([{ kind: 'bucket', bucketId: 'slow', topic: 'why stuck', text: 'They are a quiet group who do not spend much at all these days.' }]);
    expect(insightProblems(camp, uncited, true).join(' ')).toMatch(/"Slowing": its "why stuck" cites no query/);
  });
  it('a paraphrased citation gets a "did you mean" pointing at the real query', () => {
    const ctx = full([{ kind: 'bucket', bucketId: 'lapsed', topic: 'why stuck', text: WHY, data: { queries: ['query: app logins in each lapse group'] } }]);
    expect(insightProblems(camp, ctx, true).join(' ')).toMatch(/did you mean "query: Logins by lapse group"\?/);
  });
  it('a written research note is not evidence: the citation must reach a query result with rows', () => {
    const ctx = full([
      { kind: 'research', topic: 'never-transacted by cohort age', text: 'My summary: 42% to 21%.' },
      { kind: 'bucket', bucketId: 'slow', topic: 'why stuck', text: 'The never-transacted share halves from 42% to 21% between the first two fortnights.', data: { queries: ['never-transacted by cohort age'] } },
    ]);
    expect(insightProblems(camp, ctx, true).join(' ')).toMatch(/"Slowing": "why stuck" cites "never-transacted by cohort age", which is a written note, not a query result/);
  });
  it('without data, a note must say it rests on the manager or a hypothesis', () => {
    const p = insightProblems(camp, full(), false).join(' ');
    expect(p).toMatch(/must say what it rests on/);
    const ok = full([
      { kind: 'bucket', bucketId: 'lapsed', topic: 'why stuck', text: WHY, data: { basis: 'manager' } },
      { kind: 'bucket', bucketId: 'slow', topic: 'why stuck', text: 'My judgement: a short gap usually closes on its own for everyday spenders.', data: { basis: 'hypothesis' } },
    ]);
    expect(insightProblems(camp, ok, false)).toEqual([]);
  });
});

describe('the grader', () => {
  it('sees the notes and the cited rows, never the reasoning', () => {
    const t = graderInput(camp, full());
    expect(t).toMatch(/why stuck: Three in four/);
    expect(t).toMatch(/rows: \[\{"group":"lapsed","n":3880,"logged_30d":2900\}/);
  });
  it('recomputes pass from the scores, so it cannot pass a weak bucket', async () => {
    const call = async () => ({
      text: JSON.stringify({ grades: [
        { bucketId: 'lapsed', backed: 'yes', nonObvious: 3, followsThrough: true, pass: true, reason: 'Clear gap in app use.' },
        { bucketId: 'slow', backed: 'partly', nonObvious: 2, followsThrough: true, pass: true, reason: 'Reads more into the rows than they show.' },
      ] }),
    });
    const r = await gradeInsights(camp, full(), call);
    expect(r.grades.map((g) => g.pass)).toEqual([true, false]);
    expect(graderSendBack(r.grades.filter((g) => !g.pass))).toMatch(/"Slowing" \(backed: partly.*Reads more into the rows/);
  });
  it('grades only the buckets asked for; the rest are shown for comparison only', async () => {
    let seen = '';
    const call = async (_s: string, text: string) => ((seen = text), { text: JSON.stringify({ grades: [{ bucketId: 'slow', backed: 'yes', nonObvious: 2, followsThrough: true, pass: true, reason: 'ok' }, { bucketId: 'lapsed', backed: 'no', nonObvious: 1, followsThrough: false, pass: false, reason: 'ignored' }] }) });
    const r = await gradeInsights(camp, full(), call, ['slow']);
    expect(r.grades.map((g) => g.bucketId)).toEqual(['slow']);
    expect(seen).toMatch(/"Lapsed"[^\n]*\[already reviewed: for comparison only/);
    expect(r.error).toBeUndefined();
  });
  it('never throws: a bad reply is an error with no grades', async () => {
    const r = await gradeInsights(camp, full(), async () => ({ text: 'not json' }));
    expect(r.grades).toEqual([]);
    expect(r.error).toBeTruthy();
  });
});

describe('logs and prompt', () => {
  it('appends one JSON line per event', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cd-insight-'));
    logInsightEvent({ type: 'grade', sessionId: 's1', grades: [] }, dir);
    logInsightEvent({ type: 'code_check', sessionId: 's1', problems: ['x'] }, dir);
    const lines = readFileSync(join(dir, 'insight-checks.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.type)).toEqual(['grade', 'code_check']);
    expect(lines[0].at).toBeTruthy();
  });
  it('the prompt optimises for the outcome, for a hard-to-move audience, and stays honest', () => {
    const p = systemPrompt(true, true);
    expect(p).toMatch(/What you are optimising for/);
    expect(p).toMatch(/Indian cardholders, who are sharp and hard to move/);
    expect(p).toMatch(/A pattern that is the same in every group explains none of them/);
    expect(p).toMatch(/"why stuck"[\s\S]*"so we"/);
  });
});
