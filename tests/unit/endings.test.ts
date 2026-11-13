// Journey endings: the agent says how each customer leaves, the "Anything
// else" route can carry steps, recurring campaigns decide what happens after
// the journey. Code makes it buildable, checks it, and holds the hard lines;
// it never writes an ending itself.
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFromBlueprint, type BpStep } from '../../server/blueprint';
import { checkJourneys, endingGaps, planToBlueprint } from '../../server/agent/compile';
import { initialState, journeyErrors, parseAfterJourney } from '../../server/agent/state';
import { runToolCall, type ToolEnv } from '../../server/agent/tools';
import { resolveTenant } from '../../server/tenants';
import { diffCampaigns } from '../../server/agent/versionDiff';
import { saveCampaignObject } from '../../server/campaignFiles';
import { directEdit } from '../../server/agent/directEdit';
import { buildCanvasModel } from '../../src/designer/v2/canvasModel';
import type { CampaignObject } from '../../server/agent/types';

const env = (): ToolEnv => ({ tenant: resolveTenant('TEN-YES')!, availableChannels: ['SMS', 'WHATSAPP', 'EMAIL'], goalStatement: 'x', sessionId: 's1', lookupCache: new Map() });
const send = (name: string, ch = 'WHATSAPP') => ({ kind: 'send', name, stage: 'first-touch', describe: name, objective: ['activation'], channelPreference: [ch] });
const exit = (outcome?: string, reason = 'End') => ({ kind: 'exit', reason, ...(outcome ? { outcome } : {}) });
/** The response window after a last message. */
const win = { kind: 'wait', durationHours: 96 };

/** A WhatsApp, then a read / not-read branch, with an "Anything else" route. */
const designed = (otherwise?: unknown[]) =>
  [
    send('First'),
    { kind: 'wait', durationHours: 48 },
    {
      kind: 'branch',
      label: 'Did they read it?',
      paths: [
        { label: 'Read', statuses: ['READ'], steps: [send('Different argument'), win, exit('no_response')] },
        { label: 'Not read', statuses: ['DELIVERED'], steps: [send('Resend', 'SMS'), win, exit('no_response')] },
      ],
      ...(otherwise ? { otherwise } : {}),
    },
  ] as unknown as BpStep[];

const campaign = (journey: BpStep[], extra: Partial<CampaignObject> = {}): CampaignObject => ({
  name: 'Activation',
  goal: { eventCategory: 'Card Events', eventType: 'Card Activated' },
  entry: { kind: 'audience', entity: 'Card' },
  membership: { type: 'open', refresh: 'weekly' },
  everyoneElse: { approach: 'none' },
  buckets: [{ id: 'b1', name: 'Fresh', priority: 1, rule: [{ entity: 'Card', conditions: [] }], journey }],
  afterJourney: { no_response: 14, not_reachable: 30, declined: 30, converted: 'leave' },
  maxAttempts: 2,
  ...extra,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cd-endings-'));
  process.env.CAMPAIGN_DIR = dir;
});

describe('the "Anything else" route', () => {
  it('builds the steps the agent wrote onto the branch\'s catch-all', () => {
    const c = campaign(designed([send('Email try', 'EMAIL'), exit('not_reachable', 'Never reached')]));
    const bp = planToBlueprint(c).blueprint!;
    const r = buildFromBlueprint(bp, { availableChannels: ['SMS', 'WHATSAPP', 'EMAIL'], templateLibraryAccess: 'unavailable' });
    const g = r.graph as { nodes: Record<string, { id: string; type: string; _config?: Record<string, unknown> }>; edges: { from: string; to: string | null; branchLabel?: string }[] };
    const split = Object.values(g.nodes).find((n) => n.type === 'DECISION_SPLIT')!;
    const elseEdge = g.edges.find((e) => e.from === split.id && e.branchLabel === 'Anything else')!;
    expect(elseEdge.to).not.toBeNull();
    expect(g.nodes[elseEdge.to!].type).toBe('SEND');
    expect(g.nodes[elseEdge.to!]._config?.channel).toBe('EMAIL');
    expect(r.issues).toEqual([]);
  });

  it('is left open (not filled by code) when the agent wrote nothing, and the check asks it to decide', () => {
    const c = campaign(designed());
    const gaps = endingGaps(c);
    expect(gaps.join(' ')).toMatch(/"Anything else" route is not decided/);
    expect(gaps.join(' ')).toMatch(/never reached/);
    // The campaign object itself is untouched.
    expect(JSON.stringify(c.buckets[0].journey)).not.toMatch(/otherwise/);
  });

  it('refuses a resend on the channel that just failed', () => {
    expect(journeyErrors(designed([send('Again', 'WHATSAPP'), exit('not_reachable')])).join(' ')).toMatch(/WHATSAPP just failed to reach/);
    expect(journeyErrors(designed([send('Email try', 'EMAIL'), exit('not_reachable')]))).toEqual([]);
  });

  it('can be addressed and edited precisely', () => {
    let s = runToolCall('edit_campaign', { name: 'A', goal: { eventCategory: 'Card Events', eventType: 'Card Activated' }, entry: { entity: 'Card' }, membership: { type: 'locked' }, everyoneElse: { approach: 'none' } }, initialState(), env()).state;
    s = runToolCall('edit_bucket', { id: 'b1', name: 'Fresh', priority: 1, rule: [{ entity: 'Card', conditions: [] }], journey: designed([exit('not_reachable')]) }, s, env()).state;
    const out = runToolCall('edit_journey', { bucketId: 'b1', operations: [{ op: 'insert_before', path: '2.otherwise.0', step: send('Email try', 'EMAIL') }] }, s, env());
    expect(out.ok).toBe(true);
    const branch = (out.state.campaign.buckets[0].journey as unknown as { otherwise?: { name?: string; id?: string }[] }[])[2];
    expect(branch.otherwise?.[0].name).toBe('Email try');
    expect(branch.otherwise?.[0].id).toBeTruthy();
  });
});

describe('endings', () => {
  it('a fully designed journey has no open ending decisions', () => {
    expect(endingGaps(campaign(designed([send('Email try', 'EMAIL'), win, exit('no_response')])))).toEqual([]);
  });

  it('names every path that stops without saying how the customer left', () => {
    const j = [send('First'), { kind: 'branch', label: 'Read?', paths: [{ label: 'Read', statuses: ['READ'], steps: [send('R')] }], otherwise: [exit('not_reachable')] }, exit()] as unknown as BpStep[];
    const gaps = endingGaps(campaign(j)).join(' | ');
    expect(gaps).toMatch(/the exit "End" does not say how the customer left/);
    expect(endingGaps(campaign([send('Only')] as unknown as BpStep[])).join(' ')).toMatch(/ends after "Only"/);
  });

  it('a trailing exit with an outcome closes every arm still open above it', () => {
    const j = [send('First'), { kind: 'branch', label: 'Read?', paths: [{ label: 'Read', statuses: ['READ'], steps: [send('R'), win] }, { label: 'Not read', statuses: ['DELIVERED'], steps: [send('N', 'SMS'), win] }], otherwise: [exit('not_reachable')] }, exit('no_response')] as unknown as BpStep[];
    expect(endingGaps(campaign(j))).toEqual([]);
  });

  it('every last message gets a response window before its exit (the agent picks the length)', () => {
    // send → exit: closed out before they could act
    expect(endingGaps(campaign([send('Only'), exit('no_response')] as unknown as BpStep[])).join(' ')).toMatch(/comes straight after "Only".*response window/);
    // send → wait → exit: fine
    expect(endingGaps(campaign([send('Only'), win, exit('no_response')] as unknown as BpStep[]))).toEqual([]);
    // a fork arm ending on a send, flowing into the trailing exit
    const j = [send('First'), { kind: 'branch', label: 'Read?', paths: [{ label: 'Read', statuses: ['READ'], steps: [send('R')] }], otherwise: [exit('not_reachable')] }, exit('no_response')] as unknown as BpStep[];
    expect(endingGaps(campaign(j)).join(' ')).toMatch(/arm|path "Read".*straight after "R"/);
    // the "Anything else" retry: email → exit is flagged, email → wait → exit is not
    expect(endingGaps(campaign(designed([send('Email try', 'EMAIL'), exit('not_reachable')]))).join(' ')).toMatch(/Anything else.*straight after "Email try"/);
    // the code never adds the wait itself
    const c = campaign([send('Only'), exit('no_response')] as unknown as BpStep[]);
    endingGaps(c);
    expect(c.buckets[0].journey).toHaveLength(2);
  });

  it('only checks journeys changed since the turn began', () => {
    const before = campaign([send('Only')] as unknown as BpStep[]);
    const after = { ...before, name: 'Renamed' };
    expect(endingGaps(after, before)).toEqual([]);
    expect(endingGaps(after)).not.toEqual([]);
  });

  it('a recurring campaign must decide what happens after the journey; a one-time one need not', () => {
    const j = designed([exit('not_reachable')]);
    expect(endingGaps(campaign(j, { afterJourney: null })).join(' ')).toMatch(/what happens after the journey is not decided/);
    expect(endingGaps(campaign(j, { afterJourney: null, membership: { type: 'locked' } }))).toEqual([]);
  });

  it('repair-on-open leaves design decisions alone (broken things only)', () => {
    const c = campaign([send('Only')] as unknown as BpStep[]);
    expect(checkJourneys(c, undefined, true, true)).toEqual([]);
    expect(checkJourneys(c).length).toBeGreaterThan(0);
  });

  it('build_campaign reports open endings separately from things to fix', () => {
    let s = runToolCall('edit_campaign', { name: 'A', goal: { eventCategory: 'Card Events', eventType: 'Card Activated' }, entry: { entity: 'Card' }, membership: { type: 'locked' }, everyoneElse: { approach: 'none' } }, initialState(), env()).state;
    s = runToolCall('edit_bucket', { id: 'b1', name: 'Fresh', priority: 1, rule: [{ entity: 'Card', conditions: [] }], journey: [send('Only')] }, s, env()).state;
    const out = runToolCall('build_campaign', {}, s, env());
    expect(out.forModel).toMatch(/ENDINGS NOT DECIDED YET/);
    expect(out.forModel).not.toMatch(/FIX BEFORE YOU FINISH/);
  });
});

describe('hard lines', () => {
  it('an exit cannot claim converted, or anything outside the outcomes', () => {
    expect(journeyErrors([exit('converted')] as unknown as BpStep[]).join(' ')).toMatch(/goal check already takes converted/);
    expect(journeyErrors([exit('opted_out')] as unknown as BpStep[]).join(' ')).toMatch(/handled by the system/);
    expect(journeyErrors([exit('bored')] as unknown as BpStep[]).join(' ')).toMatch(/must be one of/);
  });

  it('no bucket rule may target opted-out customers', () => {
    const s = runToolCall('edit_bucket', { id: 'x', name: 'Opted out', priority: 1, rule: [{ entity: 'Customer', conditions: [{ attribute: 'Opted Out', operator: 'Equals', value: 'Yes' }] }], journey: [send('Hi')] }, initialState(), env());
    expect(s.ok).toBe(false);
    expect(s.state.campaign.buckets).toHaveLength(0);
  });

  it('afterJourney never takes opted out, and reads days or "leave"', () => {
    expect(parseAfterJourney({ opted_out: 30 }).error).toMatch(/never come back/);
    expect(parseAfterJourney({ no_response: 'soon' }).error).toMatch(/number of days/);
    expect(parseAfterJourney({ no_response: '14', converted: 'leave' }, { declined: 30 }).value).toEqual({ declined: 30, no_response: 14, converted: 'leave' });
  });
});

describe('after the journey: direct edit and versions', () => {
  it('the manager changes a rest period directly; it is versioned and diffed', () => {
    const c = campaign(designed([exit('not_reachable')]));
    saveCampaignObject('d1', 'TEN-YES', c);
    const r = directEdit('d1', 'TEN-YES', { op: 'afterJourney', outcome: 'no_response', value: 21 });
    expect(r.ok).toBe(true);
    expect(r.campaign?.afterJourney?.no_response).toBe(21);
    expect(r.timeline?.note).toMatch(/Didn't respond: can rejoin after 14 days → can rejoin after 21 days/);
    const d = diffCampaigns(c, r.campaign!);
    expect(JSON.stringify(d)).toMatch(/no response: can rejoin after 14 days → can rejoin after 21 days/);
  });
});

describe('canvas', () => {
  it('end pills show how the customer left and what happens next', () => {
    const c = campaign(designed([send('Email try', 'EMAIL'), exit('not_reachable')]));
    const m = buildCanvasModel(c as never);
    const ends = m.nodes.filter((n) => n.data.kind === 'exit');
    expect(ends.map((n) => [n.data.outcome, n.data.after])).toEqual(
      expect.arrayContaining([
        ['no_response', 'can rejoin in 14 days'],
        ['not_reachable', 'can rejoin in 30 days'],
      ]),
    );
    // The "Anything else" route draws its email, not a fixed exit.
    expect(m.edges.some((e) => e.label === 'Anything else' && m.nodes.find((n) => n.id === e.target)?.data.step?.name === 'Email try')).toBe(true);
  });

  it('an ending the agent has not decided is shown as not decided', () => {
    const m = buildCanvasModel(campaign([send('Only')] as unknown as BpStep[]) as never);
    const end = m.nodes.find((n) => n.id === 'b1:end');
    expect(end?.data.outcome).toBe('undecided');
  });
});

describe('the stopping rule', () => {
  const hist = (times: string, op = 'Equals') => [{ entity: 'Campaign History', conditions: [{ attribute: 'Last Outcome', operator: 'Equals', value: "Didn't respond" }, { attribute: 'Times Through This Campaign', operator: op, value: times }] }];

  it('a recurring campaign without one is an open decision; a one-time campaign needs none', () => {
    const j = designed([exit('not_reachable')]);
    expect(endingGaps(campaign(j, { maxAttempts: null })).join(' ')).toMatch(/no stopping rule/);
    expect(endingGaps(campaign(j, { maxAttempts: null, membership: { type: 'locked' } }))).toEqual([]);
  });

  it('is set by the agent (1 to 10) and directly by the manager, versioned', () => {
    expect(runToolCall('edit_campaign', { maxAttempts: 0 }, initialState(), env()).ok).toBe(false);
    expect(runToolCall('edit_campaign', { maxAttempts: 2 }, initialState(), env()).state.campaign.maxAttempts).toBe(2);
    const c = campaign(designed([exit('not_reachable')]));
    saveCampaignObject('d2', 'TEN-YES', c);
    const r = directEdit('d2', 'TEN-YES', { op: 'maxAttempts', value: 3 });
    expect(r.ok).toBe(true);
    expect(r.campaign?.maxAttempts).toBe(3);
    expect(JSON.stringify(diffCampaigns(c, r.campaign!))).toMatch(/times through the campaign: at most 2 → at most 3/);
  });

  it('a returning bucket must target one attempt, never "more than"', () => {
    const bad = runToolCall('edit_bucket', { id: 'r', name: 'Repeat', priority: 1, rule: hist('0', 'Greater than'), journey: [send('Hi', 'SMS'), exit('no_response')] }, initialState(), env());
    expect(bad.ok).toBe(false);
    expect(String(bad.forModel)).toMatch(/one specific attempt/);
    const good = runToolCall('edit_bucket', { id: 'r', name: 'Repeat', priority: 1, rule: hist('1'), journey: [send('Hi', 'SMS'), exit('no_response')] }, initialState(), env());
    expect(good.ok).toBe(true);
  });

  it('flags a returning bucket nobody can reach under the stopping rule', () => {
    const c = campaign(designed([exit('not_reachable')]));
    c.buckets.unshift({ id: 'r', name: 'Third time', priority: 0, rule: hist('2') as never, journey: [send('Hi', 'SMS'), exit('no_response')] as unknown as BpStep[] });
    expect(endingGaps(c).join(' ')).toMatch(/"Third time" is for customers on time 3 .* stops after 2/);
  });

  it('on the last time through, the canvas says they leave for good', () => {
    const c = campaign(designed([exit('not_reachable')]));
    c.buckets.unshift({ id: 'r', name: 'Repeat', priority: 0, rule: hist('1') as never, journey: [send('Hi', 'SMS'), exit('no_response')] as unknown as BpStep[] });
    const m = buildCanvasModel(c as never);
    const last = m.nodes.find((n) => n.data.lane === 'r' && n.data.kind === 'exit');
    expect(last?.data.after).toBe('leaves for good (last time through)');
    const first = m.nodes.find((n) => n.data.lane === 'b1' && n.data.kind === 'exit' && n.data.outcome === 'no_response');
    expect(first?.data.after).toBe('can rejoin in 14 days');
  });

  it('holdout customers end as Held back, set by the system, never by the agent', () => {
    const c = campaign(designed([exit('not_reachable')]), {});
    c.buckets[0].holdoutPct = 10;
    expect(JSON.stringify(planToBlueprint(c).blueprint)).toMatch(/"outcome":"held_back"/);
    expect(journeyErrors([exit('held_back')] as unknown as BpStep[]).join(' ')).toMatch(/holdout is the system/);
  });
});
