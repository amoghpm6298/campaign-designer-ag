// Ported from journeysnudgesemi/emi-conversions-prototype.html (2026-09-25).

export type DcNodeType =
  | 'ENTRY_SEGMENT' | 'ENTRY_EVENT' | 'ENTRY_SCHEDULED'
  | 'SEND' | 'CHANNEL_FAILOVER'
  | 'PAUSE' | 'WAIT_UNTIL'
  | 'SPLIT' | 'DECISION_SPLIT' | 'RANDOM_SPLIT'
  | 'GOAL_EXIT' | 'EXIT';

export type DcNodeCategory = 'entry' | 'send' | 'flow' | 'split' | 'goal' | 'exit';

export const DC_NODE_META: Record<DcNodeType, { cat: DcNodeCategory; type: string }> = {
  ENTRY_SEGMENT: { cat: 'entry', type: 'Entry · Segment' },
  ENTRY_EVENT: { cat: 'entry', type: 'Entry · Event Trigger' },
  ENTRY_SCHEDULED: { cat: 'entry', type: 'Entry · Scheduled' },
  SEND: { cat: 'send', type: 'Send' },
  CHANNEL_FAILOVER: { cat: 'send', type: 'Channel Failover' },
  PAUSE: { cat: 'flow', type: 'Pause' },
  WAIT_UNTIL: { cat: 'flow', type: 'Wait Until' },
  SPLIT: { cat: 'split', type: 'Conditional Split' },
  DECISION_SPLIT: { cat: 'split', type: 'Decision Split' },
  RANDOM_SPLIT: { cat: 'split', type: 'Random Split' },
  GOAL_EXIT: { cat: 'goal', type: 'Goal-Based Exit' },
  EXIT: { cat: 'exit', type: 'Exit' },
};

// The add-step type picker's grouping — direct convergent finding from
// researching Adobe Campaign / MoEngage's own equivalent pickers, both of
// which group by semantic category rather than one flat list. "Reuse"
// (Connect to an Existing Step) is a UI affordance, not a real node type,
// so it isn't listed here.
export const DC_TYPE_CATEGORIES: { label: string; types: DcNodeType[] }[] = [
  { label: 'Actions', types: ['SEND', 'CHANNEL_FAILOVER'] },
  { label: 'Waits', types: ['PAUSE', 'WAIT_UNTIL'] },
  { label: 'Logic', types: ['SPLIT', 'DECISION_SPLIT', 'RANDOM_SPLIT', 'GOAL_EXIT', 'EXIT'] },
];

export const DC_STEP_TYPES: DcNodeType[] = ['SEND', 'CHANNEL_FAILOVER', 'PAUSE', 'WAIT_UNTIL', 'SPLIT', 'DECISION_SPLIT', 'RANDOM_SPLIT', 'GOAL_EXIT', 'EXIT'];
