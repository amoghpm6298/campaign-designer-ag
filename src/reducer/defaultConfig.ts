// Ported from journeysnudgesemi/emi-conversions-prototype.html's
// dcPickType (the default pendingConfig per node type) and dcAddFormValid.
import { EVENT_CATEGORIES } from '../data/sharedConstants';
import type { DripGoal } from '../data/graphTypes';
import type { DcNodeType } from '../data/nodeMeta';
import { dcGoalLabel } from './labelMeta';
import { dcNewBranchId } from './idGen';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dcDefaultConfig(type: DcNodeType, goal: DripGoal | null): any {
  const map: Record<DcNodeType, unknown> = {
    ENTRY_SEGMENT: {
      // No conditions by default, on purpose — Entity only has a visible
      // effect once a real condition exists to scope (see
      // EntrySegmentForm), so there's nothing for it to do yet either.
      cohortDesc: 'All eligible customers', entity: 'Customer', conditions: [],
      repeat: false, recurrenceType: 'Monthly', dayOfMonth: '1', weekInterval: '1', dayOfWeek: 'Monday', dayInterval: '1', timeOfDay: '09:00',
    },
    ENTRY_EVENT: { eventCategory: Object.keys(EVENT_CATEGORIES)[0], eventType: '', conditions: [] },
    // fallbackChannel '' means no fallback configured — a Send is a
    // single-channel message by default. account/templateId are the
    // primary channel's; fallbackAccount/fallbackTemplateId are a
    // separate pair for the fallback channel, since a template is
    // always locked to one channel and can't be shared across both.
    SEND: { name: 'Send Message', channel: 'WHATSAPP', account: '', templateId: '', timing: 'Absolute', absTime: '11:00', relativeAnchor: 'Previous Step', relativeDuration: 1, relativeUnit: 'days', fallbackChannel: '', fallbackAccount: '', fallbackTemplateId: '' },
    PAUSE: { duration: 2, unit: 'days' },
    WAIT_UNTIL: { eventCategory: Object.keys(EVENT_CATEGORIES)[0], eventType: '', duration: 7, unit: 'days', conditions: [] },
    // No `basis` field anymore — a Condition is always a user-defined
    // question now (Phase 1: "Goal reached" moved out entirely into the
    // separate GOAL_CHECK node type, which has no config of its own).
    SPLIT: { customSource: 'Previous step outcome', outcome: '', customConditions: [] },
    DECISION_SPLIT: {
      name: 'Decision', source: 'Account attribute', attribute: '', outcome: '',
      branches: [
        { id: dcNewBranchId(), label: 'Branch 1', operator: 'Equals', value: '', value2: '' },
        { id: dcNewBranchId(), label: 'Branch 2', operator: 'Equals', value: '', value2: '' },
      ],
    },
    RANDOM_SPLIT: {
      name: 'Channel test',
      branches: [
        { id: dcNewBranchId(), label: 'A', pct: 50 },
        { id: dcNewBranchId(), label: 'B', pct: 50 },
      ],
    },
    // Never actually rendered as an editable form (see NodeForms.tsx's
    // GoalCheckInfo) — exists only so dcDefaultConfig's Record is total
    // over DcNodeType, and so openEditNode has a type-correct fallback.
    GOAL_CHECK: null,
    GOAL_EXIT: { reason: dcGoalLabel(goal) || 'Goal achieved' },
    EXIT: { reason: 'Sequence exhausted' },
  };
  return map[type];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dcAddFormValid(t: DcNodeType, p: any): boolean {
  if (t === 'ENTRY_EVENT' || t === 'WAIT_UNTIL') return !!p.eventType;
  if (t === 'SEND') {
    if (!(p.account && p.templateId)) return false;
    if (!p.fallbackChannel) return true;
    return p.fallbackChannel !== p.channel && !!(p.fallbackAccount && p.fallbackTemplateId);
  }
  if (t === 'RANDOM_SPLIT') return p.branches.reduce((s: number, b: { pct: number }) => s + Number(b.pct || 0), 0) === 100;
  if (t === 'DECISION_SPLIT') {
    if (p.source !== 'Previous step outcome' && !p.attribute) return false;
    return p.branches.length > 0 && p.branches.every((b: { value: string; operator: string; value2: string }) => b.value !== '' && b.value != null && (b.operator !== 'Between' || (b.value2 !== '' && b.value2 != null)));
  }
  return true;
}
