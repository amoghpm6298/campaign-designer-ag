// The contract between what the model declares and what the application
// enforces.
//
// ROOT CAUSE, found by live verification rather than by reading the prompt.
// The output schema DID ask for {"text":...,"impact":...} next to the
// questions field. The model was not the problem. Every one of the three
// `recordQuestions` call sites passed `gate.questions` — plain strings, built
// by `asQuestion()`, because `GateInput.modelQuestions` is typed `string[]`.
//
// So `impact` was parsed, handed to the gate, and dropped before it reached
// the brief. `unansweredForks` returned [] on every turn of every run and the
// fork guard could never fire. The live run that appeared to show "the model
// emitted plain strings" was showing the application discarding the field.
//
// Two resolutions in the same run arrived with no `kind` and were accepted,
// because `kind` was never validated.
//
// WHAT THIS DOES NOT PROVE: that an impact the model declares is CORRECT. The
// application can check that a value is one of three allowed strings and that
// it survives to the brief. Whether a question really is a fork is the model's
// judgement, and it can be wrong.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  newBrief,
  recordQuestions,
  recordAnswer,
  recordAddressedQuestions,
  recordQuestionResolutions,
  unansweredForks,
  unresolvedQuestions,
  briefForPrompt,
  asImpact,
  QUESTION_IMPACTS,
  type WorkingBrief,
} from '../../server/discovery';

const unanswered = (b: WorkingBrief) => recordAnswer(b, 'A reply that addresses nothing in particular.');

describe('impact survives from the model payload to the brief', () => {
  it('the orchestrator re-attaches impact instead of passing bare strings', () => {
    // The actual fix. Without it every assertion below still passes in
    // isolation while the real pipeline stays broken, which is exactly what
    // happened: the unit tests were green through the whole defect.
    const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/const impactByText = new Map<string, ReturnType<typeof asImpact>>\(\)/);
    expect(src).toMatch(/const withImpact = \(questions: string\[\]\)/);
    // ...and the map is actually filled from the model's own payload. Without
    // this the map exists, stays empty, and every question reads unclassified
    // — which looks exactly like the defect it replaced.
    expect(src).toMatch(/impactByText\.set\(q\.text, asImpact\(q\.impact\)\)/);
    expect(src).not.toMatch(/recordQuestions\(brief, gate\.questions\)/);
    expect([...src.matchAll(/recordQuestions\(brief, withImpact\(gate\.questions\)\)/g)]).toHaveLength(3);
  });

  it('keeps a declared impact on the recorded question', () => {
    const b = recordQuestions(newBrief('o'), [
      { text: 'Never started, or already Pending?', impact: 'fork' },
      { text: 'Which channel first?', impact: 'detail' },
    ]);
    expect(b.questions.map((q) => q.impact)).toEqual(['fork', 'detail']);
  });

  it('keeps ids stable across turns so impact and answers stay attached', () => {
    let b = recordQuestions(newBrief('o'), [{ text: 'The fork', impact: 'fork' }]);
    b = recordQuestions(unanswered(b), [{ text: 'A later one', impact: 'shaping' }]);
    expect(b.questions.map((q) => [q.id, q.impact])).toEqual([
      ['q1-0', 'fork'],
      ['q2-0', 'shaping'],
    ]);
  });
});

describe('an unrecognised impact is not quietly downgraded', () => {
  it('accepts exactly the three allowed values', () => {
    expect(QUESTION_IMPACTS).toEqual(['fork', 'shaping', 'detail']);
    for (const v of QUESTION_IMPACTS) expect(asImpact(v)).toBe(v);
    expect(asImpact(' fork ')).toBe('fork');
  });

  it('rejects anything else rather than guessing', () => {
    for (const bad of ['FORK', 'critical', '', ' ', null, undefined, 7, {}, ['fork']]) {
      expect(asImpact(bad)).toBeUndefined();
    }
  });

  it('never defaults a missing impact to "detail"', () => {
    // The whole point. A material question nobody classified must not be
    // recorded as the least important kind there is.
    const b = recordQuestions(newBrief('o'), [{ text: 'Unlabelled' }, { text: 'Bogus', impact: 'urgent' as never }]);
    expect(b.questions.map((q) => q.impact)).toEqual([undefined, undefined]);
    expect(b.questions.some((q) => q.impact === 'detail')).toBe(false);
  });

  it('cannot be dropped while it is unclassified', () => {
    // Not a fork, so it does not hard-block; but it still needs an explicit
    // decision, so silence cannot bury it.
    const b = unanswered(recordQuestions(newBrief('o'), [{ text: 'Unlabelled' }]));
    expect(unansweredForks(b)).toHaveLength(0);
    expect(unresolvedQuestions(b).map((q) => q.id)).toEqual(['q1-0']);
  });

  it('asks the model to classify what it left unclassified', () => {
    const b = unanswered(recordQuestions(newBrief('o'), [{ text: 'Unlabelled' }]));
    const out = briefForPrompt(b);
    expect(out).toMatch(/carries\s+no "impact" — I do not know what rides on it/);
    expect(out).toMatch(/treated as unclassified and cannot be dropped/);
  });

  it('still accepts the plain-string form without inventing an impact', () => {
    const b = recordQuestions(newBrief('o'), ['A legacy question']);
    expect(b.questions[0].impact).toBeUndefined();
    expect(unansweredForks(unanswered(b))).toHaveLength(0);
  });
});

describe('the fork guard runs on validated state', () => {
  const withFork = () =>
    unanswered(
      recordQuestions(newBrief('o'), [
        { text: 'Never started, or already Pending?', impact: 'fork' },
        { text: 'Which channel first?', impact: 'detail' },
      ]),
    );

  it('a valid unresolved fork blocks', () => {
    expect(unansweredForks(withFork()).map((q) => q.id)).toEqual(['q1-0']);
  });

  it('a shaping or detail question does not block every proposal', () => {
    // Guards that this mechanism cannot become "nothing ever proceeds".
    let b = unanswered(
      recordQuestions(newBrief('o'), [
        { text: 'Which channel first?', impact: 'detail' },
        { text: 'How long a window?', impact: 'shaping' },
      ]),
    );
    expect(unansweredForks(b)).toHaveLength(0);
    b = recordQuestionResolutions(b, [
      { questionId: 'q1-0', kind: 'deferred', why: 'EMAIL first, the cheapest channel.' },
      { questionId: 'q1-1', kind: 'carried', why: 'Sized to the 7-day expiry; revisit with data.' },
    ]);
    expect(unresolvedQuestions(b)).toHaveLength(0);
  });

  it('an invalid impact cannot be used to slip a fork past the guard', () => {
    // The bypass this exists to close: label the fork with something the
    // application does not recognise and it stops being a fork.
    const b = unanswered(recordQuestions(newBrief('o'), [{ text: 'The real fork', impact: 'Fork' as never }]));
    expect(unansweredForks(b)).toHaveLength(0);
    // ...but it does not become droppable either.
    expect(unresolvedQuestions(b).map((q) => q.id)).toEqual(['q1-0']);
  });

  it('no resolution of any kind discharges a fork', () => {
    for (const kind of ['carried', 'deferred'] as const) {
      const b = recordQuestionResolutions(withFork(), [
        { questionId: 'q1-0', kind, why: 'I will assume one and test it.' },
      ]);
      expect(unansweredForks(b), kind).toHaveLength(1);
    }
  });

  it('only a real answer clears it', () => {
    expect(unansweredForks(recordAddressedQuestions(withFork(), ['q1-0']))).toHaveLength(0);
  });
});

describe('a resolution must be a complete decision', () => {
  const asked = () =>
    unanswered(recordQuestions(newBrief('o'), [{ text: 'Which channel first?', impact: 'detail' }]));

  it('requires a valid kind', () => {
    // Measured: two resolutions in the live run had no `kind` at all and were
    // accepted, because nothing checked it.
    for (const bad of [undefined, '', 'skipped', 'DEFERRED', 'ignored']) {
      const b = recordQuestionResolutions(asked(), [
        { questionId: 'q1-0', kind: bad as never, why: 'A reason.' },
      ]);
      expect(b.questionResolutions ?? [], String(bad)).toHaveLength(0);
      expect(unresolvedQuestions(b)).toHaveLength(1);
    }
  });

  it('accepts both real kinds', () => {
    for (const kind of ['carried', 'deferred'] as const) {
      const b = recordQuestionResolutions(asked(), [{ questionId: 'q1-0', kind, why: 'A reason.' }]);
      expect(b.questionResolutions, kind).toHaveLength(1);
      expect(unresolvedQuestions(b)).toHaveLength(0);
    }
  });

  it('rejects an unknown question id', () => {
    const b = recordQuestionResolutions(asked(), [{ questionId: 'q9-9', kind: 'deferred', why: 'x' }]);
    expect(b.questionResolutions ?? []).toHaveLength(0);
  });

  it('rejects an empty reason', () => {
    const b = recordQuestionResolutions(asked(), [{ questionId: 'q1-0', kind: 'deferred', why: '   ' }]);
    expect(b.questionResolutions ?? []).toHaveLength(0);
    expect(unresolvedQuestions(b)).toHaveLength(1);
  });

  it('keeps first-resolution-wins', () => {
    let b = recordQuestionResolutions(asked(), [{ questionId: 'q1-0', kind: 'deferred', why: 'first' }]);
    b = recordQuestionResolutions(b, [{ questionId: 'q1-0', kind: 'carried', why: 'second' }]);
    expect(b.questionResolutions).toHaveLength(1);
    expect(b.questionResolutions![0]).toMatchObject({ kind: 'deferred', why: 'first' });
  });

  it('does not disturb question history', () => {
    const before = asked();
    const after = recordQuestionResolutions(before, [{ questionId: 'q1-0', kind: 'deferred', why: 'r' }]);
    expect(after.questions).toEqual(before.questions);
    expect(after.answers).toEqual(before.answers);
  });
});

describe('the earlier protections are untouched', () => {
  it('attribution, counts, belief basis and no-proxy rules all still hold', () => {
    let b = recordQuestions(newBrief('o'), [
      { text: 'Fork?', impact: 'fork' },
      { text: 'Detail?', impact: 'detail' },
    ]);
    b = recordAddressedQuestions(recordAnswer(b, 'answering the detail'), ['q1-1']);
    expect(briefForPrompt(b)).toContain(
      '2 question(s) asked across 1 round(s), 1 answered, 1 asked but not answered, 0 awaiting any reply',
    );
    const disc = readFileSync(new URL('../../server/discovery.ts', import.meta.url), 'utf8');
    // The four customer-facing bases now live in server/findings.ts and
    // DimensionBasis derives from them, so both halves are pinned. Same
    // intent as before: the vocabulary must not shrink unnoticed.
    expect(disc).toMatch(/export type DimensionBasis = FindingBasis \| 'tool';/);
    expect(readFileSync(new URL('../../server/findings.ts', import.meta.url), 'utf8')).toMatch(
      /export type FindingBasis = 'user' \| 'user-belief' \| 'assumption' \| 'none';/,
    );
    const SYSTEM = /const SYSTEM = `([\s\S]*?)`;\n/.exec(
      readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8'),
    )![1];
    expect(SYSTEM).toMatch(/DO NOT CLOSE THAT GAP WITH A NEAR-ENOUGH ATTRIBUTE/);
    expect(SYSTEM).toMatch(/a single event's value is not a running total/);
  });
});
