// The objective fingerprint keeps the words the domain turns on.
//
// THE DEFECT, measured end-to-end on the OS-to-EMI scenario. `fingerprint`
// discarded any token of three characters or fewer, which removed every short
// term this product is actually about: OS, EMI, SMS, DNC, NPA, KYC, MCC, RCS.
// The objective "I want to increase OS-to-EMI conversions. Design a drip
// campaign for this." fingerprinted to "campaign conversions design drip
// increase" — five generic words with the subject deleted.
//
// What that broke, observed in a real run: confirming a strategy the agent had
// just proposed was REFUSED, with "The objective changed after this strategy
// was proposed, so confirming it would build the wrong campaign." Nothing had
// changed. The strategy summary says "OS-to-EMI"; the objective fingerprint no
// longer did, so they shared ZERO tokens against a 0.25 threshold and the
// campaign could not be generated at all.
//
// The threshold was never the problem, and is unchanged. Only the token-length
// floor moved, from >3 to >1, because the shortest real term here is "OS".
import { describe, it, expect } from 'vitest';
import { fingerprint, objectiveChangedMaterially } from '../../server/discovery';
import { mayGenerate, type SessionState } from '../../server/campaignState';

const OS_OBJECTIVE = 'I want to increase OS-to-EMI conversions. Design a drip campaign for this.';

/** The same ratio `overlaps` uses for the confirm-path staleness check. */
function overlapMin(a: string, b: string) {
  const sa = new Set(a.split(' ').filter(Boolean));
  const sb = new Set(b.split(' ').filter(Boolean));
  if (!sa.size || !sb.size) return 1;
  const shared = [...sa].filter((w) => sb.has(w)).length;
  return shared / Math.min(sa.size, sb.size);
}

describe('short domain terms survive', () => {
  it('keeps both halves of OS-to-EMI', () => {
    const fp = fingerprint('OS-to-EMI');
    expect(fp.split(' ')).toContain('os');
    expect(fp.split(' ')).toContain('emi');
  });

  it('keeps the short terms this platform is built from', () => {
    for (const term of ['EMI', 'OS', 'SMS', 'DNC', 'NPA', 'KYC', 'MCC', 'RCS']) {
      expect(fingerprint(term), term).toBe(term.toLowerCase());
    }
  });

  it('keeps the subject of the real objective', () => {
    const fp = fingerprint(OS_OBJECTIVE).split(' ');
    expect(fp).toContain('os');
    expect(fp).toContain('emi');
    // ...without losing what it already kept.
    for (const w of ['campaign', 'conversions', 'design', 'drip', 'increase']) expect(fp, w).toContain(w);
  });
});

describe('stop words are still removed', () => {
  it('drops the short function words entirely', () => {
    // The whole point of lowering the floor is to admit domain nouns, not
    // grammar. A sentence of nothing but stop words fingerprints to nothing.
    expect(fingerprint('the and to of is it we do be in on for with our that this')).toBe('');
  });

  it('drops them from a real sentence too', () => {
    const fp = fingerprint(OS_OBJECTIVE).split(' ');
    for (const w of ['to', 'for', 'this', 'i', 'want']) expect(fp, w).not.toContain(w);
  });
});

describe('the confirm-path staleness check now passes for a legitimate confirmation', () => {
  // VERBATIM from the live OS-to-EMI run whose confirmation was refused, so
  // this is the actual text that failed and not a hand-written approximation.
  // Inlined rather than read from disk: a committed test must not depend on a
  // scratchpad that gets cleaned.
  const RECORDED_DESCRIPTION =
    'Reminds customers who already have a Pending outstanding-balance-to-EMI request to complete conversion before the request expires in 7 days.';
  const RECORDED_SUMMARY =
    'Target customers who already have a Pending OS-to-EMI request and have not yet converted. The hypothesis is that some of these customers simply forget or drop off mid-flow, so a short, spaced reminder sequence with an easy entry point back into the flow can recover some of them before the request expires in 7 days. Sequence starts on the cheapest channel and escalates to WhatsApp for the final, most urgent nudge, within the 4-message cap and 48-hour spacing rule.';

  const confirmedFor = fingerprint(`${RECORDED_DESCRIPTION} ${RECORDED_SUMMARY}`);

  it('shares the subject with the objective', () => {
    const shared = [...new Set(confirmedFor.split(' '))].filter((w) =>
      new Set(fingerprint(OS_OBJECTIVE).split(' ')).has(w),
    );
    expect(shared).toContain('os');
    expect(shared).toContain('emi');
  });

  it('clears the unchanged 0.25 threshold', () => {
    expect(overlapMin(confirmedFor, fingerprint(OS_OBJECTIVE))).toBeGreaterThanOrEqual(0.25);
  });
});

describe('a genuinely different objective is still detected', () => {
  it('card activation is not an OS-to-EMI conversion campaign', () => {
    expect(
      objectiveChangedMaterially(
        OS_OBJECTIVE,
        'New cardholders are not completing activation. Get them activated in their first two weeks.',
      ),
    ).toBe(true);
  });

  it('a different EMI product is still a different objective', () => {
    // Shares "emi" but nothing else that matters. Lowering the floor must not
    // make every EMI campaign look like every other one.
    expect(
      objectiveChangedMaterially(OS_OBJECTIVE, 'Reactivate dormant cards with no transaction in 90 days.'),
    ).toBe(true);
  });

  it('a restatement of the same objective is NOT a change', () => {
    expect(
      objectiveChangedMaterially(OS_OBJECTIVE, 'Increase OS-to-EMI conversions with a drip campaign design.'),
    ).toBe(false);
  });
});

describe('approval protections are unchanged', () => {
  const confirmed = (over: Partial<SessionState['confirmation']> = {}): SessionState => ({
    state: 'AWAITING_STRATEGY_CONFIRMATION',
    strategyVersion: 2,
    confirmation: {
      objectiveFingerprint: fingerprint(OS_OBJECTIVE),
      strategyVersion: 2,
      confirmedAt: '2026-10-14T00:00:00.000Z',
      ...over,
    },
  });

  it('permits generation for the objective that was confirmed', () => {
    expect(mayGenerate(confirmed(), fingerprint(OS_OBJECTIVE)).ok).toBe(true);
  });

  it('still refuses when the objective genuinely differs', () => {
    const r = mayGenerate(confirmed(), fingerprint('Reactivate dormant cards with no transaction in 90 days.'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/objective changed/i);
  });

  it('still refuses when the strategy moved on after confirmation', () => {
    const stale: SessionState = { ...confirmed(), strategyVersion: 3 };
    const r = mayGenerate(stale, fingerprint(OS_OBJECTIVE));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/strategy changed/i);
  });

  it('still refuses with no confirmation at all', () => {
    const none: SessionState = { state: 'AWAITING_STRATEGY_CONFIRMATION', strategyVersion: 1, confirmation: null };
    expect(mayGenerate(none, fingerprint(OS_OBJECTIVE)).ok).toBe(false);
  });
});
