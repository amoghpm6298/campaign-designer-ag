// Convert to flow: campaigns are the sandbox; a campaign that has run can become
// an always-on flow. The whole campaign is copied into a new flow, the designer is
// asked (in the manager's name, with their note) to convert it, approvals carry
// over for unchanged words, and the two are linked both ways.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listCampaigns, loadStores, saveCampaignObject, saveContext, submitCampaign, withdrawCampaign } from '../../server/campaignFiles';
import { conversionBrief, convertToFlow, hasRun, loadConversions } from '../../server/convertToFlow';
import { decide, summarise, syncApprovals } from '../../server/approvals';
import { statusBlock } from '../../server/agent/prompt';
import { initialState } from '../../server/agent/state';
import type { CampaignObject } from '../../server/agent/types';

const send = (id: string, copy: string) => ({ kind: 'send', id, name: `Msg ${id}`, channelPreference: ['SMS'], copy });
const camp = (o: Partial<CampaignObject> = {}): CampaignObject =>
  ({
    name: 'Festive Spend-Up',
    kind: 'campaign',
    intent: 'usage',
    goal: { eventCategory: 'Transaction Events', eventType: 'Transaction' },
    entry: { kind: 'audience', entity: 'Card' },
    membership: { type: 'locked' },
    schedule: { startDate: '2026-11-20', endDate: '2026-12-31' },
    budgetCap: 500000,
    buckets: [
      { id: 'light', name: 'Light users', priority: 1, rule: [], journey: [send('s1', 'Earn 2x points this festive season.'), send('s2', 'Offer ends 31 Dec.')] },
      { id: 'dormant', name: 'Dormant', priority: 2, rule: [], journey: [send('s3', 'We miss you.')] },
    ],
    everyoneElse: null,
    ...o,
  }) as unknown as CampaignObject;

let dir = '';
const T = 'TEN-YES';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cd-conv-'));
  process.env.CAMPAIGN_DIR = join(dir, 'campaigns');
  process.env.APPROVALS_DIR = join(dir, 'approvals');
});

/** A campaign that ran: saved, its messages all approved, submitted with dates around today. */
function ranCampaign(id: string, o: Partial<CampaignObject> = {}) {
  const c = camp(o);
  saveCampaignObject(id, T, c);
  saveContext(id, T, { entries: [{ id: 'e1', at: '2026-11-20T00:00:00Z', kind: 'bucket', bucketId: 'light', topic: 'rationale', text: 'They respond to points.', source: 'agent' }] as never });
  for (const r of syncApprovals(id, c, null)) decide(id, r.fp, 'approve', 'compliance');
  submitCampaign(id, T, 'Campaign manager', { startDate: '2020-01-01', endDate: '2099-01-01' });
  return c;
}

describe('only a campaign that has run can become a flow', () => {
  it('a draft or a scheduled campaign has proven nothing; a live, ended or stopped one has', () => {
    saveCampaignObject('cv-draft', T, camp());
    expect(hasRun('cv-draft')).toBe(false);
    expect(() => convertToFlow('cv-draft', T, { name: 'X', by: 'm' })).toThrow(/has run/);
    saveCampaignObject('cv-later', T, camp());
    submitCampaign('cv-later', T, 'm', { startDate: '2099-01-01', endDate: '2099-02-01' });
    expect(hasRun('cv-later')).toBe(false);
    ranCampaign('cv-ran');
    expect(hasRun('cv-ran')).toBe(true);
    withdrawCampaign('cv-ran', T, 'm');
    expect(hasRun('cv-ran')).toBe(true); // ran, then stopped
  });

  it('a flow is not converted again, a name is needed, and another bank\'s campaign is refused', () => {
    ranCampaign('cv-a');
    expect(() => convertToFlow('cv-a', T, { name: '  ', by: 'm' })).toThrow(/name/);
    expect(() => convertToFlow('cv-a', 'TEN-IBL', { name: 'X', by: 'm' })).toThrow(/another bank/);
    saveCampaignObject('cv-f', T, camp({ kind: 'flow', membership: { type: 'open', refresh: 'weekly' } }));
    expect(() => convertToFlow('cv-f', T, { name: 'X', by: 'm' })).toThrow(/Only a one-time campaign/);
  });
});

describe('converting', () => {
  it('copies the whole campaign into a new flow: open membership, no dates or budget yet, linked both ways', () => {
    ranCampaign('cv-src');
    const r = convertToFlow('cv-src', T, { name: 'Festive habits, always on', note: 'Drop the dormant bucket, it did nothing.', by: 'Campaign manager' });
    const f = loadStores(r.sessionId).campaign!;
    expect(f).toMatchObject({ name: 'Festive habits, always on', kind: 'flow', membership: { type: 'open', refresh: 'weekly' }, schedule: null, budgetCap: null, intent: 'usage' });
    expect(f.buckets.map((b) => b.name)).toEqual(['Light users', 'Dormant']); // the whole campaign: the designer decides what to drop
    expect(f.origin).toMatchObject({ fromId: 'cv-src', fromName: 'Festive Spend-Up', note: 'Drop the dormant bucket, it did nothing.' });
    // The reasoning came along, with where it came from.
    const cx = loadStores(r.sessionId).context!.entries;
    expect(cx.some((e) => e.topic === 'rationale' && e.bucketId === 'light')).toBe(true);
    expect(cx.find((e) => e.topic === 'converted from')!.text).toMatch(/Festive Spend-Up.*Drop the dormant bucket/);
    // The campaign itself is unchanged, and knows what it became.
    expect(loadStores('cv-src').campaign!.kind).toBe('campaign');
    expect(loadConversions('cv-src')).toEqual([expect.objectContaining({ toId: r.sessionId, toName: 'Festive habits, always on' })]);
    const list = listCampaigns(T);
    expect(list.find((c) => c.sessionId === r.sessionId)).toMatchObject({ kind: 'flow', origin: { fromId: 'cv-src' } });
    expect(list.find((c) => c.sessionId === 'cv-src')?.convertedTo).toEqual([{ toId: r.sessionId, toName: 'Festive habits, always on' }]);
  });

  it('the bank\'s approvals carry over while the words stay the same; a rewritten message is pending again', () => {
    ranCampaign('cv-src2');
    const r = convertToFlow('cv-src2', T, { name: 'F', by: 'm' });
    const f = loadStores(r.sessionId).campaign!;
    expect(summarise(syncApprovals(r.sessionId, f, null))).toMatchObject({ total: 3, approved: 3, pending: 0 });
    const rewritten = { ...f, buckets: f.buckets.map((b) => (b.id === 'light' ? { ...b, journey: [send('s1', 'Earn 2x points on your card.'), (b.journey as unknown[])[1]] } : b)) } as unknown as CampaignObject;
    expect(summarise(syncApprovals(r.sessionId, rewritten, null))).toMatchObject({ approved: 2, pending: 1 });
  });

  it('the designer is asked in the manager\'s name, with their note; the status keeps reminding it what was proven', () => {
    expect(conversionBrief('Festive Spend-Up', 'WhatsApp only.')).toMatch(/Convert the one-time campaign "Festive Spend-Up"[\s\S]*Keep who each bucket is for and the lever that worked[\s\S]*My note: WhatsApp only\./);
    expect(conversionBrief('Festive Spend-Up', '')).not.toMatch(/My note/);
    const s = initialState();
    const st = statusBlock({ ...s, campaign: { ...camp({ kind: 'flow' }), origin: { fromId: 'cv-x', fromName: 'Festive Spend-Up', note: 'Make it warmer.', by: 'm', at: '2026-11-28T00:00:00Z' } } });
    expect(st).toMatch(/## Converted from a campaign/);
    expect(st).toMatch(/Their note, which comes first: "Make it warmer\."/);
    expect(st).toMatch(/Keep what was proven/);
    // A first live test reworded every message (none kept its approval) and renamed the flow: both are now said plainly.
    expect(st).toMatch(/KEEP THE WORDING\. .*reword a message ONLY if it mentions a date, festival/);
    expect(st).toMatch(/KEEP THE NAME\./);
    expect(conversionBrief('X', '')).toMatch(/Keep the name I gave it, and keep message wording that is still true/);
    expect(statusBlock({ ...s, campaign: camp() })).not.toMatch(/Converted from a campaign/);
  });
});
