// The campaign-design state machine.
//
// Explicit states with validated transitions, so "discovery gates generation"
// is a property of the application rather than a hope about the prompt.
//
// The invariant that matters: GENERATING_CAMPAIGN is reachable only from
// AWAITING_STRATEGY_CONFIRMATION, and only when a confirmation is recorded
// for the CURRENT brief and strategy version. A stale confirmation — given
// before the user changed their objective — is not a confirmation.

export type CampaignState =
  | 'UNDERSTANDING_GOAL'
  | 'DISCOVERING'
  | 'AWAITING_USER_ANSWER'
  | 'STRATEGY_READY'
  | 'AWAITING_STRATEGY_CONFIRMATION'
  | 'GENERATING_CAMPAIGN'
  | 'CAMPAIGN_REVIEW'
  | 'CONFIGURATION_INCOMPLETE'
  | 'EXPORT_ELIGIBLE'
  | 'FAILED';

/**
 * Legal transitions. Everything absent here is illegal — notably
 * DISCOVERING -> GENERATING_CAMPAIGN and AWAITING_USER_ANSWER -> anything
 * that builds.
 */
const LEGAL: Record<CampaignState, CampaignState[]> = {
  UNDERSTANDING_GOAL: ['DISCOVERING', 'STRATEGY_READY', 'FAILED'],
  // Discovery may loop, or finish. It may NEVER go straight to generation.
  DISCOVERING: ['AWAITING_USER_ANSWER', 'STRATEGY_READY', 'FAILED'],
  AWAITING_USER_ANSWER: ['DISCOVERING', 'STRATEGY_READY', 'FAILED'],
  STRATEGY_READY: ['AWAITING_STRATEGY_CONFIRMATION', 'DISCOVERING', 'FAILED'],
  // The only door into generation.
  AWAITING_STRATEGY_CONFIRMATION: ['GENERATING_CAMPAIGN', 'DISCOVERING', 'STRATEGY_READY', 'FAILED'],
  // EXPORT_ELIGIBLE belongs here: a campaign whose configuration is complete
  // on first generation goes straight to exportable. Omitting it crashed the
  // happy path — every earlier live run had unresolved Send fields, so only
  // CONFIGURATION_INCOMPLETE was ever reached and the gap stayed hidden.
  GENERATING_CAMPAIGN: ['CAMPAIGN_REVIEW', 'CONFIGURATION_INCOMPLETE', 'EXPORT_ELIGIBLE', 'FAILED'],
  CAMPAIGN_REVIEW: ['GENERATING_CAMPAIGN', 'CONFIGURATION_INCOMPLETE', 'EXPORT_ELIGIBLE', 'DISCOVERING', 'FAILED'],
  CONFIGURATION_INCOMPLETE: ['GENERATING_CAMPAIGN', 'CAMPAIGN_REVIEW', 'EXPORT_ELIGIBLE', 'DISCOVERING', 'FAILED'],
  EXPORT_ELIGIBLE: ['GENERATING_CAMPAIGN', 'CAMPAIGN_REVIEW', 'CONFIGURATION_INCOMPLETE', 'DISCOVERING', 'FAILED'],
  FAILED: ['UNDERSTANDING_GOAL', 'DISCOVERING', 'AWAITING_STRATEGY_CONFIRMATION'],
};

export function canTransition(from: CampaignState, to: CampaignState): boolean {
  return LEGAL[from]?.includes(to) ?? false;
}

export class IllegalTransitionError extends Error {
  readonly from: CampaignState;
  readonly to: CampaignState;
  constructor(from: CampaignState, to: CampaignState) {
    super(`Illegal state transition ${from} -> ${to}.`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

export function transition(from: CampaignState, to: CampaignState): CampaignState {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}

/**
 * A confirmation is bound to the brief and strategy it was given for. Change
 * either, and it no longer authorises anything.
 */
export interface StrategyConfirmation {
  objectiveFingerprint: string;
  strategyVersion: number;
  confirmedAt: string;
}

export interface SessionState {
  state: CampaignState;
  strategyVersion: number;
  confirmation: StrategyConfirmation | null;
}

export function newSession(): SessionState {
  return { state: 'UNDERSTANDING_GOAL', strategyVersion: 0, confirmation: null };
}

/**
 * The single authority on whether the graph may be built.
 *
 * Returns the reason when it may not, so the caller reports a cause rather
 * than silently doing nothing.
 */
export function mayGenerate(
  session: SessionState,
  currentObjectiveFingerprint: string,
): { ok: true } | { ok: false; reason: string } {
  if (!session.confirmation) {
    return { ok: false, reason: 'No strategy has been confirmed for this campaign yet.' };
  }
  if (session.confirmation.objectiveFingerprint !== currentObjectiveFingerprint) {
    return {
      ok: false,
      reason:
        'The objective changed after the strategy was confirmed, so that confirmation no longer applies. The agent will revisit the strategy.',
    };
  }
  if (session.confirmation.strategyVersion !== session.strategyVersion) {
    return {
      ok: false,
      reason: 'The strategy changed after it was confirmed. Confirm the current strategy before generating.',
    };
  }
  if (!canTransition(session.state, 'GENERATING_CAMPAIGN')) {
    return { ok: false, reason: `Cannot generate from state ${session.state}.` };
  }
  return { ok: true };
}

/** Invalidates a confirmation when the user materially changes the brief. */
export function invalidateConfirmation(session: SessionState): SessionState {
  return { ...session, confirmation: null };
}
