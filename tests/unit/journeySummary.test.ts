// The campaign, written out before anyone approves it.
//
// THE DEFECT, in the user's words: "I can't really understand the final design
// before the graph execution." The proposal carried the summary, two candidate
// architectures with eight fields each, seven option verdicts, assumptions and
// open items — and never said who gets what, when. The journey had to be
// reconstructed from fragments across "Timing:", "Why it should work:" and the
// approach bullets. Every fact below was already in the blueprint. None of it
// was shown.
import { describe, it, expect } from 'vitest';
import { journeySummary, entryLine, goalLine, stepLines, readableBlocker } from '../../server/journeySummary';
import type { CampaignBlueprint, BpStep } from '../../server/blueprint';

const send = (name: string, ch = 'EMAIL', over: Partial<Extract<BpStep, { kind: 'send' }>> = {}): BpStep => ({
  kind: 'send', name, objective: ['emi'], stage: 'first-touch', describe: 'd', channelPreference: [ch], ...over,
});

const bp = (over: Partial<CampaignBlueprint> = {}): CampaignBlueprint => ({
  campaignName: 'c', description: 'd',
  goal: { eventCategory: 'EMI Events', eventType: 'EMI_STATUS_CHANGED', conditions: [{ attribute: 'New Status', operator: 'Equals', value: 'Successful' }] },
  entry: { kind: 'audience', entity: 'Account', conditions: [{ attribute: 'Status', operator: 'Equals', value: 'Active' }] },
  steps: [send('Convert your balance'), { kind: 'wait', durationHours: 48 }, send('Still available', 'SMS')],
  ...over,
});

describe('who enters and what counts as success', () => {
  it('describes an audience entry in a sentence', () => {
    expect(entryLine(bp())).toBe('Enters anyone on **Account** where Status equals Active.');
  });

  it('describes an event entry', () => {
    expect(entryLine(bp({ entry: { kind: 'event', eventCategory: 'Transaction Events', eventType: 'Transaction' } })))
      .toBe('Enters when **Transaction** happens.');
  });

  it('says that reaching the goal ends the journey', () => {
    expect(goalLine(bp())).toContain('Anyone who does leaves immediately');
  });

  it('is honest when no goal is set', () => {
    expect(goalLine(bp({ goal: null }))).toContain('nobody exits early');
  });
});

describe('the clock is cumulative, which is the whole point', () => {
  it('moves a message to the day its waits put it on', () => {
    const lines = stepLines(bp().steps);
    expect(lines[0]).toContain('Day 0');
    expect(lines[1]).toContain('Day 2'); // after a 48h wait
    expect(lines[1]).toContain('SMS');
  });

  it('keeps branches on the campaign clock, not their own', () => {
    // A branch at day 2 whose first message waits another 48h lands on day 4 —
    // not day 2. Restarting the clock per branch would misreport every
    // multi-path campaign.
    const lines = stepLines([
      send('First'),
      { kind: 'wait', durationHours: 48 },
      { kind: 'condition', label: 'opened?', outcomes: ['DELIVERED'],
        yes: [{ kind: 'wait', durationHours: 48 }, send('Follow up', 'WHATSAPP')],
        no: [send('Try another channel', 'SMS')] },
    ]);
    const joined = lines.join('\n');
    expect(joined).toContain('**Day 4** — WHATSAPP: Follow up');
    expect(joined).toContain('**Day 2** — SMS: Try another channel');
  });

  it('shows both sides of a branch, labelled', () => {
    const joined = stepLines([
      send('First'),
      { kind: 'condition', label: 'x', outcomes: ['DELIVERED'], yes: [send('A')], no: [send('B')] },
    ]).join('\n');
    expect(joined).toContain('**If it was:**');
    expect(joined).toContain('**If it was not:**');
  });

  it('shows experiment arms with their split', () => {
    const joined = stepLines([
      { kind: 'experiment', label: 'test', tests: 'wording',
        arms: [{ label: 'A', pct: 50, steps: [send('One')] }, { label: 'B', pct: 50, steps: [send('Two')] }] } as unknown as BpStep,
    ]).join('\n');
    expect(joined).toContain('50% — A');
    expect(joined).toContain('to test wording');
  });
});

describe('the whole summary', () => {
  it('leads with the campaign, not with reasoning about it', () => {
    const out = journeySummary(bp({ controlPct: 10 }));
    expect(out).toContain('**The campaign**');
    expect(out).toContain('Enters anyone on **Account**');
    expect(out).toContain('10% are held back');
  });

  it('renders nothing at all when there is no campaign yet', () => {
    // A discovery turn must not show an empty heading.
    expect(journeySummary(null)).toBe('');
    expect(journeySummary({ ...bp(), entry: undefined as never })).toBe('');
  });
});

describe('blockers stop being paths into the data', () => {
  it('translates the measured one', () => {
    // Shown verbatim to a campaign manager at the exact moment they are trying
    // to work out what is stopping them shipping.
    const out = readableBlocker('steps[0].experiment.arms[0][1].wait: 2 open slots exist; the continuation is ambiguous.');
    expect(out).toContain('step 1');
    expect(out).toContain('arm 1');
    expect(out).toContain('does not say what happens next');
    expect(out).not.toContain('steps[0]');
  });

  it('leaves something it cannot parse alone rather than mangling it', () => {
    expect(readableBlocker('Something went wrong')).toBe('Something went wrong');
  });
});
