// Does the APPLICATION stop a proposal that walks past an unanswered fork, or
// has every live run simply been a well-behaved model?
//
// This matters because the evidence so far cannot tell those apart. In every
// real conversation the agent re-asked the audience question of its own accord,
// so `forkUnanswered` never had to fire. A guard that has never triggered is
// an untested guard.
//
// These drive the REAL orchestrator with a scripted API — the same harness
// used for the tool-repeat tests — and inject a model that misbehaves in the
// one way that matters: it declares a question a fork, does not get it
// answered, and proposes a full strategy anyway.
//
// CONTROLLED INJECTION, not a natural conversation. The model output here is
// written by the test, and nothing it shows should be read as live evidence of
// what the real model does.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { orchestrateStream } from '../../server/orchestrator';
import { seedKnowledgeBase } from '../../server/knowledge';
import {
  newBrief,
  recordQuestions,
  recordAnswer,
  recordAddressedQuestions,
  forksFallenBack,
  unansweredForks,
  type WorkingBrief,
} from '../../server/discovery';

const sse = (events: Record<string, unknown>[]) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

const jsonTurn = (payload: unknown) =>
  sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: JSON.stringify(payload) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 400 } },
  ]);

const AUDIENCE_FORK = 'Should this reach customers who never started an OS-to-EMI request, or ones already Pending?';

/** A complete, well-formed proposal. Nothing about it is malformed. */
const PROPOSAL = {
  action: 'propose',
  answered: [],
  converters: { shape: 'mostly big spenders', basis: 'user', knowledge: 'known' },
  barriers: [
    {
      id: 'cost-perception',
      statement: 'Customers believe converting to EMI is too expensive.',
      basis: 'user-belief',
      lever: 'message',
      quote: 'the rest think the interest is too expensive',
    },
  ],
  // Three lines of enquiry, each resolved, because discovery is not complete
  // on one: being certain about a single factor is not the same as having
  // considered the alternatives. Anything not carried into the design says
  // why it was ruled out.
  dimensions: [
    { name: 'Funnel stage', rationale: 'Who enters.', status: 'retained', basis: 'user' },
    { name: 'Statement timing', rationale: 'When the message lands.', status: 'deferred', basis: 'assumption', note: 'Ruled out: no statement-date attribute exists.' },
    { name: 'Channel preference', rationale: 'Where to reach them.', status: 'unavailable', basis: 'none', note: 'Ruled out: no per-customer channel history.' },
  ],
  strategy: {
    summary: 'Enter customers near their statement due date and prompt conversion.',
    approach: ['Entry on Account Status = Active, assuming the never-started cohort.'],
    assumptions: ['Assuming the never-started cohort, since the success measure implies acquisition.'],
    unknowns: ['Whether the business meant the Pending cohort instead.'],
    hypotheses: ['Cost transparency lifts conversion.'],
    successCriteria: ['More EMI Requests reaching Successful.'],
  },
  blueprint: {
    campaignName: 'OS-to-EMI nudge',
    description: 'Three touches before the due date.',
    entry: { kind: 'audience', entity: 'Account', conditions: [{ attribute: 'Status', operator: 'Equals', value: 'Active' }] },
    goal: { eventCategory: 'EMI Events', eventType: 'EMI_STATUS_CHANGED', conditions: [] },
    steps: [
      { kind: 'send', name: 'Opening', objective: ['convert'], stage: 'first-touch', describe: 'Explain EMI.', copy: 'Convert your balance to EMI.', cta: 'See plans', channelPreference: ['EMAIL'], barrier: 'cost-perception' },
      { kind: 'exit', reason: 'Done.' },
    ],
  },
};

function script(bodies: string[]) {
  const sent: string[] = [];
  let i = 0;
  vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
    sent.push(init.body);
    const body = bodies[Math.min(i, bodies.length - 1)];
    i += 1;
    return new Response(new TextEncoder().encode(body), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  return sent;
}

const knowledge = seedKnowledgeBase();

/**
 * The state after turn 1: the agent asked two questions, declaring the
 * audience one a FORK, and the user answered only the other.
 */
function stateAfterOneAnsweredRound(): WorkingBrief {
  let b = recordQuestions(newBrief('I want to increase OS-to-EMI conversions.'), [
    { text: 'How will you judge success?', impact: 'shaping' },
    { text: AUDIENCE_FORK, impact: 'fork' },
  ]);
  // The reply also carries the two customer findings the gate now requires:
  // who converts, and why the rest do not. A manager answering two
  // questions in one message is the ordinary case.
  b = recordAnswer(
    b,
    'Success is more EMI Requests reaching Successful. No target number. The ones who do convert are mostly big spenders, the rest think the interest is too expensive.',
  );
  // Only the success question was addressed. The fork was not.
  return recordAddressedQuestions(b, ['q1-0']);
}

async function runTurn(brief: WorkingBrief, extraUserTurn?: string) {
  const gen = orchestrateStream({
    sessionId: 'fork-guard',
    tenantId: 'TEN-IBL',
    knowledge,
    discoveryRounds: 1,
    brief,
    session: { state: 'AWAITING_USER_ANSWER', strategyVersion: 0, confirmedAt: null },
    messages: [
      { role: 'user', content: 'I want to increase OS-to-EMI conversions.' },
      { role: 'assistant', content: 'Two questions before I design anything.' },
      { role: 'user', content: 'Success is more EMI Requests reaching Successful. No target number.' },
      ...(extraUserTurn ? [{ role: 'user' as const, content: extraUserTurn }] : []),
    ],
  } as never);
  let out = await gen.next();
  while (!out.done) out = await gen.next();
  return out.value as Record<string, unknown>;
}

const OLD = process.env.ANTHROPIC_API_KEY;
process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
afterEach(() => {
  vi.unstubAllGlobals();
  process.env.ANTHROPIC_API_KEY = OLD ?? 'test-key-not-real';
});

describe('the fork is genuinely unanswered before the turn begins', () => {
  it('records the fork, the answer, and that the fork is still open', () => {
    const b = stateAfterOneAnsweredRound();
    expect(b.questions.map((q) => [q.id, q.impact])).toEqual([
      ['q1-0', 'shaping'],
      ['q1-1', 'fork'],
    ]);
    expect(b.answers).toHaveLength(1);
    expect(unansweredForks(b).map((q) => q.text)).toEqual([AUDIENCE_FORK]);
  });
});

describe('a model that proposes past an unanswered fork is stopped', () => {
  it('blocks the proposal and returns no strategy or blueprint', async () => {
    script([jsonTurn(PROPOSAL)]);
    const res = await runTurn(stateAfterOneAnsweredRound());

    // The model asked for awaiting-confirmation. It does not get it.
    expect(res.phase).toBe('discovery');
    expect(res.strategy).toBeNull();
    expect(res.blueprint).toBeNull();
    expect(res.pendingBlueprint).toBeNull();
    expect(res.campaign).toBeNull();
    expect(res.designGenerated).toBe(false);
  });

  it('the APPLICATION caused it, not the model changing its mind', async () => {
    // The injected payload is action:"propose" with a complete blueprint. If
    // the user sees discovery instead, only the guard can have done that.
    script([jsonTurn(PROPOSAL)]);
    const res = await runTurn(stateAfterOneAnsweredRound());
    expect(JSON.parse(JSON.stringify(PROPOSAL)).action).toBe('propose');
    expect(res.phase).toBe('discovery');
  });

  it('puts the fork back to the user in their own words', async () => {
    script([jsonTurn(PROPOSAL)]);
    const res = await runTurn(stateAfterOneAnsweredRound());
    const reply = String(res.reply);
    expect(reply).toContain(AUDIENCE_FORK);
    expect(reply).toMatch(/changes which campaign this is rather than how it is built/);
    // Copy rewritten: it used to say "Your reply did not cover it, and I was
    // about to pick one for you." Measured live, that fired on a reply that
    // HAD answered — the model omitted the `answered` ids, and the
    // application told the manager their answer did not count. Never put a
    // bookkeeping failure on the user; just ask again.
    expect(reply).toMatch(/Before I design anything I need this one settled/);
    expect(reply).not.toMatch(/did not cover it/);
  });

  it('preserves the accumulated discovery state', async () => {
    script([jsonTurn(PROPOSAL)]);
    const res = await runTurn(stateAfterOneAnsweredRound());
    const brief = res.brief as WorkingBrief;
    // The answer already given survives, the fork stays open and keeps its id.
    expect(brief.answers).toHaveLength(1);
    const fork = brief.questions.find((q) => q.text === AUDIENCE_FORK)!;
    expect(fork.id).toBe('q1-1');
    expect(fork.impact).toBe('fork');
    expect(fork.addressedInRound).toBeUndefined();
    expect(unansweredForks(brief).map((q) => q.id)).toContain('q1-1');
    expect(res.session).toBeTruthy();
  });

  it('an unrelated assumption in the strategy does not discharge it', async () => {
    // The injected strategy carries assumptions, unknowns AND hypotheses —
    // every field that used to let a proposal through. None of them name the
    // fork, and none of them may retire it.
    expect(PROPOSAL.strategy.assumptions.length).toBeGreaterThan(0);
    expect(PROPOSAL.strategy.unknowns.length).toBeGreaterThan(0);
    expect(PROPOSAL.strategy.hypotheses.length).toBeGreaterThan(0);
    script([jsonTurn(PROPOSAL)]);
    const res = await runTurn(stateAfterOneAnsweredRound());
    expect(res.phase).toBe('discovery');
  });

  it('a resolution naming the fork does not discharge it either', async () => {
    script([jsonTurn({ ...PROPOSAL, questionResolutions: [{ questionId: 'q1-1', kind: 'carried', why: 'I will assume never-started and test it.' }] })]);
    const res = await runTurn(stateAfterOneAnsweredRound());
    expect(res.phase).toBe('discovery');
    expect(res.strategy).toBeNull();
  });
});

describe('the guard lets a resolved fork through', () => {
  it('an answered fork no longer blocks', async () => {
    // Same injected proposal, same everything — only the fork is answered.
    // Without this, "it blocks" could just mean "it always blocks".
    const b = recordAddressedQuestions(stateAfterOneAnsweredRound(), ['q1-1']);
    expect(unansweredForks(b)).toHaveLength(0);
    script([jsonTurn(PROPOSAL)]);
    const res = await runTurn(b);
    expect(res.phase).not.toBe('discovery');
    expect(res.strategy).not.toBeNull();
  });

  it('a model that answers the fork in its payload is let through', async () => {
    // The honest route out: claim the id in "answered". One turn away, always
    // available, which is what stops this being a loop.
    script([jsonTurn({ ...PROPOSAL, answered: ['q1-1'] })]);
    const res = await runTurn(stateAfterOneAnsweredRound());
    expect(res.phase).not.toBe('discovery');
    expect(res.strategy).not.toBeNull();
  });

  it('a non-fork question follows the ordinary carry/defer rules', async () => {
    // q1-0 is 'shaping' and already answered, so nothing is outstanding.
    const b = recordAddressedQuestions(stateAfterOneAnsweredRound(), ['q1-1']);
    script([jsonTurn({ ...PROPOSAL, questionResolutions: [{ questionId: 'q1-0', kind: 'deferred', why: 'Default applies.' }] })]);
    const res = await runTurn(b);
    expect(res.phase).not.toBe('discovery');
  });
});

describe('blocking does not become a trap', () => {
  it('a repeated refusal does not duplicate or degrade the question record', async () => {
    // A guard that corrupted state on each refusal would make the conversation
    // progressively harder to recover. Asserted on the QUESTION record: the
    // harness replays the same user message, so `answers` legitimately grows —
    // that is the test driver, not the guard.
    script([jsonTurn(PROPOSAL)]);
    const first = await runTurn(stateAfterOneAnsweredRound());
    vi.unstubAllGlobals();
    script([jsonTurn(PROPOSAL)]);
    const second = await runTurn(first.brief as WorkingBrief);

    const a = first.brief as WorkingBrief;
    const b = second.brief as WorkingBrief;
    // No new question invented, no id renumbered, impact intact.
    expect(b.questions.map((q) => [q.id, q.impact])).toEqual(a.questions.map((q) => [q.id, q.impact]));
    expect(second.phase).toBe('discovery');

    // DELIBERATE BEHAVIOUR CHANGE. A refusal is now counted, so the SAME fork
    // does not block forever. After one refusal it still blocks; after the
    // second it has reached MAX_FORK_REFUSALS and its stated fallback applies
    // instead. The question itself is untouched — it is still unanswered and
    // still on the record — which is the difference between falling back and
    // forgetting.
    //
    // Measured on a live run before this existed: the guard refused on turns 3
    // and 4 with word-for-word identical text and the conversation never
    // reached a proposal at all across five turns.
    expect(unansweredForks(a).map((q) => q.id)).toEqual(['q1-1']);
    expect(a.questions.find((q) => q.id === 'q1-1')!.blockedCount).toBe(1);
    expect(b.questions.find((q) => q.id === 'q1-1')!.blockedCount).toBe(2);
    expect(unansweredForks(b)).toEqual([]);
    expect(forksFallenBack(b).map((q) => q.id)).toEqual(['q1-1']);
    expect(forksFallenBack(b)[0].addressedInRound).toBeUndefined();
  });

  it('answering the fork clears it, and any later block names a different item', async () => {
    // OBSERVED, and worth recording rather than asserting away. The refusal
    // turn records the strategy's own `unknowns` as fresh questions — here
    // "Can you confirm whether the business meant the Pending cohort instead?"
    // — so the next turn is blocked again, by `questionDropped`, on THAT item.
    //
    // That is the rules working, not a trap: nothing the agent raised is
    // dropped silently, and both exits stay one turn away (answer it, or
    // record a questionResolution naming it). What matters for loop-safety is
    // that the FORK is gone and the reason has changed.
    script([jsonTurn(PROPOSAL)]);
    const blocked = await runTurn(stateAfterOneAnsweredRound());
    expect(blocked.phase).toBe('discovery');
    expect(String(blocked.reply)).toContain(AUDIENCE_FORK);

    vi.unstubAllGlobals();
    script([jsonTurn({ ...PROPOSAL, answered: ['q1-1'] })]);
    const out = await runTurn(blocked.brief as WorkingBrief, 'The never-started cohort.');

    // The fork is resolved and never blocks again.
    expect(unansweredForks(out.brief as WorkingBrief)).toHaveLength(0);
    expect(String(out.reply)).not.toContain(AUDIENCE_FORK);
    expect(String(out.reply)).not.toMatch(/changes which campaign this is/);
  });
});
