// The agent can see its own record, and retrieval is recorded rather than
// claimed.
//
// THREE MEASURED DEFECTS, all from the same cause: the brief sent back to the
// model was missing the things the model had just written.
//
//  1. DUPLICATION. `briefForPrompt` omitted the dimension record, so the model
//     restated it from memory each round, reworded. "7-day request expiry
//     window (P-003)" came back as "Window before the request closes", and the
//     record went 4 entries -> 9 across two turns, one question held twice
//     with contradictory provenance.
//  2. SELF-ASSIGNED SUCCESS. The brief never said whether success was settled,
//     and the prompt let the agent write itself a "working definition". Live:
//     2 successCriteria entries existed before the user had said anything.
//  3. UNRECORDED RETRIEVAL. `contextChecked` existed and was never written to,
//     so "I checked X" was prose nobody could audit.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  briefForPrompt,
  newBrief,
  recordDimensions,
  recordSuccessCriteria,
  recordContextChecked,
  recordAnswer,
  type WorkingBrief,
} from '../../server/discovery';

const OBJECTIVE = 'I want to increase OS-to-EMI conversions. Design a drip campaign for this.';
const SYSTEM = (() => {
  const src = readFileSync(new URL('../../server/orchestrator.ts', import.meta.url), 'utf8');
  return /const SYSTEM = `([\s\S]*?)`;\n/.exec(src)![1];
})();

describe('the dimension record goes back to the model', () => {
  const b = recordDimensions(newBrief(OBJECTIVE), [
    { name: 'Outstanding statement amount', rationale: 'Amount may change the offer.', status: 'unavailable', basis: 'tool', note: 'No amount field on EMI Request.' },
    { name: 'Statement timing', rationale: 'When to intervene.', status: 'open', basis: 'none' },
  ]);

  it('includes every dimension name, status and basis', () => {
    const out = briefForPrompt(b);
    expect(out).toContain('"Outstanding statement amount" [unavailable/tool]');
    expect(out).toContain('"Statement timing" [open/none]');
    expect(out).toContain('No amount field on EMI Request.');
  });

  it('tells the model that an exact name updates and a new name duplicates', () => {
    // This instruction is the whole fix for the duplication: matching is by
    // exact name, so the names must be visible AND the rule must be stated.
    expect(briefForPrompt(b)).toMatch(/Reuse the NAME EXACTLY to update one; a new name creates a new entry/);
  });

  it('says nothing about dimensions when none are recorded', () => {
    expect(briefForPrompt(newBrief(OBJECTIVE))).not.toMatch(/Dimensions you have already recorded/);
  });
});

describe('the brief states whether success is settled', () => {
  it('reserves the first round for the objective alone', () => {
    const out = briefForPrompt(newBrief(OBJECTIVE));
    expect(out).toMatch(/NOT YET SETTLED/);
    // The sequencing rule, not the old bare "ask the user": a first round that
    // mixes objective questions in with audience and cause questions gets the
    // objective's answer too late for it to direct the others.
    expect(out).toContain('THIS ROUND IS FOR THE OBJECTIVE AND NOTHING ELSE');
    expect(out).toMatch(/Not the audience, not the suspected cause, not what data exists/);
  });

  it('lists the settled criteria once they exist, and drops the warning', () => {
    const b = recordSuccessCriteria(newBrief(OBJECTIVE), ['Pending to Successful rate versus control.']);
    const out = briefForPrompt(b);
    expect(out).toContain('How success is to be judged, already settled:');
    expect(out).toContain('Pending to Successful rate versus control.');
    expect(out).not.toMatch(/NOT YET SETTLED/);
  });
});

describe('checked sources are recorded, not just claimed', () => {
  it('records each source once, with whether anything was found', () => {
    let b = recordContextChecked(newBrief(OBJECTIVE), [
      { source: 'platform metadata', found: true },
      { source: 'campaign history', found: false },
    ]);
    b = recordContextChecked(b, [{ source: '  Platform Metadata ', found: false }]);
    expect(b.contextChecked).toHaveLength(2); // deduplicated by source
    // A later fruitless re-check must not erase an earlier finding.
    expect(b.contextChecked!.find((c) => /platform metadata/i.test(c.source))!.found).toBe(true);
    expect(b.contextChecked!.find((c) => /campaign history/i.test(c.source))!.found).toBe(false);
  });

  it('ignores a blank source name', () => {
    const b = recordContextChecked(newBrief(OBJECTIVE), [{ source: '   ', found: true }]);
    expect(b.contextChecked).toEqual([]);
  });

  it('reports them back to the model with the outcome of each', () => {
    const b = recordContextChecked(newBrief(OBJECTIVE), [
      { source: 'knowledge base', found: true },
      { source: 'campaign history', found: false },
    ]);
    const out = briefForPrompt(b);
    expect(out).toContain('Sources already checked:');
    expect(out).toContain('knowledge base — something relevant found');
    expect(out).toContain('campaign history — nothing relevant found');
  });

  it('works on a brief saved before the field was used', () => {
    const legacy = newBrief(OBJECTIVE) as Record<string, unknown>;
    delete legacy.contextChecked;
    const b = legacy as unknown as WorkingBrief;
    expect(() => briefForPrompt(b)).not.toThrow();
    expect(recordContextChecked(b, [{ source: 'knowledge base', found: true }]).contextChecked).toHaveLength(1);
  });
});

describe('the prompt asks for retrieval honestly', () => {
  it('tells the agent to check what it can reach before asking', () => {
    expect(SYSTEM).toMatch(/Check what you can actually reach before you ask/);
    expect(SYSTEM).toMatch(/report what you checked in "contextChecked"/);
  });

  it('forbids implying access it does not have', () => {
    expect(SYSTEM).toMatch(/Only name sources you genuinely consulted/);
    expect(SYSTEM).toMatch(/no access to campaign history, analytics or bank systems/);
    expect(SYSTEM).toMatch(/never imply you looked there/);
  });

  it('requests contextChecked on both the ask and propose payloads', () => {
    const ask = SYSTEM.slice(SYSTEM.indexOf('{"action":"ask"'), SYSTEM.indexOf('{"action":"ask"') + 800);
    expect(ask).toMatch(/"contextChecked":\[/);
    expect(SYSTEM).toMatch(/"action":"propose"[\s\S]{0,900}"contextChecked":\[/);
  });
});

describe('the brief never tells the agent to re-ask something already answered', () => {
  // THE DEFECT, traced on the OS-to-EMI strategy turn. `successCriteria` is
  // only populated from the model's own propose payload, so it lags by one
  // turn. On the turn AFTER the user answered the success question, the brief
  // still read "NOT YET SETTLED. Ask the user before you design anything" —
  // instructing a re-ask of a question just answered, on the very turn the
  // agent was supposed to propose. It proposed anyway by reading the message
  // history, so the symptom was a self-contradictory prompt rather than a
  // visible failure. The dimension statuses on that same turn are NOT a
  // defect: updating those is the model's job that turn.
  const OBJ = 'I want to increase OS-to-EMI conversions. Design a drip campaign for this.';

  it('says ASK on the opening turn, when nothing has been answered', () => {
    const out = briefForPrompt(newBrief(OBJ));
    expect(out).toMatch(/NOT YET SETTLED/);
    expect(out).toContain('THIS ROUND IS FOR THE OBJECTIVE AND NOTHING ELSE');
    expect(out).not.toMatch(/NOT YET RECORDED/);
  });

  it('says RECORD IT, not ask, once the user has answered something', () => {
    const answered = recordAnswer(newBrief(OBJ), 'Success is more EMI Requests reaching Successful.');
    const out = briefForPrompt(answered);
    expect(out).toMatch(/NOT YET RECORDED/);
    expect(out).toMatch(/record it in "successCriteria" on this turn/);
    expect(out).toMatch(/Do not ask again for something they have already told you/);
    // The contradiction is gone.
    expect(out).not.toMatch(/Ask the user before you design anything/);
  });

  it('drops the warning entirely once criteria are recorded', () => {
    const b = recordSuccessCriteria(
      recordAnswer(newBrief(OBJ), 'Success is more EMI Requests reaching Successful.'),
      ['More EMI Requests reaching Successful.'],
    );
    const out = briefForPrompt(b);
    expect(out).toContain('How success is to be judged, already settled:');
    expect(out).not.toMatch(/NOT YET SETTLED|NOT YET RECORDED/);
  });

  it('reproduces the recorded OS-to-EMI strategy turn', () => {
    // Exactly the shape of the real turn: four dimensions the agent raised,
    // no criteria yet, and the user's answer just recorded.
    let b = recordDimensions(newBrief(OBJ), [
      { name: 'Success criteria (business measure)', status: 'open', basis: 'none' },
      { name: 'Who holds the priority outstanding balance (audience definition)', status: 'open', basis: 'none' },
      { name: 'Believed blocker to conversion', status: 'open', basis: 'none' },
      { name: 'Timing trigger for the opportunity', status: 'open', basis: 'none' },
    ]);
    b = recordAnswer(b, 'No target number yet. Success is more EMI Requests reaching Successful.');
    const out = briefForPrompt(b);
    expect(out).toMatch(/NOT YET RECORDED/);
    expect(out).not.toMatch(/Ask the user before you design anything/);
    // The dimension record still travels so the agent can update it in place.
    expect(out).toContain('"Believed blocker to conversion" [open/none]');
  });
});

// Fix 3: there is one definition of success, not a growing list of rewordings.
describe('the objective is replaced, not accumulated', () => {
  const OBJ3 = 'I want to increase OS-to-EMI conversions. Design a drip campaign for this.';

  it('replaces an earlier statement with a later one', () => {
    // MEASURED: the model restates the objective every propose turn, slightly
    // reworded. Appending left the user reading "ongoing optimisation, not
    // tied to a campaign cycle" and "ongoing, open-ended optimisation, not
    // tied to a campaign cycle" as two separate criteria.
    let b = recordSuccessCriteria(newBrief(OBJ3), ['Count of requests reaching Successful.', 'Ongoing optimisation, not tied to a campaign cycle.']);
    b = recordSuccessCriteria(b, ['Count of requests reaching Successful.', 'Ongoing, open-ended optimisation, not tied to a campaign cycle.']);
    expect(b.successCriteria).toHaveLength(2);
    expect(b.successCriteria![1]).toContain('open-ended');
  });

  it('treats silence as silence, never as a retraction', () => {
    const b = recordSuccessCriteria(newBrief(OBJ3), ['Count of requests reaching Successful.']);
    expect(recordSuccessCriteria(b, []).successCriteria).toEqual(['Count of requests reaching Successful.']);
    expect(recordSuccessCriteria(b, ['   ']).successCriteria).toEqual(['Count of requests reaching Successful.']);
  });

  it('returns the same brief when nothing changed', () => {
    const b = recordSuccessCriteria(newBrief(OBJ3), ['One measure.']);
    expect(recordSuccessCriteria(b, ['One measure.'])).toBe(b);
  });
});
