// The run log claims to show which prompt blocks were sent. This is what
// makes that claim safe.
//
// Each marker is matched against the REAL assembled brief, so the catalogue
// cannot invent a block. But a marker could still go stale: someone rewords a
// line in discovery.ts, the marker stops matching, and the log quietly reports
// a block as absent on every turn forever. Nothing would fail. These tests
// fail instead.
import { describe, it, expect } from 'vitest';
import {
  briefForPrompt,
  newBrief,
  recordQuestions,
  recordAnswer,
  recordDimensions,
  recordFacts,
  recordSuccessCriteria,
  recordContextChecked,
  recordEvidenceRequests,
  recordAddressedQuestions,
  recordApplicationVerdict,
  repeatedWarnings,
  type WorkingBrief,
} from '../../server/discovery';
import { BRIEF_BLOCKS, blocksIn, blocksAbsent, SYSTEM_SECTIONS } from '../../server/promptBlocks';

const OBJ = 'I want to increase OS-to-EMI conversions. Design a drip campaign for this.';

const contingency = {
  ifA: 'Never started a request',
  thenA: 'Enter on audience and drive initiation',
  ifB: 'Started and stalled',
  thenB: 'Enter on the request event and recover it',
  ifUnknown: 'Default to never-started and say so',
};

/** A brief rich enough that nearly every block should be present. */
function fullBrief(): WorkingBrief {
  let b = newBrief(OBJ);
  b = recordQuestions(b, [
    { text: 'Never started, or started and stalled?', impact: 'fork', contingency },
    { text: 'A fork with nothing behind it', impact: 'fork' },
    { text: 'Unclassified one' },
    { text: 'A detail the reply did cover', impact: 'detail' },
  ]);
  b = recordAnswer(b, 'Something that addresses only the last one.');
  // q1-3 only. Marking the unclassified q1-2 as addressed is what broke the
  // first version of this fixture: nothing unclassified was left pending, so
  // the block correctly did not fire and the test blamed a stale marker.
  b = recordAddressedQuestions(b, ['q1-3']);
  b = recordDimensions(b, [
    { name: 'Suspected barrier', rationale: 'Changes the message.', status: 'retained', basis: 'user-belief', note: 'User offered interest-cost hesitation.' },
  ]);
  b = recordFacts(b, [{ statement: 'Success is counted, not valued.', source: 'user-answer' }]);
  // No recordLimitations exists; limitations are set by the orchestrator from
  // tool findings, so the fixture sets the field the brief actually carries.
  b = { ...b, limitations: ['No attribute carries a running outstanding balance.'] };
  b = recordContextChecked(b, [{ source: 'platform metadata', found: true }]);
  b = recordEvidenceRequests(b, [{ question: 'Any historical conversion data?' }]);
  return b;
}

describe('every catalogued block can actually be produced', () => {
  const rich = briefForPrompt(fullBrief());
  const present = new Set(blocksIn(rich).map((b) => b.id));

  // Blocks that need a state this fixture deliberately does not create.
  const elsewhere = new Set(['objective-first', 'objective-settled', 'conflicts', 'fork-declined', 'app-verdict']);

  for (const b of BRIEF_BLOCKS.filter((x) => !elsewhere.has(x.id))) {
    it(`finds "${b.name}"`, () => {
      expect(present.has(b.id), `marker went stale: ${JSON.stringify(b.marker)}`).toBe(true);
    });
  }

  it('finds the opening-round objective gate on a fresh brief', () => {
    expect(blocksIn(briefForPrompt(newBrief(OBJ))).map((b) => b.id)).toContain('objective-first');
  });

  it('finds the settled objective once it exists', () => {
    const b = recordSuccessCriteria(newBrief(OBJ), ['Count of requests reaching Successful.']);
    expect(blocksIn(briefForPrompt(b)).map((b2) => b2.id)).toContain('objective-settled');
  });

  it('finds a declined fork claim', () => {
    let b = recordQuestions(newBrief(OBJ), [
      { text: 'Fork with no contingency', impact: 'fork' },
    ]);
    b = recordAnswer(b, 'Unrelated.');
    expect(blocksIn(briefForPrompt(b)).map((x) => x.id)).toContain('fork-declined');
  });
});

describe('the catalogue reports absence honestly', () => {
  it('reports most blocks absent on the opening turn', () => {
    const opening = briefForPrompt(newBrief(OBJ));
    const present = blocksIn(opening);
    const absent = blocksAbsent(opening);
    // The opening turn has no record and no questions yet, so only the
    // objective gate should fire. If this ever reports many blocks, the
    // detection is matching something generic.
    expect(present.map((b) => b.id)).toEqual(['objective-first']);
    expect(absent.length).toBe(BRIEF_BLOCKS.length - 1);
  });

  it('every block has a distinct id and a non-empty purpose', () => {
    expect(new Set(BRIEF_BLOCKS.map((b) => b.id)).size).toBe(BRIEF_BLOCKS.length);
    for (const b of BRIEF_BLOCKS) {
      expect(b.purpose.trim().length).toBeGreaterThan(20);
      expect(b.marker.trim().length).toBeGreaterThan(8);
    }
  });

  it('no marker is a substring of another, which would double-report', () => {
    for (const a of BRIEF_BLOCKS)
      for (const b of BRIEF_BLOCKS)
        if (a.id !== b.id) expect(a.marker.includes(b.marker)).toBe(false);
  });
});

describe('the system prompt sections are described', () => {
  it('names every section with what it is responsible for', () => {
    expect(SYSTEM_SECTIONS.length).toBeGreaterThanOrEqual(4);
    for (const s of SYSTEM_SECTIONS) expect(s.purpose.trim().length).toBeGreaterThan(20);
  });
});

// Fix 1: the application's own verdicts must reach the next turn.
//
// MEASURED: on a live five-turn run the application told the user three times
// that the experiment could not show which barrier was real, and the agent
// proposed the identical design all three times. It never saw the finding —
// every other application output reached the brief, this one did not.
describe('the application talks back', () => {
  const verdict = {
    comparison: { status: 'differentiated', why: 'They differ in who they reach.' },
    warnings: ['The experiment "A vs B" runs the same journey in every arm. It cannot show which barrier was real.'],
    blockers: ['steps[0].experiment.arms[0][1].wait: 2 open slots exist.'],
  };

  it('carries the verdict into the next brief', () => {
    const b = recordApplicationVerdict(newBrief(OBJ), verdict);
    const out = briefForPrompt(b);
    expect(blocksIn(out).map((x) => x.id)).toContain('app-verdict');
    expect(out).toContain('runs the same journey in every arm');
    expect(out).toContain('could not be generated');
    expect(out).toMatch(/Fix it or say why you are keeping it/);
  });

  it('does not nag when there is nothing to report', () => {
    const b = recordApplicationVerdict(newBrief(OBJ), { comparison: undefined, warnings: [], blockers: [] });
    expect(b.verdicts ?? []).toHaveLength(0);
    expect(blocksIn(briefForPrompt(b)).map((x) => x.id)).not.toContain('app-verdict');
  });

  it('stays quiet about a comparison that passed', () => {
    const b = recordApplicationVerdict(newBrief(OBJ), { comparison: { status: 'differentiated', why: 'fine' } });
    expect(briefForPrompt(b)).not.toContain('were judged differentiated');
  });

  it('counts a repeat even when the agent renames the experiment', () => {
    // The real run renamed it every turn: "Cost-reassurance vs. simplicity/
    // awareness messaging test" then "...vs simplicity/awareness framing" then
    // "Cost reassurance vs simplicity framing". Whole-string matching would
    // have called those three unrelated warnings and missed that nothing moved.
    let b = newBrief(OBJ);
    b = recordApplicationVerdict(b, { warnings: ['The experiment "Cost-reassurance vs. simplicity/awareness messaging test" runs the same journey in every arm.'] });
    b = recordApplicationVerdict(b, { warnings: ['The experiment "Cost reassurance vs simplicity framing" runs the same journey in every arm.'] });
    const rep = repeatedWarnings(b);
    expect(rep).toHaveLength(1);
    expect(rep[0].times).toBe(2);
    expect(briefForPrompt(b)).toMatch(/told this on 2 separate proposals/);
  });

  it('shows only the latest verdict, not every one ever recorded', () => {
    let b = newBrief(OBJ);
    b = recordApplicationVerdict(b, { warnings: ['An old problem that was fixed.'] });
    b = recordApplicationVerdict(b, { warnings: ['The current problem.'] });
    const out = briefForPrompt(b);
    expect(out).toContain('The current problem.');
    expect(out).not.toContain('An old problem that was fixed.');
  });
});
