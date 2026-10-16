// Is the reply written for the person who has to approve it?
//
// MEASURED across one five-turn run, in 42,240 characters of user-visible
// text: 27 internal principle codes (P-003), 35 raw enum and event names
// (EMI_STATUS_CHANGED, CUSTOMER_INITIATED), 4 internal question ids (q1-0),
// and blocker paths like steps[0].experiment.arms[0][1].wait. One turn opened
// with "Both q1-0 and q1-1 are now genuinely answered and I'm recording them
// as such" — the agent narrating its own bookkeeping to a campaign manager.
//
// WHAT THIS DELIBERATELY DOES NOT DO: rewrite. A regex that quietly strips
// "P-003" out of a sentence would mangle the meaning and hide the problem
// instead of fixing it. This only reports, and the report goes back to the
// agent through the same channel as every other application finding, so the
// agent fixes its own prose.
//
// WHAT IS NOT FLAGGED, on purpose: readable platform facts like
// "New Status = Pending" or "EMI Eligible = true". Those are precise, and the
// person approving a campaign may well want to know exactly what it fires on.
// The problem was never precision — it was unreadable identifiers.

export interface JargonFinding {
  kind: 'question-id' | 'principle-code' | 'raw-identifier' | 'code-path';
  /** What a reader would hit. */
  examples: string[];
  count: number;
  /** What to do instead, in the agent's own output. */
  advice: string;
}

const RULES: { kind: JargonFinding['kind']; re: RegExp; advice: string }[] = [
  {
    kind: 'question-id',
    re: /\bq\d+-\d+\b/g,
    advice: 'Refer to a question by what it asked, not by its id. The user has never seen these ids.',
  },
  {
    kind: 'principle-code',
    re: /\bP-\d{3}\b/g,
    advice: 'State the rule itself rather than its reference code. "Messages are capped at four" beats "per P-010".',
  },
  {
    kind: 'raw-identifier',
    // Two or more words joined by underscores, or a long all-caps run. Single
    // short caps words (EMI, SMS, OS) are ordinary business language here and
    // are left alone.
    re: /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g,
    advice: 'Name the thing in words. "when the EMI request changes status" rather than the raw event name.',
  },
  {
    kind: 'code-path',
    re: /\bsteps\[\d+\][\w.[\]]*/g,
    advice: 'Say which step of the journey is incomplete in plain terms, not as a path into the data.',
  },
];

/** Internal identifiers found in text meant for a campaign manager. */
export function internalJargon(text: string): JargonFinding[] {
  const out: JargonFinding[] = [];
  for (const r of RULES) {
    const hits = text.match(r.re) ?? [];
    if (!hits.length) continue;
    out.push({
      kind: r.kind,
      examples: [...new Set(hits)].slice(0, 5),
      count: hits.length,
      advice: r.advice,
    });
  }
  return out;
}

/** One line per finding, for the brief that goes back to the agent. */
export const jargonNotes = (text: string): string[] =>
  internalJargon(text).map(
    (f) =>
      `Your reply put ${f.count} internal ${f.kind.replace('-', ' ')}${f.count === 1 ? '' : 's'} in front of the user (${f.examples.join(', ')}). ${f.advice}`,
  );
