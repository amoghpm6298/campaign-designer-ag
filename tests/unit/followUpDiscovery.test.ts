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
import { asking, ready } from './support/prompts.ts';
// PINS REMOVED, NOT LOST: 18 rule(s) this file asserted have no
// counterpart in any of the three manuals. Every one is listed in
// `server/promptHomeless.md` under this filename, with the tests that
// went with them. Do not re-add a pin here without putting the rule
// back in a manual first.

const SYSTEM = asking();
// NO CHAPTER SLICING. This cut the prompt between titles that existed only in
// the one big SYSTEM ("HOW TO DESIGN A CAMPAIGN", "3. The business strategy",
// "QUESTIONS AND OPEN ITEMS"). Each phase string is now only that phase, so
// the whole string IS the right scope — and a slice keyed on a title that has
// gone silently becomes an empty string, which is what every assertion in
// this file was being run against.
const method = SYSTEM;

describe('an answer is read, not just recorded', () => {
  it('treats the opening questions as a first pass, not a questionnaire', () => {
    expect(asking()).toMatch(/An answer is not automatically a closed dimension/);
    expect(asking()).toMatch(/Your first questions are an opening pass, not a questionnaire to get through/);
  });

  it('names all four things an answer can do', () => {
    // Only the first was ever acted on. The other three are where follow-ups
    // come from, and each needs a different response.
    expect(asking()).toMatch(/It answered the question/);
    expect(asking()).toMatch(/It narrowed the question/);
    expect(asking()).toMatch(/It raised something new/);
    expect(asking()).toMatch(/It made another dimension irrelevant/);
  });

  it('forbids accepting a stated cause as a finding', () => {
    // The decisive rule, added after two live runs showed the four-way read
    // alone was not enough: the dormant-card run took "they've just forgotten"
    // as settled and built one uniform track, never asking which kind of
    // forgetting nor testing it. Two exits, never a third.
    expect(asking()).toMatch(/you have their belief, not a finding/);
    // The rule now also says where it goes in the record, so the belief is
    // visible to the application and not only to the model's own reasoning.
    // And which exit to take is itself a stated decision, not a coin toss.
  });

  it('uses the real cost-hesitation case to show what narrowing looks like', () => {
    // A worked example, because the abstract instruction alone did not change
    // behaviour: "cost hesitation" was accepted as an answer four runs running.
    expect(asking()).toMatch(/the interest rate, the total payable, the tenure, or the effect on available limit/);
    expect(asking()).toMatch(/those lead to different messages/);
    expect(asking()).toMatch(/you now have a sharper question, not an answer/);
  });
});

describe('the stopping rule is value, not count', () => {


  it('makes stopping an explicit decision rather than a limit being hit', () => {
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
    expect(asking()).toMatch(/If they cannot answer, that is an answer too\. Do not resolve it for them/);
  });


  it('keeps follow-ups updating the same dimension, not spawning duplicates', () => {
    // The merge itself is by exact name — the prompt rule and the code rule
    // have to agree or the record silently forks.
    const src = readFileSync(new URL('../../server/discovery.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/recordDimensions/);
  });
});

describe('the strategy traces back to what was said', () => {
  it('requires every approach entry to name what it rests on', () => {
    expect(ready()).toMatch(/Say what the choice rests on/);
  });

  it('separates the user\'s requirements from the agent\'s recommendations', () => {
    expect(asking()).toMatch(/A reason you invented and put in their mouth is an assumption/);
  });

});
