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
  // a `_config.basis === 'Goal reached'` flag. Zero local configuration:
  // its question is always derived live from the campaign Goal. Inserted
  // automatically after every Send/Wait when a Goal exists, AND addable
  // by hand from the picker for the places auto-insertion doesn't reach
  // (after a Wait for Event, or on a Branch/Experiment/Condition arm).
  // Both routes build the identical node — see campaignReducer.ts.
  | 'GOAL_CHECK'
  | 'GOAL_EXIT' | 'EXIT';

// One category per distinct visual/semantic treatment (Phase 2 §10):
// Experiment gets its own (allocation-by-chance is a different mental
// model from allocation-by-truth — conflating them was a named
// confusion), Goal Check gets its own (system evaluation, never a user
// action), Goal Reached stays separate from a plain Exit (achieved vs.
// just ran out).
export type DcNodeCategory = 'entry' | 'send' | 'flow' | 'split' | 'experiment' | 'goalcheck' | 'goal' | 'exit';

// One icon per NODE TYPE. This used to be one per category, on the
// reasoning that per-type icons would be icon overload (Phase 2 §10) —
// but that left the two types inside a category visually identical:
// Wait and Wait for Event both a clock, Condition and Branch both the
// same fork. In a picker that lists them as adjacent rows, the glyph was
// carrying no information at all, which is the opposite of restraint.
//
// Colour still comes from the category (`.icon-box.{cat}` in the CSS),
// so a section still reads as one family at a glance — only the glyph
// differentiates within it. Send is unchanged in spirit: it already
// overrode its category icon with a per-channel one, so a more specific
// glyph where it's more informative was always the real rule.
export const DC_NODE_ICON: Record<DcNodeType, string> = {
  // A named group of people vs. something firing — two genuinely
  // different ideas that both used to be a flag.
  ENTRY_SEGMENT: 'users',
  ENTRY_EVENT: 'flag',
  SEND: 'paperplane',
  // Time passing vs. the thing being awaited.
  PAUSE: 'clock',
  WAIT_UNTIL: 'bolt',
  // Both forks; the glyph's output-dot count is the real difference.
  SPLIT: 'split2',
  DECISION_SPLIT: 'split3',
  RANDOM_SPLIT: 'flask',
  GOAL_CHECK: 'targetCheck',
  GOAL_EXIT: 'award',
  EXIT: 'doorExit',
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
// to do, not what kind of graph node it is internally.
//
// GOAL_CHECK sits under Decisions because that's what it does — it forks
// Yes/No, exactly like Condition and Branch. It used to be absent here
// entirely (system-generated only), with Condition carrying a "Goal"
// source as the manual equivalent. That was one question with two node
// types and, worse, two behaviours: the auto one wired Yes straight to
// Goal Reached, the Condition one left both arms open. The Goal source
// is gone; this is now the single way to ask it, auto-inserted or added
// by hand. Only ever enabled when a campaign Goal actually exists —
// see DripBuilder's disabledTypes. GOAL_EXIT ("Goal Reached") is
// similarly gated, to an already-forked branch arm.
export const DC_TYPE_CATEGORIES: { label: string; types: DcNodeType[] }[] = [
  { label: 'Actions', types: ['SEND'] },
  { label: 'Wait', types: ['PAUSE', 'WAIT_UNTIL'] },
  { label: 'Decisions', types: ['SPLIT', 'DECISION_SPLIT', 'GOAL_CHECK'] },
  { label: 'Experiment', types: ['RANDOM_SPLIT'] },
  { label: 'End the Journey', types: ['EXIT', 'GOAL_EXIT'] },
];

export const DC_STEP_TYPES: DcNodeType[] = ['SEND', 'PAUSE', 'WAIT_UNTIL', 'SPLIT', 'DECISION_SPLIT', 'GOAL_CHECK', 'RANDOM_SPLIT', 'GOAL_EXIT', 'EXIT'];

// Routing vs. fan-out — the single distinction behind parallel paths.
//
// A ROUTING node sends each customer down exactly ONE of its outgoing
// paths: Yes or No (Condition, Goal Check, Wait for Event), one branch of
// N (Branch), one variant by chance (Experiment). Its outgoing edges are
// mutually exclusive, and their labels are owned by that node's own
// config (`branches[]`) or fixed by the reducer ('Yes'/'No').
//
// A FAN-OUT node sends EVERY customer down EVERY outgoing path at once —
// genuinely parallel, not a choice. The canonical case is several
// independent time-based checkpoints hanging off one anchor (Spend
// Milestone's Month 1/3/6/12 checks off a single Card Activated entry);
// anniversary programmes and multi-stage onboarding checkpoints share the
// shape. Its edges' labels have no other owner, so they're named inline on
// the canvas instead.
//
// Deliberately derived from node type, not stored as a per-edge flag:
// one rule, read in three places that must never disagree — whether the
// canvas offers "+ Parallel path", whether an edge's label is inline-
// editable, and whether analytics divides a node's incoming count across
// its children or gives each child the full count. A stored flag could
// drift out of sync with the node's actual type; a derived rule cannot.
export const DC_ROUTING_TYPES: DcNodeType[] = ['SPLIT', 'DECISION_SPLIT', 'RANDOM_SPLIT', 'GOAL_CHECK', 'WAIT_UNTIL'];
export const DC_TERMINAL_TYPES: DcNodeType[] = ['GOAL_EXIT', 'EXIT'];

export function dcIsRoutingNode(type: DcNodeType): boolean {
  return DC_ROUTING_TYPES.includes(type);
}

// Can this node type hold several genuinely parallel outgoing paths?
// Everything that isn't a router (its paths are exclusive by definition)
// and isn't terminal (no outgoing paths at all).
export function dcCanFanOut(type: DcNodeType): boolean {
  return !DC_ROUTING_TYPES.includes(type) && !DC_TERMINAL_TYPES.includes(type);
}
