// Ported from journeysnudgesemi/emi-conversions-prototype.html.
import type { DcNodeType } from './nodeMeta';

export const DC_ENTRY_TYPES: DcNodeType[] = ['ENTRY_SEGMENT', 'ENTRY_EVENT', 'ENTRY_SCHEDULED'];

export const DC_TYPE_SUB: Record<DcNodeType, string> = {
  ENTRY_SEGMENT: 'Static or dynamic cohort',
  ENTRY_EVENT: 'Live event, incl. Transaction/EMI/Card Events',
  ENTRY_SCHEDULED: 'Calendar date or recurrence',
  SEND: 'Channel, template, timing',
  CHANNEL_FAILOVER: 'Sends via a fallback channel if primary delivery fails',
  PAUSE: 'Fixed wait duration',
  WAIT_UNTIL: 'Wait for an event, with a timeout',
  SPLIT: 'Two bounded sources only — prev. step outcome or entry-event attribute',
  DECISION_SPLIT: 'Branch by ranges or values of one attribute — first match wins, plus a catch-all',
  RANDOM_SPLIT: 'Creative A/B, % allocation',
  GOAL_EXIT: 'Objective achieved',
  EXIT: 'Sequence ran out, no goal met',
};
