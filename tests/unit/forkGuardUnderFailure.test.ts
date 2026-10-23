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
  unansweredForks,
  type WorkingBrief,
} from '../../server/discovery';
import { REOPEN_LIMIT, reopen, recordReply, outstanding, exhausted } from '../../server/record';

const sse = (events: Record<string, unknown>[]) =>
  events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

const jsonTurn = (payload: unknown) =>
  sse([
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: JSON.stringify(payload) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 400 } },
  ]);

const AUDIENCE_FORK = 'Should this reach customers who never started an OS-to-EMI request, or ones already Pending?';

/**
 * A complete, well-formed proposal. Nothing about it is malformed.
 *
 * `notCovered` NAMES THE FORK, and that is the whole premise of this file as
 * of 2026-10-21. Until then it was enough to send `answered: []`, because a
 * fork stayed open unless positively claimed. That exception is gone: a reply
 * now closes a fork like anything else, and `notCovered` is the one thing
 * that keeps one open.
 *
 * So the misbehaviour under test is sharper than it was, not weaker. The model
 * is no longer merely forgetting its bookkeeping — it is stating that the
 * manager's reply did not touch the fork, and proposing a full campaign
 * against one of the two cohorts anyway. If the application lets that through,
 * it builds a campaign aimed at a cohort nobody chose while holding the
 * model's own admission that nobody chose it.
 */
const PROPOSAL = {
  action: 'propose',
  answered: [],
  notCovered: ['q1-1'],
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
    // AND A SECOND AXIS THEY WERE ASKED ABOUT, since 2026-10-23. One pattern
    // the manager has seen now holds the proposal until someone has asked
    // whether there is another — so without this the fork would be the SECOND
    // reason this payload is held and the test would prove nothing about
    // forks. `unavailable` with their own note is the "we do not track that"
    // answer, which is a complete one.
    { name: 'Prior product holding', rationale: 'Might change who responds.', status: 'unavailable', basis: 'user', note: 'They said they do not track it.' },
    { name: 'Statement timing', rationale: 'When the message lands.', status: 'deferred', basis: 'assumption', note: 'Ruled out: no statement-date attribute exists.' },
    { name: 'Channel preference', rationale: 'Where to reach them.', status: 'unavailable', basis: 'none', note: 'Ruled out: no per-customer channel history.' },
  ],
  strategy: {
    // NAMED SENDS, since 2026-10-22. A plan has to list its cadence — a
    // proposal that only describes one in prose is refused by
    // `cadenceBlocks`, which would make the fork the SECOND reason this
    // payload is held and the test would stop proving anything about forks.
    // Everything else about the proposal stays deliberately well-formed so
    // the fork remains the only variable.
    // AND A DECLARED TEST, since 2026-10-23, for exactly the same reason the
    // sends were named above. `trendBlocks` refuses a plan that compares
    // nothing when the manager has stated no trend, so without this the
    // payload would be held for a second reason and the test would stop
    // proving anything about forks.
    strategyOptions: [
      { option: 'Experimentation', verdict: 'used', why: 'Two openings, randomly assigned, read on conversion.' },
    ],
    // AND A WINNER THAT REACTS, since 2026-10-23, for the third time and the
    // same reason as the two notes above. `reactionBlocks` refuses a plan
    // whose chosen architecture is a clock, so without this the fork is again
    // the second reason the payload is held. The rival here IS the clock,
    // which is a legitimate alternative to weigh and reject.
    architectures: [
      {
        name: 'Catch the authorisation', barrier: 'cost-perception', audience: 'Every account carrying an eligible balance',
        timing: 'Within the hour', lever: 'message', journey: 'branch-on-response',
        mechanism: 'Explain the cost while the balance is in view.', tradeOff: 'Needs the event quickly.', chosen: true,
      },
      {
        name: 'Work the statement date', barrier: 'cost-perception', audience: 'The same accounts, on the statement run',
        timing: 'Two days before the statement', lever: 'timing', journey: 'linear',
        mechanism: 'Pitch it when the bill is in view.', tradeOff: 'Later, and some have already paid.',
      },
    ],
    touches: [
      { day: 0, channel: 'WhatsApp', path: 'all', purpose: 'Explain that the balance can be converted.', ifStillUnconverted: 'Try SMS if WhatsApp does not deliver.' },
      { day: 3, channel: 'SMS', path: 'all', purpose: 'Remind them before the statement date.', ifStillUnconverted: 'If it was read and nothing happened, one last message on day 6, then stop.' },
    ],
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
  return out.value as unknown as Record<string, unknown>;
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
    expect(reply).toMatch(/I am still waiting on this/);
    // Copy rewritten: it used to say "Your reply did not cover it, and I was
    // about to pick one for you." Measured live, that fired on a reply that
    // HAD answered — the model omitted the `answered` ids, and the
    // application told the manager their answer did not count. Never put a
    // bookkeeping failure on the user; just ask again.
    // The two-tier fork copy ("Before I design anything I need this one
    // settled" / "One more on this, then I will decide") is gone with the
    // escalation ladder it belonged to. One statement of what is outstanding,
    // and a single bounded re-ask, replace it.
    expect(reply).toContain(AUDIENCE_FORK);
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
    script([jsonTurn({ ...PROPOSAL, answered: ['q1-1'], notCovered: [] })]);
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
    // THE LADDER IS GONE, and this is the honest replacement. There is no
    // refusal counter, no escalation and no `forksFallenBack` tier, because
    // all three counted how often the APPLICATION had given up. The bound
    // that matters is how often the USER is asked the same thing, and it is
    // exactly one: `reopen` puts a question back once and then refuses to.
    const once = reopen(a, ['q1-1']);
    // Contains, not equals: the refusal also recorded its own fallback
    // question, which is correct — a refusal must never leave the user with
    // nothing to answer.
    expect(outstanding(once).map((q) => q.id)).toContain('q1-1');
    const answeredAgain = recordReply(once, 'the never-started cohort');
    expect(outstanding(reopen(answeredAgain, ['q1-1'])).map((q) => q.id)).not.toContain('q1-1');
    expect(exhausted(answeredAgain).map((q) => q.id)).toContain('q1-1');
    expect(REOPEN_LIMIT).toBe(1);
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
    script([jsonTurn({ ...PROPOSAL, answered: ['q1-1'], notCovered: [] })]);
    const out = await runTurn(blocked.brief as WorkingBrief, 'The never-started cohort.');

    // The fork is resolved and never blocks again.
    expect(unansweredForks(out.brief as WorkingBrief)).toHaveLength(0);
    expect(String(out.reply)).not.toContain(AUDIENCE_FORK);
    expect(String(out.reply)).not.toMatch(/changes which campaign this is/);
  });
});
