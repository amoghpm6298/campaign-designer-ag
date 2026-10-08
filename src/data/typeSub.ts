// Ported from journeysnudgesemi/emi-conversions-prototype.html.
import type { DcNodeType } from './nodeMeta';

export const DC_ENTRY_TYPES: DcNodeType[] = ['ENTRY_SEGMENT', 'ENTRY_EVENT'];

export const DC_TYPE_SUB: Record<DcNodeType, string> = {
  ENTRY_SEGMENT: 'Cohort snapshot — once or on a repeating schedule',
  ENTRY_EVENT: 'Start when an event occurs',
  SEND: 'Send a message through a selected channel',
  PAUSE: 'Wait for a fixed duration',
  WAIT_UNTIL: 'Wait until an event occurs',
  SPLIT: 'Check whether conditions are true',
  DECISION_SPLIT: 'Split customers by an attribute',
  RANDOM_SPLIT: 'Split traffic between variants',
  // Never shown in the Add Step picker — GOAL_CHECK is excluded from
  // every `types` list passed to TypePicker — but DC_TYPE_SUB is a
  // Record over the full DcNodeType union, so it still needs a value.
  GOAL_CHECK: 'Has the campaign goal been achieved? (system-generated, not addable)',
  GOAL_EXIT: 'Mark the goal as achieved',
  EXIT: 'End the journey',
};
