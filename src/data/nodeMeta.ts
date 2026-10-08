// Ported from journeysnudgesemi/emi-conversions-prototype.html (2026-09-25).

export type DcNodeType =
  // Segment also covers what used to be a separate "Scheduled" entry —
  // a one-time snapshot and a recurring re-check both ask the same "who
  // qualifies" question (entity + conditions); the only real difference
  // is a repeat cadence on top, now just a toggle inside this one form
  // instead of a whole separate node type.
  | 'ENTRY_SEGMENT' | 'ENTRY_EVENT'
  // Channel Failover used to be its own chained node type; folded into
  // SEND itself as an optional fallback channel (same send, not a
  // separate step) — see dripCanvas.css's .dc-node-fallback-icon for how
  // it still surfaces on canvas.
  | 'SEND'
  | 'PAUSE' | 'WAIT_UNTIL'
  | 'SPLIT' | 'DECISION_SPLIT' | 'RANDOM_SPLIT'
  // First-class, real node type (Phase 1 IA, approved) — not a SPLIT with
  // a `_config.basis === 'Goal reached'` flag. Always system-generated,
  // never offered in the Add Step picker (see DC_STEP_TYPES below), zero
  // local configuration. See campaignReducer.ts for where it's inserted.
  | 'GOAL_CHECK'
  | 'GOAL_EXIT' | 'EXIT';

// One category per distinct visual/semantic treatment (Phase 2 §10):
// Experiment gets its own (allocation-by-chance is a different mental
// model from allocation-by-truth — conflating them was a named
// confusion), Goal Check gets its own (system evaluation, never a user
// action), Goal Reached stays separate from a plain Exit (achieved vs.
// just ran out).
export type DcNodeCategory = 'entry' | 'send' | 'flow' | 'split' | 'experiment' | 'goalcheck' | 'goal' | 'exit';

// One compact icon per category (Phase 2 §10: avoid icon overload — a
// node's icon always follows from its category, never a one-off per
// node type) and a fixed size class (Phase 2 §6 hard rule: height comes
// from type/size-class, never from configuration complexity).
export const DC_CATEGORY_ICON: Record<DcNodeCategory, string> = {
  entry: 'flag',
  send: 'paperplane',
  flow: 'clock',
  split: 'fork',
  experiment: 'flask',
  goalcheck: 'targetCheck',
  goal: 'award',
  exit: 'doorExit',
};

export type DcNodeSize = 'compact' | 'standard';

export const DC_NODE_META: Record<DcNodeType, { cat: DcNodeCategory; type: string; size: DcNodeSize }> = {
  ENTRY_SEGMENT: { cat: 'entry', type: 'Entry · Audience', size: 'standard' },
  ENTRY_EVENT: { cat: 'entry', type: 'Entry · Event', size: 'standard' },
  SEND: { cat: 'send', type: 'Send', size: 'standard' },
  PAUSE: { cat: 'flow', type: 'Wait', size: 'compact' },
  WAIT_UNTIL: { cat: 'flow', type: 'Wait for Event', size: 'standard' },
  SPLIT: { cat: 'split', type: 'Condition', size: 'standard' },
  DECISION_SPLIT: { cat: 'split', type: 'Branch', size: 'standard' },
  RANDOM_SPLIT: { cat: 'experiment', type: 'Experiment', size: 'standard' },
  GOAL_CHECK: { cat: 'goalcheck', type: 'Goal Check', size: 'compact' },
  GOAL_EXIT: { cat: 'goal', type: 'Goal Reached', size: 'compact' },
  EXIT: { cat: 'exit', type: 'Exit', size: 'compact' },
};

// The add-step type picker's grouping — the user-facing taxonomy (Phase 1,
// §10A), task-oriented rather than backend-shaped: what the user is trying
// to do, not what kind of graph node it is internally. GOAL_CHECK never
// appears here, in any group, in any context — it's 100% system-generated
// (see § Goal Check in campaignReducer.ts). GOAL_EXIT ("Goal Reached")
// appears here but is only ever enabled when the add is happening inside
// an already-forked branch arm — see TypePicker.tsx's disabledTypes.
export const DC_TYPE_CATEGORIES: { label: string; types: DcNodeType[] }[] = [
  { label: 'Actions', types: ['SEND'] },
  { label: 'Wait', types: ['PAUSE', 'WAIT_UNTIL'] },
  { label: 'Decisions', types: ['SPLIT', 'DECISION_SPLIT'] },
  { label: 'Experiment', types: ['RANDOM_SPLIT'] },
  { label: 'End the Journey', types: ['EXIT', 'GOAL_EXIT'] },
];

export const DC_STEP_TYPES: DcNodeType[] = ['SEND', 'PAUSE', 'WAIT_UNTIL', 'SPLIT', 'DECISION_SPLIT', 'RANDOM_SPLIT', 'GOAL_EXIT', 'EXIT'];
