// Ported from journeysnudgesemi/emi-conversions-prototype.html
// (dcCondSummary, dcDecisionBranchSummary, dcGoalLabel, dcOrdinal,
// dcRecurrenceLabel, dcRecomputeLabelMeta).
import type { DripGoal, DripGoalCondition } from '../data/graphTypes';
import type { DcNodeType } from '../data/nodeMeta';

// Short readable summary of a condition array for a node's meta line —
// "Amount = 2000, MCC = 5411" rather than making a reviewer open the
// drawer again to see what was actually configured. Handles both a plain
// scalar .value and a .values array (multiSelect) — without the latter, a
// Split whose only condition is a multiSelect attribute would silently
// summarize to an empty string, since .value is never set on those rows.
export function dcCondSummary(conditions: DripGoalCondition[] | undefined): string {
  return (conditions || [])
    .filter((c) => c.attribute && ((c.values && c.values.length) || c.value))
    .map((c) => {
      if (c.values && c.values.length) return `${c.attribute} any of ${c.values.join('/')}`;
      if (c.operator === 'Between') return `${c.attribute} between ${c.value} and ${c.value2 || '?'}`;
      return `${c.attribute} ${c.operator === 'Not Equals' ? '≠' : c.operator === 'Equals' ? '=' : c.operator || '='} ${c.value}`;
    })
    .join(', ');
}

export interface DecisionBranch {
  id?: string;
  label: string;
  operator: string;
  value?: string;
  value2?: string;
}
export interface DecisionSplitConfig {
  source: string;
  branches: DecisionBranch[];
}
// Short readable summary of one Decision Split branch's own condition —
// used both for its edge's branchLabel on the canvas and the node's own
// meta line. "Previous step outcome" branches have no operator concept
// (always an exact status match), everything else mirrors dcCondSummary's
// operator formatting.
export function dcDecisionBranchSummary(p: DecisionSplitConfig, b: DecisionBranch): string {
  if (p.source === 'Previous step outcome') return b.value || '(unset)';
  if (b.operator === 'Between') return `${b.value || '?'}–${b.value2 || '?'}`;
  if (b.operator === 'Greater than') return `> ${b.value || '?'}`;
  if (b.operator === 'Less than') return `< ${b.value || '?'}`;
  if (b.operator === 'Not Equals') return `≠ ${b.value || '?'}`;
  return b.value || '(unset)';
}

// Goal used to be a free-text string — no actual event behind it. Now
// {eventCategory, eventType} or null (a milestone campaign legitimately
// has no single shared goal — its checkpoints are independent).
export function dcGoalLabel(g: DripGoal | null | undefined): string | null {
  if (!g || !g.eventType) return null;
  const cond = dcCondSummary(g.conditions);
  return cond ? `${g.eventType} (${cond})` : g.eventType;
}

export function dcOrdinal(n: number | string): string {
  const num = Number(n);
  const s = ['th', 'st', 'nd', 'rd'];
  const v = num % 100;
  return num + (s[(v - 20) % 10] || s[v] || s[0]);
}

export interface ScheduledEntryConfig {
  recurrenceType: 'Monthly' | 'Weekly' | 'Daily';
  dayOfMonth: string;
  weekInterval: string;
  dayOfWeek: string;
  dayInterval: string;
  timeOfDay: string;
}
export function dcRecurrenceLabel(p: ScheduledEntryConfig): string {
  const base =
    p.recurrenceType === 'Weekly'
      ? `Every ${p.weekInterval} week${Number(p.weekInterval) === 1 ? '' : 's'} on ${p.dayOfWeek}`
      : p.recurrenceType === 'Daily'
        ? `Every ${p.dayInterval} day${Number(p.dayInterval) === 1 ? '' : 's'}`
        : `${p.dayOfMonth === 'last' ? 'Last day' : dcOrdinal(p.dayOfMonth)} of every month`;
  return p.timeOfDay ? `${base} at ${p.timeOfDay}` : base;
}

// Recomputes only label+meta for a node's config — never touches
// children/edges, unlike the add-node flow (which also builds
// auto-children for brand new nodes). Editing must never regenerate a
// subtree; whatever's already built under a node stays exactly as it was.
// `p` is intentionally loosely typed (Record<string, any>) — each node
// type's pendingConfig shape is its own thing, defined in defaultConfig.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dcRecomputeLabelMeta(type: DcNodeType, p: any, goal: DripGoal | null): { label: string; meta: string } {
  if (type === 'ENTRY_SEGMENT') {
    // Canvas-vs-drawer principle: the canvas is an execution map, not a
    // configuration database (node-design refinement pass) — entity and
    // eligibility conditions are real configuration detail, so they stay
    // in the drawer. Recurrence is the one P1 fact worth a glance (does
    // this re-fire on its own, or run once?); a non-repeating segment
    // gets no meta line at all rather than a sentence restating "this is
    // a static snapshot," which the absence of a recurrence line already
    // implies.
    return { label: p.cohortDesc, meta: p.repeat ? dcRecurrenceLabel(p) : '' };
  }
  if (type === 'ENTRY_EVENT') {
    // Conditions are configuration detail (P2, drawer-only) — only the
    // event category (P1) earns a glance on the canvas.
    return { label: p.eventType || 'Event Trigger', meta: p.eventCategory };
  }
  if (type === 'SEND') {
    // meta is deliberately unused for Send's own canvas rendering —
    // channel, template, timing, and fallback each get their own
    // dedicated row with its own icon, derived straight from _config at
    // render time (toFlowElements.ts), not flattened into one string
    // here (node-design refinement pass). Still returned as '' rather
    // than removed from this function's total Record, matching every
    // other node type's shape.
    return { label: p.name, meta: '' };
  }
  if (type === 'PAUSE') return { label: `Wait ${p.duration} ${p.unit}`, meta: '' };
  if (type === 'WAIT_UNTIL') {
    // Event category and conditions are P2/unclassified configuration
    // detail — only the timeout (P1) earns a canvas line alongside the
    // event type itself.
    return { label: p.eventType || 'Wait for Event', meta: `Timeout after ${p.duration} ${p.unit}` };
  }
  if (type === 'SPLIT') {
    // A Condition has no "Goal reached" basis anymore (Phase 1) — it's
    // always a user-defined question, never a stand-in for the one
    // campaign goal (that's GOAL_CHECK's job, a distinct node type that
    // carries no condition config of its own at all — see below).
    if (p.customSource === 'Previous step outcome') return { label: `Previous step: ${p.outcome}?`, meta: '' };
    if (p.customSource === 'Goal') return { label: (dcGoalLabel(goal) || 'Goal') + '?', meta: '' };
    const conds = (p.customConditions || []).filter((c: DripGoalCondition) => c.attribute);
    // One simple condition gets to be the label itself (a short, real
    // business question) — two or more collapse to a count-only meta
    // line instead (Phase 1 §9: counts, not joined expressions). This is
    // the direct fix for the literal bug a joined multi-condition string
    // produced on canvas ("Status = Active, Status ≠ Active?").
    if (conds.length === 0) return { label: 'Custom condition', meta: '' };
    if (conds.length === 1) return { label: (dcCondSummary(conds) || 'Custom condition') + '?', meta: '' };
    return { label: 'Custom condition', meta: `${conds.length} conditions` };
  }
  if (type === 'DECISION_SPLIT') {
    const label = p.source === 'Previous step outcome' ? 'Previous step outcome' : p.attribute || 'Branch';
    return { label, meta: `${p.branches.length} branch${p.branches.length === 1 ? '' : 'es'} + catch-all` };
  }
  if (type === 'RANDOM_SPLIT') {
    // Count always; the per-branch allocation only tags along when it's
    // short enough not to become the same "long expression on canvas"
    // problem Phase 1 §9 exists to prevent (a 2-way 50/50 test reads
    // fine inline, a 6-variant test would not).
    const allocation = p.branches.map((b: { label: string; pct: number }) => `${b.label} ${b.pct}%`).join(' / ');
    const countLabel = `${p.branches.length} variant${p.branches.length === 1 ? '' : 's'}`;
    return { label: p.name, meta: allocation.length <= 24 ? `${countLabel} — ${allocation}` : countLabel };
  }
  // GOAL_CHECK carries no `_config` at all (always null) — its label is
  // set directly at creation time in campaignReducer.ts, never recomputed
  // here, since it's never routed through an edit form. Included for
  // completeness/type-safety only; this branch should never actually run.
  if (type === 'GOAL_CHECK') return { label: (dcGoalLabel(goal) || 'Goal') + '?', meta: '' };
  if (type === 'GOAL_EXIT' || type === 'EXIT') return { label: p.reason, meta: '' };
  return { label: '', meta: '' };
}
