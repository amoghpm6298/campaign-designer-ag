// Flows (always on) and campaigns (one-time): chosen when the item is created,
// never inferred, and fixed. The kind decides membership, whether there is an
// end date, which states the item can be in, and which rules the designer gets.
import { describe, expect, it } from 'vitest';
import { kindOf } from '../../src/designer/v2/kind';
import { stateLabel, submittedStage } from '../../src/designer/v2/lifecycle';
import { parseSchedule, scheduleText } from '../../server/agent/schedule';
import { initialState, updateCampaign } from '../../server/agent/state';
import { statusBlock, systemPrompt } from '../../server/agent/prompt';
import { BRIEF_SUGGESTIONS } from '../../src/designer/v2/intent';
import type { AgentState, CampaignObject } from '../../server/agent/types';

const NOW = new Date('2026-11-27T06:00:00Z'); // 11:30 in India
const withKind = (kind: 'flow' | 'campaign'): AgentState => {
  const s = initialState();
  return { ...s, campaign: { ...s.campaign, kind, membership: kind === 'flow' ? { type: 'open', refresh: 'weekly' } : { type: 'locked' } } };
};
const camp = (o: Partial<CampaignObject>) => ({ goal: null, entry: null, membership: null, buckets: [], everyoneElse: null, ...o }) as CampaignObject;

describe('the kind of an item', () => {
  it('is what was chosen; items from before kinds read from membership (recurring = flow)', () => {
    expect(kindOf({ kind: 'flow', membership: { type: 'locked' } })).toBe('flow');
    expect(kindOf({ membership: { type: 'open' } })).toBe('flow');
    expect(kindOf({ membership: { type: 'locked' } })).toBe('campaign');
    expect(kindOf({ membership: null })).toBe('campaign');
    expect(kindOf(null)).toBe('campaign');
  });
});

describe('dates', () => {
  it('a flow has a start date only and runs until stopped; a campaign needs both', () => {
    expect(parseSchedule({ startDate: '2026-12-01' }, NOW, 'flow')).toEqual({ value: { startDate: '2026-12-01' } });
    expect(parseSchedule({ startDate: '2026-12-01', endDate: '2027-01-31' }, NOW, 'flow')).toMatchObject({ error: expect.stringMatching(/flow: it has no end date/) });
    expect(parseSchedule({ startDate: '2026-12-01' }, NOW, 'campaign')).toMatchObject({ error: expect.stringMatching(/endDate is required: this is a one-time campaign/) });
    expect(parseSchedule({ startDate: '2026-12-01', endDate: '2026-12-31' }, NOW, 'campaign')).toEqual({ value: { startDate: '2026-12-01', endDate: '2026-12-31' } });
    expect(parseSchedule({ startDate: '2026-11-01' }, NOW, 'flow')).toMatchObject({ error: expect.stringMatching(/in the past/) });
    expect(scheduleText({ startDate: '2026-12-01' })).toBe('from 1 Dec 2026, until stopped');
    expect(scheduleText({ startDate: '2026-12-01', endDate: '2026-12-31' })).toBe('1 Dec 2026 → 31 Dec 2026');
  });

  it('a submitted flow is scheduled before its start, then live (active) for good; it never ends by itself', () => {
    const at = (d: string) => new Date(`${d}T06:00:00Z`);
    expect(submittedStage({ startDate: '2026-12-01' }, at('2026-11-30'))).toBe('scheduled');
    expect(submittedStage({ startDate: '2026-12-01' }, at('2026-12-01'))).toBe('active');
    expect(submittedStage({ startDate: '2026-12-01' }, at('2030-01-01'))).toBe('active');
    expect(stateLabel('active', 'flow')).toBe('Live');
    expect(stateLabel('active', 'campaign')).toBe('Active');
    expect(stateLabel('stopped', 'flow')).toBe('Stopped');
  });
});

describe('the kind is fixed once stored', () => {
  it('a flow keeps an open list (only its refresh changes); a campaign keeps a fixed one', () => {
    const f = withKind('flow');
    expect(updateCampaign(f, { membership: { type: 'locked' } }).error).toMatch(/This is a flow/);
    expect(updateCampaign(f, { membership: { type: 'open', refresh: 'daily' } }).state.campaign.membership).toEqual({ type: 'open', refresh: 'daily' });
    expect(updateCampaign(withKind('campaign'), { membership: { type: 'open', refresh: 'weekly' } }).error).toMatch(/one-time campaign/);
  });

  it('coming back (afterJourney) and the stopping rule (maxAttempts) are for flows only', () => {
    const c = withKind('campaign');
    expect(updateCampaign(c, { afterJourney: { no_response: 14 } }).error).toMatch(/afterJourney is for flows/);
    expect(updateCampaign(c, { maxAttempts: 2 }).error).toMatch(/maxAttempts is for flows/);
    const f = withKind('flow');
    expect(updateCampaign(f, { maxAttempts: 2 }).state.campaign.maxAttempts).toBe(2);
    expect(updateCampaign(f, { afterJourney: { no_response: 14 } }).error).toBeUndefined();
  });

  it('a flow is dated by its start alone; sending an end date is refused', () => {
    const f = withKind('flow');
    expect(updateCampaign(f, { schedule: { startDate: '2099-12-01' } }).state.campaign.schedule).toEqual({ startDate: '2099-12-01' });
    expect(updateCampaign(f, { schedule: { startDate: '2099-12-01', endDate: '2100-01-01' } }).error).toMatch(/no end date/);
  });

  it('an item from before kinds is not held to one (a recurring one may drop its end date)', () => {
    const s = initialState();
    const old = { ...s, campaign: { ...s.campaign, membership: { type: 'open' as const, refresh: 'weekly' as const } } };
    expect(updateCampaign(old, { schedule: { startDate: '2099-12-01' } }).state.campaign.schedule).toEqual({ startDate: '2099-12-01' });
    expect(updateCampaign(old, { schedule: { startDate: '2099-12-01', endDate: '2100-01-01' } }).state.campaign.schedule).toMatchObject({ endDate: '2100-01-01' });
    expect(updateCampaign(s, { membership: { type: 'open' } }).error).toBeUndefined();
  });
});

describe('the designer gets only its own kind\'s rules', () => {
  const flow = systemPrompt(true, true, 'flow');
  const once = systemPrompt(true, true, 'campaign');
  it('never asks one-time or recurring, in either', () => {
    for (const p of [flow, once]) {
      expect(p).toMatch(/never ask whether it is (one-time or recurring|recurring)/);
      expect(p).not.toMatch(/Ask about membership, or infer it/);
      expect(p).not.toMatch(/far-off end date/);
    }
  });
  it('a flow: joiners as they become eligible, a goal per customer from joining, a rate, a monthly budget, evergreen copy, coming back and the stopping rule', () => {
    expect(flow).toMatch(/# This is a FLOW \(always on\)/);
    expect(flow).toMatch(/AS THEY BECOME ELIGIBLE/);
    expect(flow).toMatch(/THE GOAL PER CUSTOMER, counted from the day they join/);
    expect(flow).toMatch(/SUCCESS AS A RATE/);
    expect(flow).toMatch(/MONEY PER MONTH/);
    expect(flow).toMatch(/JOIN DAY: what they get on day 0, day 3, day 10/);
    expect(flow).toMatch(/no calendar dates, festivals/);
    expect(flow).toMatch(/WHAT HAPPENS AFTER THE JOURNEY/);
    expect(flow).toMatch(/THE STOPPING RULE/);
    expect(flow).toMatch(/RETURNING CUSTOMERS/);
    expect(flow).not.toMatch(/# This is a CAMPAIGN/);
  });
  it('a campaign: a window and its hook, a total by the end date, launch / reminder / last call, deadlines, everyone leaves', () => {
    expect(once).toMatch(/# This is a CAMPAIGN \(one-time\)/);
    expect(once).toMatch(/THE WINDOW/);
    expect(once).toMatch(/THE GOAL AS A TOTAL by the end date/);
    expect(once).toMatch(/a launch message that leads with the hook, a reminder midway .* a last call/);
    expect(once).toMatch(/do not set afterJourney or maxAttempts/);
    expect(once).not.toMatch(/THE STOPPING RULE/);
    expect(once).not.toMatch(/RETURNING CUSTOMERS/);
    expect(once).not.toMatch(/# This is a FLOW/);
  });
  it('the status says which it is, every turn', () => {
    expect(statusBlock(withKind('flow'))).toMatch(/This is a FLOW \(always on\)\. Dates: dates not set/);
    expect(statusBlock(withKind('campaign'))).toMatch(/This is a one-time CAMPAIGN/);
    const f = withKind('flow');
    expect(statusBlock({ ...f, campaign: camp({ ...f.campaign, schedule: { startDate: '2026-12-01' } }) })).toMatch(/from 1 Dec 2026, until stopped/);
  });
});

describe('starting points in the new-item popup', () => {
  it('are written for the kind: flows by days from joining, campaigns by a window', () => {
    for (const list of Object.values(BRIEF_SUGGESTIONS.flow)) for (const s of list) expect(s.brief).toMatch(/always-on .*flow/i);
    for (const list of Object.values(BRIEF_SUGGESTIONS.flow)) for (const s of list) expect(s.brief).toMatch(/of joining|before|join/);
    for (const list of Object.values(BRIEF_SUGGESTIONS.campaign)) for (const s of list) expect(s.brief).toMatch(/one-time|campaign/i);
  });
});
