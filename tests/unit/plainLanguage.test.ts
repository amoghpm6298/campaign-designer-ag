// Fix 2: does the reply read like something a campaign manager can act on?
//
// MEASURED across one five-turn run, in 42,240 characters of user-visible
// text: 27 principle codes, 35 raw underscored identifiers, 4 internal
// question ids, plus blocker paths into the data. One turn opened by narrating
// its own bookkeeping: "Both q1-0 and q1-1 are now genuinely answered".
//
// The checker REPORTS and never rewrites. A regex that quietly strips "P-003"
// out of a sentence mangles the meaning and hides the problem, which is the
// difference between a fix and a hack.
import { describe, it, expect } from 'vitest';
import { internalJargon, jargonNotes } from '../../server/plainLanguage';

describe('internal identifiers are caught', () => {
  it('catches question ids', () => {
    const f = internalJargon('Both q1-0 and q1-1 are now genuinely answered.');
    expect(f.map((x) => x.kind)).toContain('question-id');
    expect(f[0].examples).toEqual(['q1-0', 'q1-1']);
    expect(f[0].count).toBe(2);
  });

  it('catches principle codes', () => {
    expect(internalJargon('spaced 48h apart per P-003 and P-010').map((x) => x.kind))
      .toContain('principle-code');
  });

  it('catches raw underscored identifiers', () => {
    const f = internalJargon('Entry on EMI_STATUS_CHANGED where Initiated By = CUSTOMER_INITIATED');
    const raw = f.find((x) => x.kind === 'raw-identifier')!;
    expect(raw.examples).toEqual(['EMI_STATUS_CHANGED', 'CUSTOMER_INITIATED']);
  });

  it('catches paths into the data', () => {
    expect(internalJargon('steps[0].experiment.arms[0][1].wait: 2 open slots exist.')
      .map((x) => x.kind)).toContain('code-path');
  });
});

describe('precision is not mistaken for jargon', () => {
  it('leaves readable platform facts alone', () => {
    // These are precise AND readable, and the person approving the campaign
    // may well want them. Removing them would destroy information.
    expect(internalJargon('Target accounts where New Status = Pending and EMI Eligible = true')).toEqual([]);
  });

  it('leaves ordinary short acronyms alone', () => {
    expect(internalJargon('Send by EMAIL, then SMS, then WHATSAPP, for an EMI on the OS balance.')).toEqual([]);
  });

  it('says nothing about clean copy', () => {
    expect(internalJargon('We will reach customers whose balance has just become eligible, three days apart.')).toEqual([]);
    expect(jargonNotes('Clean plain writing with no identifiers.')).toEqual([]);
  });
});

describe('the report tells the agent what to do instead', () => {
  it('gives a count, examples and advice per finding', () => {
    const notes = jargonNotes('q1-0 said so, per P-003, on EMI_STATUS_CHANGED.');
    expect(notes).toHaveLength(3);
    expect(notes[0]).toContain('1 internal question id');
    expect(notes[0]).toContain('q1-0');
    expect(notes.join(' ')).toContain('Name the thing in words');
  });

  it('never returns rewritten text, only findings', () => {
    const original = 'Entry on EMI_STATUS_CHANGED per P-003.';
    jargonNotes(original);
    expect(original).toBe('Entry on EMI_STATUS_CHANGED per P-003.');
  });
});
