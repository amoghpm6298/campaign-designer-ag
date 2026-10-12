// Ported from journeysnudgesemi/emi-conversions-prototype.html
// (dcCondSummary, dcDecisionBranchSummary, dcGoalLabel, dcOrdinal,
// dcRecurrenceLabel, dcRecomputeLabelMeta).
import type { DripGoal, DripGoalCondition, DripMilestoneCondition, DripTxnHistoryCriteria } from '../data/graphTypes';
import type { DcNodeType } from '../data/nodeMeta';
import { milestoneBenefitName } from '../data/sharedConstants';

// Short operator symbols for Milestone summaries — same convention as
// dcCondSummary's '>' / '<' / '≠'. Only the two _PCT operators get a '%'
// suffix; 'BETWEEN' and 'IS' are handled as their own cases below.
const MILESTONE_OP_SYMBOL: Record<string, string> = { GT: '>', GTE: '≥', LT: '<', LTE: '≤', GTE_PCT: '≥', LTE_PCT: '≤' };

// Readable canvas summary for a Milestone condition — same collapse
// discipline as dcTxnHistorySummary: a real business question, not a
// dump of the raw operator/value shape.
export function dcMilestoneSummary(m: DripMilestoneCondition | undefined): string {
  if (!m || !m.benefitId) return 'Milestone';
  const name = milestoneBenefitName(m.benefitId);
  if (m.operator === 'IS') return `${name} — ${m.statusChoice === 'NOT_COMPLETED' ? 'Not Completed' : 'Completed'}`;
  if (m.operator === 'BETWEEN') return `${name} between ${m.value || '?'} and ${m.value2 || '?'}`;
  const pct = m.operator === 'GTE_PCT' || m.operator === 'LTE_PCT' ? '%' : '';
  return `${name} ${MILESTONE_OP_SYMBOL[m.operator] || m.operator} ${m.value || '?'}${pct}`;
}

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

// Readable canvas summary for a transaction-history condition — same
// collapse convention as dcCondSummary: 0 or 1 filters stay readable,
// 2+ collapse to a count so the card never grows to fit raw filter
// expressions.
export function dcTxnHistorySummary(t: DripTxnHistoryCriteria | undefined): string {
  if (!t) return 'Transaction history';
  const verb = t.existence === 'none' ? 'No transaction' : 'A transaction';
  const filters = (t.filters || []).filter((c) => c.attribute);
  const filterText = filters.length === 1 ? ` (${dcCondSummary(filters)})` : filters.length > 1 ? ` matching ${filters.length} filters` : '';
  return `${verb}${filterText} in ${t.lookbackDuration ?? '?'} ${t.lookbackUnit ?? 'days'}`;
}

export interface DecisionBranch {
  id?: string;
  label: string;
  operator: string;
  value?: string;
  value2?: string;
  values?: string[];
  // Only meaningful when the parent Decision Split's source is
  // 'Milestone' and this branch's own operator is 'IS'.
  statusChoice?: 'COMPLETED' | 'NOT_COMPLETED';
}
export interface DecisionSplitConfig {
  source: string;
  attribute?: string;
  milestoneBenefitId?: string;
  branches: DecisionBranch[];
}

// "Previous step outcome" moved from a single exact-match value to a set
// (any selected status qualifies) — this derives the effective selection
// from either shape, so an old saved journey with only the singular
// value/outcome field still behaves exactly as it did (a set of one).
export function dcSelectedMulti(single: string | undefined, multi: string[] | undefined): string[] {
  if (multi && multi.length) return multi;
  return single ? [single] : [];
}

// Short readable summary of one Decision Split branch's own condition —
// used both for its edge's branchLabel on the canvas and the node's own
// meta line. "Previous step outcome" branches have no operator concept
// (always a status-set match), everything else mirrors dcCondSummary's
// operator formatting.
export function dcDecisionBranchSummary(p: DecisionSplitConfig, b: DecisionBranch): string {
  if (p.source === 'Previous step outcome') {
    const sel = dcSelectedMulti(b.value, b.values);
    return sel.length === 0 ? '(unset)' : sel.length === 1 ? sel[0] : `${sel.length} outcomes`;
  }
  if (p.source === 'Milestone') {
    if (b.operator === 'IS') return b.statusChoice === 'NOT_COMPLETED' ? 'Not Completed' : 'Completed';
    if (b.operator === 'BETWEEN') return `${b.value || '?'}–${b.value2 || '?'}`;
    const pct = b.operator === 'GTE_PCT' || b.operator === 'LTE_PCT' ? '%' : '';
    return `${MILESTONE_OP_SYMBOL[b.operator] || b.operator} ${b.value || '?'}${pct}`;
  }
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
    if (p.customSource === 'Previous step outcome') {
      const sel = dcSelectedMulti(p.outcome, p.outcomes);
      const text = sel.length === 0 ? '(unset)' : sel.length === 1 ? sel[0] : `${sel.length} outcomes`;
      return { label: `Previous step: ${text}?`, meta: '' };
    }
    if (p.customSource === 'Transaction history') return { label: dcTxnHistorySummary(p.txnHistory) + '?', meta: '' };
    if (p.customSource === 'Milestone') return { label: dcMilestoneSummary(p.milestone) + '?', meta: '' };
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
    const label =
      p.source === 'Previous step outcome'
        ? 'Previous step outcome'
        : p.source === 'Milestone'
          ? milestoneBenefitName(p.milestoneBenefitId) || 'Milestone'
          : p.attribute || 'Branch';
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
  // GOAL_CHECK carries no `_config` at all (always null) — nothing to
  // recompute FROM, so its question is derived live from the campaign's
  // current Goal every time. That's what makes editing the Goal update
  // every existing Goal Check's label for free, with no second copy of
  // the goal stored on any node.
  if (type === 'GOAL_CHECK') return { label: (dcGoalLabel(goal) || 'Goal') + '?', meta: '' };
  if (type === 'GOAL_EXIT' || type === 'EXIT') return { label: p.reason, meta: '' };
  return { label: '', meta: '' };
}
