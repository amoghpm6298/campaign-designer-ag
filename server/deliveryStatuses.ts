// What a delivery status MEANS, for the one question the journey turns on:
// is there a person on the other end of it yet, and did they do something?
//
// THE VOCABULARY IS NOT RESTATED HERE. `DELIVERY_STATUS_BY_CHANNEL` in
// `src/data/sharedConstants.ts` is the real Bifrost list the builder's own
// multi-select is drawn from, and `deliveryStatusOptionsForSend` already
// handles the one subtlety nobody would guess: a Send with a fallback channel
// could have landed on EITHER channel, so both vocabularies apply. This file
// imports those and adds the classification the agent kept getting wrong.
//
// MEASURED, `eval/runs/ui-s-1792748248345` turn 5. The Confirm built a
// Transaction Amount branch, waits of 24/48/72 hours, SMS as a field on the
// send, seventeen Goal Checks and not one split on the previous step's
// outcome. The reply correctly called the canvas a clock — and the retry then
// asked for "the failure path on a different channel", which is the wrong
// instruction twice over: undelivered is a field on the Send, and a FAILED
// arm is not a person reacting.
//
// THREE KINDS, and only one of them belongs on a graph arm:
import {
  DELIVERY_STATUS_BY_CHANNEL,
  deliveryStatusOptionsForSend,
  type Channel,
  type PrevStepSend,
} from '../src/data/sharedConstants';

/**
 * The message is between us and the handset. Not a person.
 *
 * Branching here splits on our own queue depth: everyone in QUEUED is on
 * their way to DELIVERED or to FAILED, and the arm catches whoever the
 * campaign happened to look at mid-flight.
 */
export const IN_FLIGHT_STATUSES = ['QUEUED', 'SENT', 'PENDING', 'SENT_TO_SERVICE_PROVIDER'];

/**
 * It did not land. The fallback channel's job, never an arm of the graph.
 *
 * `fallbackChannel` on the Send is how the platform expresses this, and it is
 * a field rather than a fork for a good reason: nobody takes a different
 * route through the journey, the same message is attempted again somewhere
 * else. A FAILED arm also cannot carry a different JOB — there is nothing to
 * say to someone who never received anything.
 */
export const isUndelivered = (status: string): boolean => {
  const s = status.trim().toUpperCase();
  return (
    s.startsWith('FAILED') ||
    ['UNKNOWN', 'NOT_SENT', 'NOT_DELIVERED', 'HARD_BOUNCE', 'SOFT_BOUNCE', 'SPAM', 'SUPPRESSED', 'REJECTED', 'DND', 'UN_CATEGORISED'].includes(s)
  );
};

/**
 * It landed, and this is what the person did with it.
 *
 * The only kind that earns an arm, because it is the only kind where the arms
 * can do different JOBS: unread in the inbox wants the same fact again,
 * sooner; read-and-not-acted wants a different argument; dismissed wants
 * leaving alone.
 */
export const ENGAGEMENT_STATUSES = ['DELIVERED', 'READ', 'DELETED', 'OPENED', 'CLICKED'];

export const isEngagement = (status: string): boolean =>
  ENGAGEMENT_STATUSES.includes(status.trim().toUpperCase());

export const isInFlight = (status: string): boolean =>
  IN_FLIGHT_STATUSES.includes(status.trim().toUpperCase());

/** The engagement statuses a channel actually emits. WhatsApp has no CLICKED. */
export const engagementStatusesFor = (channel: Channel): string[] =>
  (DELIVERY_STATUS_BY_CHANNEL[channel] ?? []).filter(isEngagement);

/**
 * Everything the preceding Send could report, including via its fallback.
 *
 * Re-exported rather than reimplemented so there is one answer to "may this
 * arm exist", and `blueprint.ts`, the gate and the audit all read it.
 */
export const statusVocabularyFor = (send: PrevStepSend): string[] => deliveryStatusOptionsForSend(send);

/** Engagement statuses only, out of whatever that Send could report. */
export const engagementVocabularyFor = (send: PrevStepSend): string[] =>
  statusVocabularyFor(send).filter(isEngagement);

/**
 * How the engagement statuses read in a sentence to a campaign manager.
 *
 * Used by the gate to check that a plan's own prose names two of them, and by
 * the prompt to say what WhatsApp actually reports. DELIVERED is the
 * interesting one: on its own it means delivered AND NOT read — the message
 * is sitting unopened — which is a different person from the one who read it.
 */
export const ENGAGEMENT_IN_WORDS: Record<string, string> = {
  DELIVERED: 'delivered but not yet read',
  READ: 'read and no action taken',
  DELETED: 'dismissed without reading',
  OPENED: 'opened',
  CLICKED: 'clicked but did not convert',
};
