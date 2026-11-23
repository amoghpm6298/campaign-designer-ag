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
const query = entry({ kind: 'research', topic: 'query: Q1 Logins by lapse group', source: 'data', data: { qid: 'Q1', purpose: 'Logins by lapse group', rows: [{ group: 'lapsed', n: 3880, logged_30d: 2900 }, { group: 'slow', n: 7002, logged_30d: 1200 }] } });
const BET = 'Three in four of them opened the app in the last 30 days (2,900 of 3,880) [Q1] but did not use the card, so we bet the card fell out of their routine: one reminder, then the offer.';
const TRACK = 'Share making a purchase within 7 days of the offer. If under 5%, the offer is not the lever: test a bigger reward next time.';
const full = (extra: Record<string, unknown>[] = []): CampaignContext =>
  ({
    entries: [
      query,
      entry({ kind: 'bucket', bucketId: 'lapsed', topic: 'rationale', text: BET }),
      entry({ kind: 'bucket', bucketId: 'lapsed', topic: 'metric', text: TRACK }),
      entry({ kind: 'bucket', bucketId: 'slow', topic: 'rationale', text: 'Only 1,200 of 7,002 opened the app in 30 days [Q1]: they drifted from the bank, so we lead with SMS and no offer.' }),
      entry({ kind: 'bucket', bucketId: 'slow', topic: 'metric', text: 'Share who spend within 14 days of the SMS; if above 10%, keep SMS first for this group.' }),
      ...extra.map(entry),
    ],
  }) as unknown as CampaignContext;

describe('the code check on the two blocks', () => {
  it('passes when both blocks exist, the bet cites real queries and the tracking says what happens next', () => {
    expect(insightProblems(camp, full(), true)).toEqual([]);
  });
  it('catches a missing block, an uncited bet, a made-up citation, a query with no rows, and tracking with no next step', () => {
    expect(insightProblems(camp, { entries: [] } as unknown as CampaignContext, true).join(' ')).toMatch(/no rationale block[\s\S]*no "what we'll track" block/);
    const p = insightProblems(
      camp,
      full([
        { kind: 'bucket', bucketId: 'lapsed', topic: 'rationale', text: 'They are a quiet group who rarely use the card any more, so we lead with a reminder and then an offer for them.' },
        { kind: 'bucket', bucketId: 'slow', topic: 'rationale', text: 'Only 1,200 of 7,002 opened the app [Q9], so they drifted away from the bank altogether and need SMS.' },
        { kind: 'bucket', bucketId: 'slow', topic: 'metric', text: 'Share who spend within 14 days of the first message.' },
      ]),
      true,
    ).join(' ');
    expect(p).toMatch(/"Lapsed": its rationale cites no query/);
    expect(p).toMatch(/"Slowing": its rationale cites \[Q9\], which is not in the notebook/);
    expect(p).toMatch(/"Slowing": "what we'll track" names a measure but not what we'd do next/);
  });
  it('without data, the bet must say whether it rests on the manager or a hypothesis', () => {
    expect(insightProblems(camp, full(), false).join(' ')).toMatch(/must say what it rests on/);
    const ok = full([
      { kind: 'bucket', bucketId: 'lapsed', topic: 'rationale', text: BET, data: { basis: 'manager' } },
      { kind: 'bucket', bucketId: 'slow', topic: 'rationale', text: 'My judgement: a short gap usually closes on its own for everyday spenders, so one free nudge.', data: { basis: 'hypothesis' } },
    ]);
    expect(insightProblems(camp, ok, false)).toEqual([]);
  });
});

describe('the grader', () => {
  it('sees the notes and the cited rows, never the reasoning', () => {
    const t = graderInput(camp, full());
    expect(t).toMatch(/why this bucket, and our bet: Three in four/);
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
    expect(p).toMatch(/WHY THIS BUCKET, AND OUR BET[\s\S]*WHAT WE'LL TRACK/);
  });
});
