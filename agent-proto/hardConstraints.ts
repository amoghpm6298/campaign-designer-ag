// The explicit hard-constraint registry.
//
// Why this exists. Before it, the set of hard constraints the validator knew
// about was IMPLICIT — it was whichever checks happened to push an entry. A
// constraint with no check produced no record, and a constraint with no
// record was indistinguishable from one that passed. The audit proved the
// consequence: a campaign sending on RCS, which the bank context marks
// available: false, came back PRE-VALIDATED with five applicable hard
// constraints never represented at all.
//
// The fix is to invert the default. Every known hard constraint is declared
// here and starts at 'not-run'. A check can only ever IMPROVE on that, and
// anything unimplemented stays visible in the run record and keeps the
// outcome at 'incomplete'. Declaring the list is the point; this is not a
// policy engine — there is no rule evaluation here, only a status per id.
//
// None of these values is configuration the agent owns. Every one is read
// from the issuer's configuration (in this prototype, the INVENTED mock
// context) and passed in.

export type ConstraintStatus =
  /** Verified against the campaign, and compliant. */
  | 'pass'
  /** A violation was confirmed. */
  | 'fail'
  /**
   * Applies, but could not be evaluated. NOT the same as compliant, and it
   * keeps the run outcome at 'incomplete'.
   */
  | 'not-run'
  /**
   * Does not apply to this campaign or this prototype's scope, with a stated
   * reason. Deliberately distinct from 'not-run': conflating "does not apply"
   * with "applies but unchecked" is how an unverified constraint hides.
   */
  | 'not-applicable';

export interface HardConstraintRecord {
  id: string;
  /** Plain-sentence name, for a reader of the run record. */
  name: string;
  /** Where the configuration comes from — never somewhere the agent defines. */
  source: string;
  status: ConstraintStatus;
  /** Evidence for pass/fail, or the specific reason for not-run/not-applicable. */
  detail: string;
  /** The function that established the status. '—' when nothing ran. */
  executedBy: string;
}

/**
 * Every hard constraint known to this prototype, with its starting status.
 *
 * A constraint whose check is not implemented yet starts — and stays — at
 * 'not-run' with a reason saying so. It must never read as enforced.
 */
export function initialHardConstraints(): HardConstraintRecord[] {
  const unimplemented = (detail: string) => ({ status: 'not-run' as const, executedBy: '—', detail });

  return [
    {
      id: 'channel-availability',
      name: 'Every Send delivers only on channels the issuer has available',
      source: 'bank-context.channels.available[].available',
      ...unimplemented(
        'Not evaluated: no channels.available configuration was supplied to validateCampaignGraph.',
      ),
    },
    {
      id: 'message-cap',
      name: 'No single customer receives more messages than the per-campaign cap',
      source: 'bank-context.hardConstraints.maxMessagesPerCustomerPerCampaign',
      ...unimplemented('Not evaluated: no cap was supplied to validateCampaignGraph.'),
    },
    {
      id: 'message-spacing',
      name: 'Consecutive messages to one customer are at least the minimum gap apart',
      source: 'bank-context.hardConstraints.minHoursBetweenMessages',
      ...unimplemented(
        'No check implemented. The planner inserts a Pause of the configured length (planner.ts), so the ' +
          'spacing holds by construction only — nothing verifies it against the graph, and an edited or ' +
          'differently-shaped campaign would not be caught.',
      ),
    },
    {
      id: 'quiet-hours',
      name: 'No Send is configured to fire inside the issuer\'s quiet-hours window',
      source: 'bank-context.hardConstraints.quietHours (issuer configuration; INVENTED in this prototype)',
      ...unimplemented('Not evaluated: no quiet-hours window was supplied to validateCampaignGraph.'),
    },
    // DNC and NPA are NOT here, and their removal was a correction.
    //
    // They were listed as issuer-level hard constraints read from
    // bank-context.hardConstraints.dncRequired / npaExclusionRequired. That
    // was wrong: the application models them as campaign-level USER choices
    // on a user-editable step (GuardrailsStep.tsx), stored in
    // DripCampaign.guardrails. The agent must not derive them from bank
    // context, and it must not treat the UI's `?? true` default as a
    // confirmed choice.
    //
    // They are now handled as campaign configuration — omitted from the
    // payload and recorded `unresolved` in campaignFieldProvenance — which
    // is a structural concern, not a hard-constraint one. See
    // campaignFields.ts.
    {
      id: 'event-freeze',
      name: 'The campaign does not run inside a freeze window on the issuer\'s events calendar',
      source: 'bank-context.eventsCalendar.entries[] where type = freeze',
      ...unimplemented(
        'No check implemented, and the input is missing too: the generated campaign carries no startDate or ' +
          'endDate, so there is no schedule to compare against the calendar. Both would be needed.',
      ),
    },
    {
      // Honest applicability, per the prototype's scope. The MECHANISM is
      // real — computeMakerCheckerFlag(issuer, programs) in the app — but it
      // is keyed to real issuers via ISSUER_MAKER_CHECKER / PROGRAM_MAKER_CHECKER.
      // Meridian Bank is fictional and is not in PROGRAM_OPTIONS, so there is
      // no real approval path for it to route through. Calling the function
      // would require inventing an issuer mapping, which is exactly what this
      // prototype refuses to do.
      //
      // This is 'not-applicable', NOT 'pass': nothing was verified. It would
      // become applicable the moment a real issuer is used, and must be
      // re-classified then.
      id: 'maker-checker',
      name: 'The campaign routes through the correct approval path for this issuer and programs',
      source: 'computeMakerCheckerFlag (src/data/sharedConstants.ts) — real mechanism, real issuers only',
      status: 'not-applicable',
      executedBy: '—',
      detail:
        'Not applicable in this prototype: the real mechanism is keyed to real issuers, and Meridian Bank is ' +
        'fictional and absent from PROGRAM_OPTIONS. Nothing was verified — this is not a pass. Becomes ' +
        'applicable, and must be re-classified, as soon as a real issuer is used.',
    },
  ];
}

/** Applicable = anything the campaign must actually satisfy. */
export const isApplicable = (c: HardConstraintRecord) => c.status !== 'not-applicable';
