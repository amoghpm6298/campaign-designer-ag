// Campaign Designer v2: the backend record (flags, timeline, plan file,
// questions), the toolkit, and the pure UI helpers. Nothing here calls a model.
import { describe, it, expect } from 'vitest';
import {
  addQuestions,
  initialState,
  normaliseQuestions,
  normaliseState,
  recordAnswers,
  requestChanges,
  requestSignoff,
  signOff,
  updatePlanFile,
} from '../../server/agent/state';
import { runV2Tool, V2_TOOLS, type ToolEnv } from '../../server/agent/tools';
import { V2_SYSTEM, statusBlock } from '../../server/agent/prompt';
import { resolveTenant } from '../../server/tenants';
import { FLAG_ORDER } from '../../server/agent/types';
import { buildTrace, composeReply, emptyField, mergeEvent } from '../../src/designer/v2/logic';
import type { V2Event } from '../../src/designer/v2/types';

const env = (): ToolEnv => ({
  tenant: resolveTenant('TEN-IBL')!,
  availableChannels: ['WHATSAPP', 'SMS', 'EMAIL'] as never,
  goalStatement: 'Drive spends during Diwali',
  sessionId: 't',
  lookupCache: new Map(),
});

describe('flags', () => {
  it('start all false and survive a round trip through normaliseState', () => {
    const s = initialState();
    expect(FLAG_ORDER.every((f) => s.flags[f] === false)).toBe(true);
    expect(normaliseState(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(normaliseState(null).flags.goalClear).toBe(false);
  });

  it('questionsAnswered goes false when a question is asked and true when all are answered', () => {
    let s = addQuestions(initialState(), [
      { aspect: 'Goal', text: 'What should change?', answerType: 'single', options: ['Spend more', 'Spend more often'] },
      { aspect: 'Success', text: 'How do you judge it?', answerType: 'open' },
    ]).state;
    expect(s.flags.questionsAnswered).toBe(false);
    const [q1, q2] = s.questions;
    s = recordAnswers(s, { [q1.id]: 'Spend more' }, '');
    expect(s.flags.questionsAnswered).toBe(false);
    s = recordAnswers(s, { [q2.id]: 'Total rupee spend' }, '');
    expect(s.flags.questionsAnswered).toBe(true);
    s = addQuestions(s, [{ aspect: 'Timing', text: 'When should it run?', answerType: 'open' }]).state;
    expect(s.flags.questionsAnswered).toBe(false);
  });

  it('a free-text reply answers every open question; a form answer leaves blanks open', () => {
    let s = addQuestions(initialState(), [
      { aspect: 'Goal', text: 'A?', answerType: 'open' },
      { aspect: 'Goal', text: 'B?', answerType: 'open' },
    ]).state;
    const form = recordAnswers(s, { [s.questions[0].id]: 'x' }, 'ignored');
    expect(form.questions.filter((q) => q.answer).length).toBe(1);
    s = recordAnswers(s, undefined, 'both answered here');
    expect(s.questions.every((q) => q.answer)).toBe(true);
  });

  it('sign-off from the button or from chat sets the flag; editing a signed-off brief clears both sign-offs', () => {
    let s = updatePlanFile(initialState(), { section: 'brief', findings: [{ aspect: 'Goal', text: 'Spend more', source: 'manager' }] }).state;
    s = requestSignoff(s, 'brief', '');
    expect(s.flags.briefReady).toBe(true);
    expect(s.pendingSignoff).toBe('brief');
    s = signOff(s, 'brief', 'user', '');
    expect(s.flags.briefSignedOff).toBe(true);
    expect(s.pendingSignoff).toBe(null);
    s = signOff(s, 'plan', 'agent', '"looks good"');
    expect(s.flags.planSignedOff).toBe(true);
    s = updatePlanFile(s, { section: 'brief', findings: [{ aspect: 'Goal', text: 'Spend more often', source: 'manager' }] }).state;
    expect(s.flags.briefSignedOff).toBe(false);
    expect(s.flags.planSignedOff).toBe(false);
    expect(s.timeline.filter((t) => t.type === 'signed_off').length).toBe(2);
  });

  it('request changes clears ready and the pending sign-off', () => {
    let s = requestSignoff(initialState(), 'plan', '');
    s = requestChanges(s, 'plan', 'fewer messages');
    expect(s.flags.planReady).toBe(false);
    expect(s.pendingSignoff).toBe(null);
    expect(s.timeline.at(-1)?.type).toBe('changes_requested');
  });
});

describe('ask_questions normalisation', () => {
  it('title-cases and merges aspect labels, strips Other, downgrades thin choice questions to open', () => {
    const { questions } = normaliseQuestions(
      [
        { aspect: 'goal', text: 'One?', answerType: 'single', options: ['A', 'B', 'Other'] },
        { aspect: 'Goal ', text: 'Two?', answerType: 'multi', options: ['Only one'] },
        { aspect: '', text: 'Three?', answerType: 'weird' },
        { aspect: 'x', text: '   ' },
      ],
      [],
      0,
    );
    expect(questions.map((q) => q.aspect)).toEqual(['Goal', 'Goal', 'General']);
    expect(questions[0].options).toEqual(['A', 'B']);
    expect(questions[1].answerType).toBe('open');
    expect(questions[1].suggestions).toEqual(['Only one']);
    expect(questions[2].answerType).toBe('open');
    expect(questions.map((q) => q.id)).toEqual(['q1', 'q2', 'q3']);
  });

  it('caps one call at 12 questions', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ aspect: 'A', text: `Q${i}?`, answerType: 'open' }));
    expect(normaliseQuestions(many, [], 0).questions.length).toBe(12);
  });
});

describe('the toolkit', () => {
  it('offers every tool every time, including build', () => {
    const names = V2_TOOLS.map((t) => t.name);
    for (const n of ['ask_questions', 'update_plan_file', 'set_flags', 'request_signoff', 'record_user_acceptance', 'build_campaign', 'list_channels']) {
      expect(names).toContain(n);
    }
  });

  it('set_flags only touches agent-owned flags', () => {
    const out = runV2Tool(
      'set_flags',
      { changes: [{ flag: 'goalClear', value: true, reason: 'they said' }, { flag: 'briefSignedOff', value: true, reason: 'sneaky' }] },
      initialState(),
      env(),
    );
    expect(out.state.flags.goalClear).toBe(true);
    expect(out.state.flags.briefSignedOff).toBe(false);
    expect(out.forModel).toMatch(/Not yours to set: briefSignedOff/);
  });

  it('writing the plan before the brief is signed off is allowed and logged', () => {
    const out = runV2Tool('update_plan_file', { section: 'strategy', strategy: { hypothesis: 'h' } }, initialState(), env());
    expect(out.ok).toBe(true);
    expect(out.state.timeline.some((t) => t.type === 'acted_ahead_of_flags')).toBe(true);
  });

  it('build_campaign never refuses on flags: it builds and logs that it went ahead', () => {
    const journey = {
      campaignName: 'Diwali spends',
      description: 'Nudge spends in the festive window',
      goal: null,
      entry: { kind: 'audience', entity: 'Account', conditions: [] },
      steps: [
        { kind: 'send', name: 'Festive nudge', describe: 'Remind them of festive offers', channelPreference: ['WHATSAPP'], copy: 'Your card has festive offers this week.', cta: 'See offers' },
        { kind: 'wait', durationHours: 48 },
        { kind: 'send', name: 'Reminder', describe: 'Second reminder', channelPreference: ['SMS'], copy: 'Offers end soon.', cta: 'Shop now' },
      ],
    };
    const out = runV2Tool('build_campaign', { journey }, initialState(), env());
    expect(out.ok).toBe(true);
    expect(out.state.flags.campaignBuilt).toBe(true);
    expect(out.state.timeline.some((t) => t.type === 'acted_ahead_of_flags')).toBe(true);
    expect(out.build?.graph).toBeTruthy();
  });

  it('a lookup asked twice in one turn comes back cached', () => {
    const e = env();
    const first = runV2Tool('list_channels', {}, initialState(), e);
    const second = runV2Tool('list_channels', {}, initialState(), e);
    expect(first.ok).toBe(true);
    expect(second.summary).toMatch(/Already fetched/);
  });
});

describe('the prompt', () => {
  it('is one fixed prompt covering all three phases, and stays short', () => {
    expect(V2_SYSTEM).toMatch(/Phase 1: Brief/);
    expect(V2_SYSTEM).toMatch(/Phase 2: Plan/);
    expect(V2_SYSTEM).toMatch(/Phase 3: Build/);
    expect(V2_SYSTEM.length).toBeLessThan(15000);
  });

  it('the status block carries every flag value', () => {
    const block = statusBlock(initialState());
    for (const f of FLAG_ORDER) expect(block).toContain(`(${f}): false`);
  });
});

describe('UI helpers', () => {
  const ev = (p: Partial<V2Event>): V2Event => ({ runId: 'r', seq: 1, at: '', type: 'model.tool_call.started', status: 'running', title: '', ...p });

  it('merging a completion keeps the input sent at the start', () => {
    let list = mergeEvent([], ev({ seq: 1, correlationId: 't1', data: { tool: 'list_channels', input: { a: 1 } } }));
    list = mergeEvent(list, ev({ seq: 5, correlationId: 't1', type: 'model.tool_call.completed', status: 'ok', data: { tool: 'list_channels', result: ['SMS'] } }));
    expect(list).toHaveLength(1);
    expect(list[0].data?.input).toEqual({ a: 1 });
    expect(list[0].data?.result).toEqual(['SMS']);
    expect(list[0].status).toBe('ok');
  });

  it('the trace interleaves text and tools in the order they happened', () => {
    let list: V2Event[] = [];
    list = mergeEvent(list, ev({ seq: 1, type: 'model.text.delta', correlationId: 'text-0', data: { text: 'Let me ' } }));
    list = mergeEvent(list, ev({ seq: 2, type: 'model.text.delta', correlationId: 'text-0', data: { text: 'check.' } }));
    list = mergeEvent(list, ev({ seq: 3, correlationId: 'tool-1', title: 'Checked channels' }));
    list = mergeEvent(list, ev({ seq: 4, type: 'model.text.delta', correlationId: 'text-1', data: { text: 'Done.' } }));
    const trace = buildTrace(list);
    expect(trace.map((t) => t.kind)).toEqual(['text', 'tool', 'text']);
    expect(trace[0]).toMatchObject({ text: 'Let me check.' });
  });

  it('the form composes single, multi + Other and open answers, and omits blanks', () => {
    const qs = [
      { id: 'q1', aspect: 'Goal', text: 'What?', answerType: 'single' as const, options: ['A', 'B'] },
      { id: 'q2', aspect: 'Why not', text: 'Why?', answerType: 'multi' as const, options: ['X', 'Y'] },
      { id: 'q3', aspect: 'Why not', text: 'Seen?', answerType: 'open' as const },
      { id: 'q4', aspect: 'Timing', text: 'When?', answerType: 'open' as const },
    ];
    const { message, answers } = composeReply(qs, {
      q1: { ...emptyField(), picked: ['B'] },
      q2: { picked: ['X', 'Y'], other: true, text: 'prefer UPI' },
      q3: { ...emptyField(), text: 'nothing in particular' },
    });
    expect(answers).toEqual({ q1: 'B', q2: 'X, Y, Other: prefer UPI', q3: 'nothing in particular' });
    expect(message).toContain('**Goal**');
    expect(message).not.toContain('When?');
  });
});
