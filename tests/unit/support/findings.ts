// Shared fixture: a brief whose two customer findings are settled.
//
// WHY THIS EXISTS. The discovery gate now requires both findings before a
// proposal is allowed — who converts today, and why the rest do not — because
// a campaign to raise conversion cannot be designed without the audience and
// the intervention. Seven test files had a `considered()` fixture meaning
// "discovery is complete", and completeness now includes these. Putting the
// setup here rather than copying it seven times means the next change to the
// rule has one place to go.
//
// Note the answer text and the barrier quote are deliberately consistent:
// `recordBarriers` verifies a claimed quote against what the user actually
// typed and downgrades the basis when it does not match, so a fixture that
// quotes something nobody said would be silently recorded as an assumption
// and would NOT satisfy the gate. That is the check working, and it applies
// to test fixtures exactly as it applies to the model.
import { recordAnswer, recordBarriers, recordConverters, recordDimensions, type WorkingBrief } from '../../../server/discovery';

/** The reason, in the voice of someone who was asked and answered. */
export const WHY_THEY_DO_NOT = 'they think the interest makes it too expensive';

/**
 * Settle both findings on a brief.
 *
 * Records the answer first, so the barrier's quote has something real to
 * match against.
 */
/**
 * Two alternatives, raised and ruled out WITH a reason.
 *
 * Discovery is not complete until the agent has considered more than the
 * first plausible idea: it may be certain about one factor, but it has to
 * have asked about the others and said what became of them. `deferred` and
 * `unavailable` are legitimate endings; a note is what separates ruling
 * something out from quietly dropping it.
 */
export const alternativesRuledOut = (b: WorkingBrief): WorkingBrief =>
  recordDimensions(b, [
    {
      name: 'Timing against the statement cycle',
      rationale: 'When the message lands could matter more than what it says.',
      status: 'deferred',
      basis: 'assumption',
      note: 'No statement-date attribute exists, so this cannot be targeted. Carried as an assumption.',
    },
    {
      name: 'Channel preference by segment',
      rationale: 'Different groups may respond on different channels.',
      status: 'unavailable',
      basis: 'none',
      note: 'No per-customer channel engagement history exists for this tenant.',
    },
  ]);

// FINDINGS ONLY: who converts and why the rest do not. Dimensions are a
// different concern and live in `alternativesRuledOut`, because a helper that
// quietly does both makes "nothing has been considered" impossible to express.
export const settleFindings = (b: WorkingBrief): WorkingBrief =>
  recordBarriers(
    recordConverters(recordAnswer(b, `honestly not sure, ${WHY_THEY_DO_NOT}`), {
      shape: 'mostly large-ticket purchases',
      basis: 'user',
      knowledge: 'known',
    }),
    [
      {
        id: 'cost-perception',
        statement: 'Customers believe converting to EMI is expensive.',
        basis: 'user-belief',
        lever: 'message',
        quote: WHY_THEY_DO_NOT,
      },
    ],
  );

/** Findings settled AND alternatives ruled out: a brief that has finished discovery. */
export const discovered = (b: WorkingBrief): WorkingBrief => alternativesRuledOut(settleFindings(b));
