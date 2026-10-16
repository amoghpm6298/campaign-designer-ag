// A user's explanation of customer behaviour is not a finding.
//
// ROOT CAUSE this locks down, found by reading the record rather than the
// prompt: `DimensionBasis` was `tool | user | assumption | none`. "Dormant
// means no transaction in 6 months" — a definition the business owns and is
// the authority on — and "we think they've just forgotten about the card" — a
// conjecture about causation they cannot actually know — both recorded as
// basis 'user' and were indistinguishable from each other afterwards.
//
// Nothing downstream could act on the difference, so a stated belief became
// the established cause an entire campaign was designed around, with no part
// of the record saying it had never been tested. That is a representational
// gap, not a prompting one: no wording could fix a record with nowhere to put
// the distinction.
import { describe, it, expect } from 'vitest';
import { alternativesRuledOut } from './support/findings';
import { readFileSync } from 'node:fs';
import {
  newBrief,
  recordDimensions,
  briefDimensions,
  briefForPrompt,
  discoveryIsComplete,
  outstandingDimensions,
  type WorkingBrief,
} from '../../server/discovery';

const BELIEF = /carried as a hypothesis/;

const withBelief = (): WorkingBrief =>
  recordDimensions(newBrief('Reactivate dormant cards'), [
    {
      name: 'Believed cause of stoppage',
      rationale: 'Changes what the message leads with.',
      status: 'retained',
      basis: 'user-belief',
      note: 'User thinks they simply forgot about the card.',
    },
  ]);

describe('the record can tell a belief from a fact', () => {
  it('declares the five bases, so the vocabulary cannot shrink unnoticed', () => {
    // Pinned against the source. Dropping 'user-belief' from the union is a
    // type error only where the tests themselves are typechecked, and the
    // server config does not cover them — so without this the whole
    // distinction could be deleted with the suite still green.
    //
    // The five are now split across two files: the four that describe what a
    // finding about CUSTOMERS rests on live in findings.ts, and
    // DimensionBasis adds 'tool' because a dimension can rest on something a
    // tool reported while a reason customers behave as they do cannot. Both
    // halves are pinned, so the union still cannot shrink in either place.
    const src = readFileSync(new URL('../../server/discovery.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/export type DimensionBasis = FindingBasis \| 'tool';/);
    const findings = readFileSync(new URL('../../server/findings.ts', import.meta.url), 'utf8');
    expect(findings).toMatch(/export type FindingBasis = 'user' \| 'user-belief' \| 'assumption' \| 'none';/);
  });

  it('keeps a stated fact and a stated belief apart', () => {
    const b = recordDimensions(newBrief('Reactivate dormant cards'), [
      { name: 'Dormancy definition', status: 'retained', basis: 'user', note: 'No transaction in 6 months.' },
      { name: 'Believed cause', status: 'retained', basis: 'user-belief', note: 'They forgot.' },
    ]);
    const [fact, belief] = briefDimensions(b);
    expect(fact.basis).toBe('user');
    expect(belief.basis).toBe('user-belief');
    // And only the belief is marked unverified.
    expect(fact.note).not.toMatch(BELIEF);
    expect(belief.note).toMatch(BELIEF);
  });

  it('marks a belief without demoting it', () => {
    // Deliberately NOT normalised to 'deferred' the way an assumption is.
    // Designing on the user's read of their own customers is the right thing
    // to do — 'deferred' would wrongly claim the agent chose not to pursue it.
    // Only the note changes, so 'retained' can never read as 'established'.
    const d = briefDimensions(withBelief())[0];
    expect(d.status).toBe('retained');
    expect(d.note).toContain('User thinks they simply forgot about the card.');
    expect(d.note).toMatch(BELIEF);
  });

  it('does not stack the marker when a round restates the same dimension', () => {
    let b = withBelief();
    for (let i = 0; i < 4; i++) {
      b = recordDimensions(b, [{ name: 'Believed cause of stoppage', status: 'retained', basis: 'user-belief' }]);
    }
    const note = briefDimensions(b)[0].note!;
    expect(note.match(new RegExp('carried as a hypothesis', 'g'))).toHaveLength(1);
  });

  it('marks a belief that arrives with no note of its own', () => {
    const b = recordDimensions(newBrief('o'), [{ name: 'Cause', status: 'retained', basis: 'user-belief' }]);
    expect(briefDimensions(b)[0].note).toMatch(BELIEF);
  });

  it('never blocks the conversation on a belief', () => {
    // The marker is a disclosure, not a gate. A belief that held discovery
    // open would loop for ever: no further question can turn a conjecture
    // about causation into a measured fact.
    const b = alternativesRuledOut(withBelief());
    expect(outstandingDimensions(b)).toHaveLength(0);
    expect(discoveryIsComplete(b)).toBe(true);
  });

  it('leaves the assumption rule exactly as it was', () => {
    // Regression guard: assumptions are still demoted to 'deferred', which is
    // the opposite treatment and must not have been collapsed into the new one.
    const b = recordDimensions(newBrief('o'), [
      { name: 'Channel cost', status: 'retained', basis: 'assumption' },
      { name: 'Balance targeting', status: 'unavailable', basis: 'assumption' },
    ]);
    const [retained, unavailable] = briefDimensions(b);
    expect(retained.status).toBe('deferred');
    expect(unavailable.status).toBe('deferred');
    expect(unavailable.note).toMatch(/unverified/i);
  });
});

describe('the brief puts the stopping decision in front of the model', () => {
  it('lists the beliefs the design would rest on, by name', () => {
    const out = briefForPrompt(withBelief());
    expect(out).toContain('DECIDE BEFORE YOU PROPOSE');
    expect(out).toContain('"Believed cause of stoppage"');
  });

  it('offers exactly two exits and forbids the third', () => {
    const out = briefForPrompt(withBelief());
    expect(out).toMatch(/ask a question that separates the competing explanations, or carry them into the strategy as hypotheses/);
    expect(out).toMatch(/Designing for one reading without saying you chose it is not an option/);
    // Both exits must be reachable, or this becomes a forced extra round.
    expect(out).toMatch(/Carrying is right when they genuinely cannot know, or when every explanation leads to the same campaign/);
  });

  it('says nothing when no belief is in play', () => {
    // Measured failure mode in its own right: a standing instruction that
    // fires on every turn is noise the model learns to skip.
    const b = recordDimensions(newBrief('o'), [{ name: 'Success measure', status: 'retained', basis: 'user' }]);
    expect(briefForPrompt(b)).not.toContain('DECIDE BEFORE YOU PROPOSE');
  });
});

describe('a proposal may not quietly build on an untreated belief', () => {
  const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');

  it('refuses a strategy that nowhere records the belief as a hypothesis', () => {
    expect(src).toMatch(/const beliefsInPlay = briefDimensions\(brief\)\.filter\(\(d\) => d\.basis === 'user-belief'\)/);
    expect(src).toMatch(/const beliefUntreated = !limitReached && beliefsInPlay\.length > 0 && proposed !== null && !strategyNamesAHypothesis/);
  });

  it('accepts any of the three honest ways of saying so', () => {
    // hypotheses, unknowns, or a strategic-ambiguity open item. All three put
    // it in front of the user, which is the whole requirement — insisting on
    // one specific field would be a formatting rule, not a correctness one.
    const decl = src.slice(src.indexOf('const strategyNamesAHypothesis'), src.indexOf('const beliefUntreated'));
    expect(decl).toMatch(/strategy\?\.hypotheses\?\.length/);
    expect(decl).toMatch(/strategy\?\.unknowns\?\.length/);
    expect(decl).toMatch(/kind === 'strategic-ambiguity'/);
  });

  it('is loop-safe by construction', () => {
    // The model ends the condition by writing one hypothesis OR by asking the
    // question instead. Both are one turn away and always available, so this
    // cannot hold a conversation open the way a round count would.
    expect(src).toMatch(/Loop-safe by construction/);
    // It only ever fires on a PROPOSE turn, never on an ask.
    expect(src).toMatch(/proposed !== null && !strategyNamesAHypothesis/);
  });

  it('returns through the same branch as a gate refusal', () => {
    // So a refused proposal cannot leak its strategy or blueprint.
    const branch = src.slice(
      src.indexOf("if (gate.outcome === 'continue_discovery'"),
      src.indexOf('// Discovery is complete. If the model only asked questions'),
    );
    expect(branch).toMatch(/strategy: null/);
    expect(branch).toMatch(/pendingBlueprint: null/);
  });

  it('tells the user what it is doing in their own terms', () => {
    expect(src).toMatch(/which you offered as your own reading rather than something measured/);
  });
});

describe('the prompt teaches the distinction it has to record', () => {
  const SYSTEM = (() => {
    const s = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
    return /const SYSTEM = `([\s\S]*?)`;\n/.exec(s)![1];
  })();

  it('defines both user bases by what the user can actually know', () => {
    expect(SYSTEM).toMatch(/"user" is for what they OWN and are the authority on/);
    expect(SYSTEM).toMatch(/"user-belief" is for their explanation of WHY customers behave as they do/);
    expect(SYSTEM).toMatch(/a conjecture about cause, which they cannot actually know/);
  });

  it('closes the confidence loophole', () => {
    // The failure was not hedged language from the user. "We think the main
    // blocker is interest-cost hesitation" is stated plainly and was recorded
    // as fact, so confidence of delivery must not be the test.
    expect(SYSTEM).toMatch(/however confidently it was put to you/);
    expect(SYSTEM).toMatch(/calling it "user" turns their guess into the finding your campaign rests on/);
  });
});
