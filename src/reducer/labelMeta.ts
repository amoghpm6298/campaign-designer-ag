// Ported from journeysnudgesemi/emi-conversions-prototype.html
// (dcCondSummary, dcDecisionBranchSummary, dcGoalLabel, dcOrdinal,
// dcRecurrenceLabel, dcRecomputeLabelMeta).
import { CHANNEL_CONFIG_LABELS, COMMS_TEMPLATES, type Channel } from '../data/sharedConstants';
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
    const condSummary = dcCondSummary(p.conditions);
    return { label: p.cohortDesc, meta: condSummary ? `${p.entity} · ${condSummary}` : `${p.entity} · no conditions — static snapshot` };
  }
  if (type === 'ENTRY_EVENT') {
    const condSummary = dcCondSummary(p.conditions);
    return { label: p.eventType || 'Event Trigger', meta: condSummary ? `${p.eventCategory} · ${condSummary}` : p.eventCategory };
  }
  if (type === 'ENTRY_SCHEDULED') {
    const condSummary = dcCondSummary(p.conditions);
    return { label: 'Scheduled entry', meta: `${dcRecurrenceLabel(p)} · ${p.entity}${condSummary ? ': ' + condSummary : ' (everyone matching)'}` };
  }
  if (type === 'SEND') {
    const tmpl = COMMS_TEMPLATES.find((x) => x.id === p.templateId);
    const timingLabel = p.timing === 'Absolute' ? p.absTime : `${p.relativeDuration} ${p.relativeUnit} after ${p.relativeAnchor}`;
    return { label: p.name, meta: `${CHANNEL_CONFIG_LABELS[p.channel as Channel]} · ${p.account} · ${timingLabel}${tmpl ? ' · Template: ' + tmpl.name : ''}` };
  }
  if (type === 'CHANNEL_FAILOVER') {
    const tmpl = COMMS_TEMPLATES.find((x) => x.id === p.templateId);
    return {
      label: `${CHANNEL_CONFIG_LABELS[p.primaryChannel as Channel]} → ${CHANNEL_CONFIG_LABELS[p.fallbackChannel as Channel]}`,
      meta: `${p.account || ''}${tmpl ? ' · Template: ' + tmpl.name : ''} · Retries on fallback if primary delivery fails`,
    };
  }
  if (type === 'PAUSE') return { label: `Wait ${p.duration} ${p.unit}`, meta: '' };
  if (type === 'WAIT_UNTIL') {
    const condSummary = dcCondSummary(p.conditions);
    return { label: p.eventType || 'Wait Until', meta: `Timeout after ${p.duration} ${p.unit} · ${p.eventCategory}${condSummary ? ' · ' + condSummary : ''}` };
  }
  if (type === 'SPLIT') {
    const goalQ = (dcGoalLabel(goal) || 'Goal') + '?';
    const question =
      p.basis === 'Goal reached'
        ? goalQ
        : p.customSource === 'Previous step outcome'
          ? `Previous step: ${p.outcome}?`
          : (dcCondSummary(p.customConditions) || 'Custom condition') + '?';
    return { label: question, meta: p.basis === 'Goal reached' ? 'Goal check' : 'Custom condition split' };
  }
  if (type === 'DECISION_SPLIT') {
    const label = p.source === 'Previous step outcome' ? 'Previous step outcome' : p.attribute || 'Decision Split';
    return { label, meta: `${p.branches.length} branch${p.branches.length === 1 ? '' : 'es'} + catch-all` };
  }
  if (type === 'RANDOM_SPLIT') {
    return { label: p.name, meta: p.branches.map((b: { label: string; pct: number }) => `${b.label} ${b.pct}%`).join(' / ') + ' allocation' };
  }
  if (type === 'GOAL_EXIT' || type === 'EXIT') return { label: p.reason, meta: '' };
  return { label: '', meta: '' };
}
