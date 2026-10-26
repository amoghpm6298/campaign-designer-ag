// Discovery is a conversation, not a questionnaire.
//
// The defect this locks down, measured across every OS-to-EMI run to date: the
// agent asked three good opening questions, received the answers, closed every
// dimension on that same turn, and proposed. It never tested whether an answer
// had NARROWED a question rather than settled it.
//
// `aud4` is the clearest case. The user said the blocker is "interest-cost
// hesitation, not awareness". That is a family of explanations, not one — the
// interest rate, the total amount payable, the tenure, the effect on available
// limit — and they lead to different opening messages. The agent recorded it as
// a closed dimension, basis "user", and wrote a campaign around "interest-cost
// transparency" without ever asking which part of the cost was the worry.
//
// The stopping rule is deliberately NOT a question count in either direction:
// a fixed number would be as wrong as stopping at the first answer.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const SYSTEM = (() => {
  const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
  return /const SYSTEM = `([\s\S]*?)`;\n/.exec(src)![1];
})();
const method = SYSTEM.slice(SYSTEM.indexOf('HOW TO DESIGN A CAMPAIGN'), SYSTEM.indexOf('QUESTIONS AND OPEN ITEMS'));

describe('an answer is read, not just recorded', () => {
  it('treats the opening questions as a first pass, not a questionnaire', () => {
    expect(method).toMatch(/AN ANSWER IS NOT AUTOMATICALLY A CLOSED DIMENSION/);
    expect(method).toMatch(/Your first questions are the opening pass, not a questionnaire to get through/);
  });

  it('names all four things an answer can do', () => {
    // Only the first was ever acted on. The other three are where follow-ups
    // come from, and each needs a different response.
    expect(method).toMatch(/It ANSWERED the question/);
    expect(method).toMatch(/It NARROWED the question/);
    expect(method).toMatch(/It RAISED something new/);
    expect(method).toMatch(/It made another dimension IRRELEVANT/);
  });

  it('forbids accepting a stated cause as a finding', () => {
    // The decisive rule, added after two live runs showed the four-way read
    // alone was not enough: the dormant-card run took "they've just forgotten"
    // as settled and built one uniform track, never asking which kind of
    // forgetting nor testing it. Two exits, never a third.
    expect(method).toMatch(/A BROAD CAUSE IS NEVER SETTLED BY BEING STATED/);
    expect(method).toMatch(/you have their belief, not a finding/);
    // The rule now also says where it goes in the record, so the belief is
    // visible to the application and not only to the model's own reasoning.
    expect(method).toMatch(/Record it as "user-belief" and close it exactly two ways: ASK which one it is, or TEST them against each other/);
    expect(method).toMatch(/Accepting it as given and designing for one reading is the third way, and it is wrong/);
    // And which exit to take is itself a stated decision, not a coin toss.
    expect(method).toMatch(/choose testing when they genuinely cannot know, and say which you did and why/);
  });

  it('uses the real cost-hesitation case to show what narrowing looks like', () => {
    // A worked example, because the abstract instruction alone did not change
    // behaviour: "cost hesitation" was accepted as an answer four runs running.
    expect(method).toMatch(/Broad causes hide competing explanations underneath them/);
    expect(method).toMatch(/the interest rate, the total payable, the tenure, or the effect on available limit/);
    expect(method).toMatch(/those lead to different messages/);
    expect(method).toMatch(/you now have a sharper question, not an answer/);
  });
});

describe('the stopping rule is value, not count', () => {
  it('ties a follow-up to what it would change', () => {
    expect(method).toMatch(/ONLY when the answer would change the audience, the intervention, the timing, the experiment or the measure/);
  });

  it('forbids asking a question whose answers all lead to the same campaign', () => {
    // The other failure mode: endless clarification that never alters the
    // design. Guarded explicitly so this change cannot be read as "ask more".
    expect(method).toMatch(/A question whose every possible answer leads to the same campaign is not worth a turn of the user's time/);
  });

  it('makes stopping an explicit decision rather than a limit being hit', () => {
    expect(method).toMatch(/Stopping is a decision you must make deliberately and state, not a budget you pad to/);
    expect(method).toMatch(/This round still has at most three questions/);
    expect(method).toMatch(/"nothing further would change this" is itself a finding/);
    // Per-round cap is not a quota to fill, and the method must not ask for a
    // fixed number of rounds.
    expect(method).not.toMatch(/ask (at least|exactly|no more than) (two|three|four|\d+) (rounds|questions)/i);
  });

  it('does not make a second answered round a universal rule', () => {
    // An explicit product decision: some objectives are settled in one
    // exchange, and a hard two-round gate would waste the user's time on
    // those. The gate stays value-based, enforced by the dimension record.
    const src = readFileSync(new URL('../../server/discovery.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/answers\.length >= 2/);
    expect(src).toMatch(/userHasRespondedOnce/);
  });
});

describe('uncertainty survives rather than being resolved by the agent', () => {
  it('treats "I do not know" as an answer to carry, not a gap to fill', () => {
    expect(method).toMatch(/If they cannot answer, that is an answer too\. Do not resolve it for them/);
    expect(method).toMatch(/carry it into the strategy as an unknown with its consequence/);
  });

  it('routes an unresolved question towards an experiment', () => {
    // The link the requirement asks for: experimentation as a CONSEQUENCE of
    // discovery, not an item on a checklist.
    expect(method).toMatch(/consider whether an experiment could settle what the conversation could not/);
  });

  it('keeps follow-ups updating the same dimension, not spawning duplicates', () => {
    expect(method).toMatch(/Update the dimension you already have, reusing its name EXACTLY/);
    expect(method).toMatch(/A rephrased near-duplicate loses the history of what was asked and what came back/);
    // The merge itself is by exact name — the prompt rule and the code rule
    // have to agree or the record silently forks.
    const src = readFileSync(new URL('../../server/discovery.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/recordDimensions/);
  });
});

describe('the strategy traces back to what was said', () => {
  it('requires every approach entry to name what it rests on', () => {
    expect(method).toMatch(/SHOW WHERE EACH DECISION CAME FROM/);
    expect(method).toMatch(/what the user told you, what a tool reported, or that it is your own judgement/);
  });

  it('separates the user\'s requirements from the agent\'s recommendations', () => {
    expect(method).toMatch(/tell THEIR requirements from YOUR recommendations without asking/);
    expect(method).toMatch(/a decision that traces to nothing is an assumption/);
  });

  it('requires the strategy to change when a later answer undercuts it', () => {
    // Coherence across turns: the failure mode is a strategy written from the
    // first answer and never revisited as more arrived.
    expect(method).toMatch(/If a later answer undercuts an approach you were heading towards, change it and say what changed it/);
    expect(method).toMatch(/never present a strategy that the accumulated answers no longer support/);
  });
});
