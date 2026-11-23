// Comm approvals: every message is approved by the bank before a campaign can run.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { approvalProblem, approvalsLine, decide, fingerprint, messagesOf, summarise, syncApprovals } from '../../server/approvals';
import type { CampaignObject } from '../../server/agent/types';

const send = (id: string, copy: string, extra: Record<string, unknown> = {}) => ({ kind: 'send', id, name: `Msg ${id}`, channelPreference: ['SMS'], copy, ...extra });
const campaign = (journeys: unknown[][]): CampaignObject =>
  ({ name: 'Test', buckets: journeys.map((j, i) => ({ id: `b${i + 1}`, name: `Bucket ${i + 1}`, priority: i + 1, rule: [], journey: j })) }) as unknown as CampaignObject;

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cd-appr-'));
});

describe('Comm approvals', () => {
  it('the same wording on two paths is one message with one decision', () => {
    const c = campaign([[send('s1', 'Use your card today.')], [send('s2', 'Use your card today.'), send('s3', 'Last chance.')]]);
    expect(messagesOf(c, null)).toHaveLength(3);
    const recs = syncApprovals('cv-test1', c, null, dir);
    expect(recs).toHaveLength(2);
    expect(recs.find((r) => r.content.copy === 'Use your card today.')!.uses.map((u) => u.stepId)).toEqual(['s1', 's2']);
    expect(recs.every((r) => r.status === 'pending')).toBe(true);
  });

  it('any change to the words makes it pending again; unchanged messages keep their decision', () => {
    const c1 = campaign([[send('s1', 'Hello there.'), send('s2', 'Second one.')]]);
    for (const r of syncApprovals('cv-test2', c1, null, dir)) expect(decide('cv-test2', r.fp, 'approve', 'compliance', undefined, dir).ok).toBe(true);
    expect(summarise(syncApprovals('cv-test2', c1, null, dir))).toMatchObject({ approved: 2, pending: 0 });
    const c2 = campaign([[send('s1', 'Hello there!'), send('s2', 'Second one.')]]);
    const s = summarise(syncApprovals('cv-test2', c2, null, dir));
    expect(s).toMatchObject({ total: 2, approved: 1, pending: 1 });
    // The CTA counts as wording too.
    expect(fingerprint({ channel: 'SMS', copy: 'a', cta: '', link: '', offerLine: '' })).not.toBe(fingerprint({ channel: 'SMS', copy: 'a', cta: 'Go', link: '', offerLine: '' }));
  });

  it('a reject needs a reason; the designer sees it; a removed rejected message stops blocking', () => {
    const c = campaign([[send('s1', 'Guaranteed rewards!'), send('s2', 'Fine copy.')]]);
    const recs = syncApprovals('cv-test3', c, null, dir);
    const bad = recs.find((r) => r.content.copy.startsWith('Guaranteed'))!;
    expect(decide('cv-test3', bad.fp, 'reject', 'compliance', '  ', dir).ok).toBe(false);
    expect(decide('cv-test3', bad.fp, 'reject', 'compliance', "Don't promise guaranteed rewards.", dir).ok).toBe(true);
    const good = recs.find((r) => r !== bad)!;
    decide('cv-test3', good.fp, 'approve', 'compliance', undefined, dir);
    const s = summarise(syncApprovals('cv-test3', c, null, dir));
    expect(approvalProblem(s)).toMatch(/1 was rejected/);
    expect(approvalsLine(s)).toMatch(/Rejected: "Msg s1" in Bucket 1\. Reason: Don't promise guaranteed rewards\./);
    const without = campaign([[send('s2', 'Fine copy.')]]);
    expect(approvalProblem(summarise(syncApprovals('cv-test3', without, null, dir)))).toBeNull();
  });

  it('submit is blocked until every message is approved', () => {
    const c = campaign([[send('s1', 'One.'), send('s2', 'Two.'), send('s3', 'Three.')]]);
    const recs = syncApprovals('cv-test4', c, null, dir);
    expect(approvalProblem(summarise(recs))).toBe('3 messages are waiting for approval. Every message must be approved in Comm approvals before the campaign can be submitted.');
    for (const r of recs) decide('cv-test4', r.fp, 'approve', 'x', undefined, dir);
    expect(approvalProblem(summarise(syncApprovals('cv-test4', c, null, dir)))).toBeNull();
  });

  it('messages with no copy yet are not queued', () => {
    expect(syncApprovals('cv-test5', campaign([[send('s1', '')]]), null, dir)).toHaveLength(0);
  });
});
