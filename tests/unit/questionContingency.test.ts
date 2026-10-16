// A question's claim to change the campaign, made checkable.
//
// The test that matters most here is the asymmetry: a fork with NO contingency
// must still block. The first implementation required a valid contingency
// before a fork would be honoured, which meant a model that omitted the field
// got the fork guard switched off — the laziest response buying the most
// freedom. The existing fork-guard suite caught it. These tests pin the
// corrected rule so it cannot drift back.
import { describe, it, expect } from 'vitest';
import {
  newBrief,
  recordQuestions,
  recordAnswer,
  unansweredForks,
  rejectedForks,
  checkContingency,
  asContingency,
  briefForPrompt,
  type OpenQuestion,
  type QuestionContingency,
} from '../../server/discovery';

const OBJ = 'I want to increase OS-to-EMI conversions. Design a drip campaign for this.';

const good: QuestionContingency = {
  ifA: 'They have never started a request',
  thenA: 'Enter on Account audience and drive initiation',
  ifB: 'They started one and stalled',
  thenB: 'Enter on the EMI Request event and recover the open request',
  ifUnknown: 'Default to never-started, the larger population, and say so',
};

const q = (over: Partial<OpenQuestion> = {}): OpenQuestion => ({
  id: 'q1-0', text: 'Never started, or started and stalled?', askedInRound: 1, impact: 'fork', ...over,
});

describe('a contingency is only accepted whole', () => {
  it('rejects a partial shape rather than patching it', () => {
    expect(asContingency({ ifA: 'a', thenA: 'b' })).toBeUndefined();
    expect(asContingency({ ...good, ifUnknown: '   ' })).toBeUndefined();
    expect(asContingency(null)).toBeUndefined();
    expect(asContingency('fork')).toBeUndefined();
  });

  it('accepts and trims a complete one', () => {
    const c = asContingency({ ...good, ifA: '  padded  ' })!;
    expect(c.ifA).toBe('padded');
    expect(c.thenB).toBe(good.thenB);
  });
});

describe('what the application will and will not call a fork', () => {
  it('still honours a fork that declared no contingency', () => {
    // THE ASYMMETRY. Silence must never buy permission to proceed.
    expect(checkContingency(q()).verdict).toBe('missing');
    let b = recordQuestions(newBrief(OBJ), [{ text: q().text, impact: 'fork' }]);
    b = recordAnswer(b, 'Something unrelated about targets.');
    expect(unansweredForks(b)).toHaveLength(1);
  });

  it('declines a fork whose two answers lead to the same decision', () => {
    const idle = q({ contingency: { ...good, thenB: 'Enter on account audience and drive initiation!' } });
    expect(checkContingency(idle).verdict).toBe('idle');
    let b = recordQuestions(newBrief(OBJ), [
      { text: idle.text, impact: 'fork', contingency: idle.contingency },
    ]);
    b = recordAnswer(b, 'Something unrelated.');
    expect(unansweredForks(b)).toHaveLength(0);
  });

  it('honours a fork with two answers and two different decisions', () => {
    expect(checkContingency(q({ contingency: good })).verdict).toBe('ok');
    let b = recordQuestions(newBrief(OBJ), [{ text: q().text, impact: 'fork', contingency: good }]);
    b = recordAnswer(b, 'Something unrelated.');
    expect(unansweredForks(b)).toHaveLength(1);
  });

  it('does not require a contingency of a non-fork', () => {
    expect(checkContingency(q({ impact: 'detail', contingency: undefined }).valueOf() as OpenQuestion).verdict).toBe('ok');
    expect(checkContingency(q({ impact: 'shaping' })).verdict).toBe('ok');
  });

  it('reports an incomplete contingency as incomplete, not idle', () => {
    // Reaching past asContingency, as a brief restored from older stored state
    // could. A half-filled shape must never read as satisfied.
    const half = q({ contingency: { ifA: 'a', thenA: 'x', ifB: 'b', thenB: 'y', ifUnknown: '' } as QuestionContingency });
    expect(checkContingency(half).verdict).toBe('incomplete');
    expect(checkContingency(half).why).toContain('ifUnknown');
  });
});

describe('the model is told which fork claims were declined', () => {
  it('lists each declined claim with its reason', () => {
    let b = recordQuestions(newBrief(OBJ), [
      { text: 'No contingency at all', impact: 'fork' },
      { text: 'Idle one', impact: 'fork', contingency: { ...good, thenB: good.thenA } },
      { text: 'A real one', impact: 'fork', contingency: good },
    ]);
    b = recordAnswer(b, 'Unrelated reply.');
    const rejected = rejectedForks(b);
    expect(rejected.map((r) => r.verdict).sort()).toEqual(['idle', 'missing']);

    const out = briefForPrompt(b);
    expect(out).toContain('but I am not treating');
    expect(out).toMatch(/never said what the answer would change/);
    expect(out).toMatch(/Both answers lead to the same decision/);
  });

  it('tells the agent to apply the stated fallback instead of re-asking', () => {
    let b = recordQuestions(newBrief(OBJ), [{ text: q().text, impact: 'fork', contingency: good }]);
    b = recordAnswer(b, 'Unrelated reply.');
    expect(briefForPrompt(b)).toMatch(/Repeating the question is not a fallback/);
  });

  it('says nothing about declined forks when there are none', () => {
    let b = recordQuestions(newBrief(OBJ), [{ text: q().text, impact: 'fork', contingency: good }]);
    b = recordAnswer(b, 'Unrelated reply.');
    expect(briefForPrompt(b)).not.toContain('but I am not treating');
  });
});

describe('the contingency survives being recorded', () => {
  // THE PLUMBING TEST. `impact` was parsed from the model and then dropped
  // before it reached the brief, on all three call sites, and the symptom was
  // a guard that never fired. Nothing asserted it was stored. This does.
  it('stores the contingency against the question, not just the impact', () => {
    const b = recordQuestions(newBrief(OBJ), [{ text: q().text, impact: 'fork', contingency: good }]);
    expect(b.questions[0].impact).toBe('fork');
    expect(b.questions[0].contingency).toEqual(good);
  });

  it('keeps stable ids and drops an unusable contingency silently', () => {
    const b = recordQuestions(newBrief(OBJ), [
      { text: 'one', impact: 'fork', contingency: { ifA: 'only this' } },
      { text: 'two', impact: 'detail' },
    ]);
    expect(b.questions.map((x) => x.id)).toEqual(['q1-0', 'q1-1']);
    expect(b.questions[0].contingency).toBeUndefined();
    expect(checkContingency(b.questions[0]).verdict).toBe('missing');
  });

  it('accepts a plain string question, as before', () => {
    const b = recordQuestions(newBrief(OBJ), ['just text']);
    expect(b.questions[0].text).toBe('just text');
    expect(b.questions[0].contingency).toBeUndefined();
  });
});
