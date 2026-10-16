// Rules 2.1, 2.2, 2.4 and 2.5 — the design half.
//
// THE DEFECT, read off two complete live runs. Discovery found the right
// factors; the design did not use them. Both scenarios reduced to the same
// campaign: three messages, EMAIL -> SMS -> WhatsApp, fixed waits, a 10%
// holdout. The intelligence was all in the prose around it.
//
//   2.1  The only alternative weighed, in BOTH runs, was "send one message
//        instead of three" — a degenerate version of the same plan.
//   2.2  The user said urgency rises near the statement due date. The agent
//        confirmed Statement Due Date exists and is buildable for timing, then
//        built a Transaction-triggered sequence with fixed 48h/72h waits and
//        wrote "your next statement is coming up" to customers whose statement
//        might be three weeks away. The alternative entry was never compared.
//   2.4  "Adaptive sequencing — used" against that fixed ladder, the same
//        answer admitting "a qualitative adaptation, not a precise one".
//   2.5  It named both experiment arms in one sentence, then declined to build
//        the test "because the user has not indicated which specific cost
//        framings they want compared".
//
// 2.4 is the only one of the four the application can check: a journey is
// structured data, so a claim about its shape is verifiable. The others are
// judgement, required in the schema and the prompt so they are at least SAID.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { auditOptions, applyAudit, unsupportedClaims, UNCHECKABLE_OPTIONS } from '../../server/optionAudit';
import { renderStrategy, type Strategy } from '../../server/orchestrator';
import type { CampaignBlueprint, BpStep } from '../../server/blueprint';

const SYSTEM = (() => {
  const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
  return /const SYSTEM = `([\s\S]*?)`;\n/.exec(src)![1];
})();
const orch = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');

const send = (ch: string, copy = 'Convert your balance.'): BpStep => ({
  kind: 'send', name: `Send ${ch}`, objective: ['convert'], stage: 'reminder',
  describe: 'A message.', copy, channelPreference: [ch],
});
const bp = (steps: BpStep[], extra: Partial<CampaignBlueprint> = {}): CampaignBlueprint => ({
  campaignName: 'c', description: 'd',
  entry: { kind: 'event', eventCategory: 'Transaction Events', eventType: 'Transaction' },
  goal: null, steps, ...extra,
});

/** The exact journey the live run proposed: a fixed ladder. */
const FIXED_LADDER = bp([
  send('EMAIL'), { kind: 'wait', durationHours: 48 },
  send('SMS'), { kind: 'wait', durationHours: 72 },
  send('WHATSAPP'), { kind: 'exit', reason: 'done' },
]);

const used = (option: string) => [{ option, verdict: 'used' as const, why: 'Claimed.' }];

describe('2.4 — a used claim is checked against the journey', () => {
  it('a fixed ladder cannot pass as adaptive sequencing', () => {
    const [a] = auditOptions(used('Adaptive sequencing'), FIXED_LADDER);
    expect(a.claimed).toBe('used');
    expect(a.verified).toBe('cannot-evaluate');
    expect(a.gap).toMatch(/fixed sequence of sends and waits with no condition or wait-for-event/);
    expect(a.gap).toMatch(/Urgency in the wording is not adaptive timing/);
  });

  it('a journey that waits on an event does adapt', () => {
    const j = bp([send('EMAIL'), { kind: 'waitForEvent', eventCategory: 'EMI Events', eventType: 'EMI_STATUS_CHANGED', timeoutDays: 7 }, send('SMS')]);
    expect(auditOptions(used('Adaptive sequencing'), j)[0].verified).toBe('used');
  });

  it('branches that do the same thing are not conditional branching', () => {
    const same: BpStep[] = [send('SMS'), { kind: 'exit', reason: 'done' }];
    const j = bp([send('EMAIL'), { kind: 'condition', label: 'Delivered?', outcomes: ['DELIVERED'], yes: same, no: [...same] }]);
    const [a] = auditOptions(used('Conditional branching'), j);
    expect(a.verified).toBe('cannot-evaluate');
    expect(a.gap).toMatch(/the same sequence of actions on both branches/);
  });

  it('branches that differ do count', () => {
    const j = bp([send('EMAIL'), { kind: 'condition', label: 'Delivered?', outcomes: ['DELIVERED'],
      yes: [{ kind: 'wait', durationHours: 48 }, send('SMS')], no: [send('WHATSAPP')] }]);
    expect(auditOptions(used('Conditional branching'), j)[0].verified).toBe('used');
  });

  it('fallback must route the failure away from the channel that failed', () => {
    // Both branches continue on the SAME channel the opening used, so nothing
    // recovers from the failure.
    const j = bp([send('SMS'), { kind: 'condition', label: 'Delivered?', outcomes: ['DELIVERED'],
      yes: [send('SMS', 'A')], no: [send('SMS', 'B')] }]);
    const [a] = auditOptions(used('Channel fallback'), j);
    expect(a.verified).toBe('cannot-evaluate');
    expect(a.gap).toMatch(/to a channel other than the one that failed/);
  });

  it('counts a fallback whose branches share a channel but differ from the failed send', () => {
    // FALSE POSITIVE REGRESSION, from a real run. The agent opened on EMAIL;
    // on non-delivery it re-sent the OPENING on SMS, while the delivered path
    // moved on to a reminder — also on SMS. Comparing the two branches saw no
    // change and reported a working fallback as unimplemented. The customer
    // whose email failed WAS reached on another channel, which is the
    // mechanism. The comparison must be against the send that failed.
    const j = bp([send('EMAIL'), { kind: 'condition', label: 'Was the opening email delivered?',
      outcomes: ['DELIVERED'],
      yes: [{ kind: 'wait', durationHours: 48 }, send('SMS', 'Reminder.')],
      no: [{ kind: 'wait', durationHours: 48 }, send('SMS', 'Fallback opening.')] }]);
    expect(auditOptions(used('Channel fallback'), j)[0].verified).toBe('used');
  });

  it('finds the failed send inside an experiment arm, not just at the top level', () => {
    const j = bp([{ kind: 'experiment', label: 'x', arms: [
      { label: 'A', pct: 50, steps: [send('EMAIL'), { kind: 'condition', label: 'Delivered?',
        outcomes: ['DELIVERED'], yes: [send('SMS', 'r')], no: [send('SMS', 'f')] }] },
      { label: 'B', pct: 50, steps: [send('EMAIL', 'other')] }] }]);
    expect(auditOptions(used('Channel fallback'), j)[0].verified).toBe('used');
  });

  it('identical experiment arms are one treatment counted twice', () => {
    const arm: BpStep[] = [send('EMAIL', 'Same copy.')];
    const j = bp([{ kind: 'experiment', label: 'x', arms: [
      { label: 'A', pct: 50, steps: arm }, { label: 'B', pct: 50, steps: [...arm] }] }]);
    const [a] = auditOptions(used('Experimentation'), j);
    expect(a.verified).toBe('cannot-evaluate');
    expect(a.gap).toMatch(/both arms are the same treatment/);
  });

  it('arms with different copy are a real test', () => {
    const j = bp([{ kind: 'experiment', label: 'x', arms: [
      { label: 'Cost-led', pct: 50, steps: [send('EMAIL', 'Know your total cost upfront.')] },
      { label: 'Awareness-led', pct: 50, steps: [send('EMAIL', 'You can convert this to EMI.')] }] }]);
    expect(auditOptions(used('Experimentation'), j)[0].verified).toBe('used');
  });

  it('a holdout alone supports the weaker experimentation claim', () => {
    expect(auditOptions(used('Experimentation'), bp([send('EMAIL')], { controlPct: 10 }))[0].verified).toBe('used');
    expect(auditOptions(used('Experimentation'), bp([send('EMAIL')]))[0].verified).toBe('cannot-evaluate');
  });

  it('one path for everyone is not segmentation', () => {
    const [a] = auditOptions(used('Segmentation'), bp([send('EMAIL')]));
    expect(a.verified).toBe('cannot-evaluate');
    expect(a.gap).toMatch(/one path for everyone and the entry narrows nobody/);
  });
});

describe('2.4 — the audit only ever downgrades', () => {
  it('leaves not-applicable and cannot-evaluate alone', () => {
    for (const verdict of ['not-applicable', 'cannot-evaluate'] as const) {
      const [a] = auditOptions([{ option: 'Adaptive sequencing', verdict, why: 'w' }], FIXED_LADDER);
      expect(a.verified, verdict).toBe(verdict);
      expect(a.gap).toBeUndefined();
    }
  });

  it('names what it cannot check instead of silently passing it', () => {
    // "Unchecked" must never read as "verified".
    expect(UNCHECKABLE_OPTIONS).toEqual(['measurement and learning', 'cost and fatigue']);
    for (const o of ['Measurement and learning', 'Cost and fatigue']) {
      expect(auditOptions(used(o), FIXED_LADDER)[0].verified, o).toBe('used');
    }
  });

  it('does nothing without a blueprint, and never invents one', () => {
    expect(auditOptions(used('Adaptive sequencing'), null)).toEqual([]);
    expect(auditOptions(undefined, FIXED_LADDER)).toEqual([]);
  });

  it('keeps the agent reasoning and appends the correction', () => {
    const opts = [{ option: 'Adaptive sequencing', verdict: 'used' as const, why: 'Tone shifts to urgency.' }];
    const [out] = applyAudit(opts, auditOptions(opts, FIXED_LADDER));
    expect(out.verdict).toBe('cannot-evaluate');
    expect(out.why).toContain('Tone shifts to urgency.');
    expect(out.why).toContain('[Not supported by the proposed journey:');
  });
});

describe('2.4 — the discrepancy reaches the user', () => {
  it('renders the claims the journey did not support', () => {
    const out = renderStrategy({ summary: 'S.', approach: ['A'], assumptions: [], unknowns: [] }, [], null, [], [], [
      { option: 'Adaptive sequencing', gap: 'the journey is a fixed sequence.' },
    ]);
    expect(out).toContain('**Claims the journey does not support**');
    expect(out).toContain('Adaptive sequencing was marked used, but the journey is a fixed sequence.');
  });

  it('says nothing when every claim held', () => {
    expect(renderStrategy({ summary: 'S.', approach: ['A'], assumptions: [], unknowns: [] })).not.toContain('Claims the journey does not support');
  });

  it('is wired into the proposal path, not merely callable', () => {
    expect(orch).toMatch(/const optionAudits: OptionAudit\[\] = auditOptions\(proposed\.strategy\?\.strategyOptions, blueprint\)/);
    expect(orch).toMatch(/strategyOptions: applyAudit\(proposed\.strategy\.strategyOptions, optionAudits\)/);
    expect(orch).toMatch(/unsupportedClaims\(optionAudits\)/);
  });
});

describe('2.1 and 2.2 — architectures are compared, not assumed', () => {
  it('requires two candidates and names what must differ', () => {
    expect(SYSTEM).toMatch(/BUILD TWO CANDIDATE ARCHITECTURES, THEN CHOOSE/);
    expect(SYSTEM).toMatch(/the entry and audience \(who is reached\), the mechanism[\s\S]*?triggering and timing logic/);
    expect(SYSTEM).toMatch(/FEWER MESSAGES IS NOT A DIFFERENT APPROACH/);
    expect(SYSTEM).toMatch(/Neither is a different tone, channel order or send count/);
    expect(SYSTEM).toMatch(/reach DIFFERENT PEOPLE, at a DIFFERENT MOMENT, or by a DIFFERENT MEANS/);
  });

  it('forbids reporting a factor as unbuildable before trying another entry', () => {
    expect(SYSTEM).toMatch(/A FACTOR THE FIRST CANDIDATE CANNOT CARRY IS NOT A PLATFORM LIMITATION/);
    expect(SYSTEM).toMatch(/"This entry cannot express it" is a fact about the entry you chose, not about the platform/);
    expect(SYSTEM).toMatch(/Only when neither candidate can carry it is it a limitation/);
    // And keeping the first anyway is allowed, but must be declared.
    expect(SYSTEM).toMatch(/say plainly that you traded the factor away and what that costs/);
  });

  it('carries the comparison in the schema, so it cannot stay in prose', () => {
    expect(orch).toMatch(/architectures\?: \{/);
    for (const f of ['name', 'entry', 'mechanism', 'timing', 'tradeoff', 'chosen', 'whyChosen']) {
      expect(SYSTEM, f).toContain(`"${f}"`);
    }
  });

  it('renders the alternatives above the detail of the winner', () => {
    const s: Strategy = {
      summary: 'S.', approach: ['A'], assumptions: [], unknowns: [],
      architectures: [
        { name: 'Transaction-triggered', entry: 'Transaction / EMI Eligible', mechanism: 'Surface the option',
          timing: 'Fires on an eligible purchase', tradeoff: 'Blind to the statement cycle', chosen: true,
          whyChosen: 'The user named eligibility, not timing, as the harder constraint.' },
        { name: 'Due-date audience', entry: 'Account / Statement Due Date', mechanism: 'Use billing urgency',
          timing: 'Fires near the due date', tradeoff: 'No proof of an eligible transaction', chosen: false },
      ],
    };
    const out = renderStrategy(s);
    expect(out).toContain('**Approaches considered**');
    expect(out).toContain('**Transaction-triggered** — chosen');
    expect(out).toContain('Account / Statement Due Date');
    expect(out).toContain('What it gives up: Blind to the statement cycle');
    expect(out).toContain('Why this one: The user named eligibility');
    // Above the winner's detail: the choice reads before its elaboration.
    expect(out.indexOf('Approaches considered')).toBeLessThan(out.indexOf('**Approach**'));
  });

  it('omits the section when no alternatives were recorded', () => {
    expect(renderStrategy({ summary: 'S.', approach: ['A'], assumptions: [], unknowns: [] })).not.toContain('Approaches considered');
  });
});

describe('2.5 — a viable experiment is written, not requested', () => {
  it('forbids asking the user for copy variants', () => {
    expect(SYSTEM).toMatch(/IF YOU CAN NAME THE ARMS, WRITE THEM/);
    expect(SYSTEM).toMatch(/a test is never blocked on the user supplying copy/);
    expect(SYSTEM).toMatch(/asking them for message variants is asking them to do your job/);
  });

  it('requires the test to be fully specified', () => {
    expect(SYSTEM).toMatch(/give each arm a real intervention and real copy/);
    expect(SYSTEM).toMatch(/state the outcome you would read and the comparison you would read it against/);
  });

  it('allows unavailable only when the journey cannot express it', () => {
    expect(SYSTEM).toMatch(/Only call an experiment unavailable when the journey cannot express it, never because nobody has written the words yet/);
  });

  it('the agent is still told to write the copy itself', () => {
    // Pre-existing rule, asserted here because 2.5 depends on it.
    expect(SYSTEM).toMatch(/Never ask for message copy or CTA wording — write those yourself/);
  });
});

describe('the earlier safeguards are untouched', () => {
  it('fork blocking, no-proxy and risk visibility all still present', () => {
    expect(orch).toMatch(/\|\| forkUnanswered \|\| dimensionUnresolved\) \{/);
    expect(SYSTEM).toMatch(/DO NOT CLOSE THAT GAP WITH A NEAR-ENOUGH ATTRIBUTE/);
    expect(SYSTEM).toMatch(/a single event's value is not a running total/);
    expect(orch).toMatch(/Proceeding without an answer on/);
    expect(orch).toMatch(/const MAX_REPEAT_ROUNDS = 2;/);
  });
});
