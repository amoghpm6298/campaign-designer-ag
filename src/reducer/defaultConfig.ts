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
    ENTRY_SEGMENT: { cohortDesc: 'All eligible customers', entity: 'Customer', conditions: [] },
    ENTRY_EVENT: { eventCategory: Object.keys(EVENT_CATEGORIES)[0], eventType: '', conditions: [] },
    ENTRY_SCHEDULED: { recurrenceType: 'Monthly', dayOfMonth: '1', weekInterval: '1', dayOfWeek: 'Monday', dayInterval: '1', timeOfDay: '09:00', entity: 'Customer', conditions: [] },
    SEND: { name: 'Send Message', channel: 'WHATSAPP', account: '', templateId: '', timing: 'Absolute', absTime: '11:00', relativeAnchor: 'Previous Step', relativeDuration: 1, relativeUnit: 'days' },
    CHANNEL_FAILOVER: { primaryChannel: 'WHATSAPP', fallbackChannel: 'SMS', account: '', templateId: '' },
    PAUSE: { duration: 2, unit: 'days' },
    WAIT_UNTIL: { eventCategory: Object.keys(EVENT_CATEGORIES)[0], eventType: '', duration: 7, unit: 'days', conditions: [] },
    SPLIT: { basis: 'Goal reached', customSource: 'Previous step outcome', outcome: 'Clicked', customConditions: [] },
    DECISION_SPLIT: {
      name: 'Decision', source: 'Account attribute', attribute: '', outcome: 'Clicked',
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
    GOAL_EXIT: { reason: dcGoalLabel(goal) || 'Goal achieved' },
    EXIT: { reason: 'Sequence exhausted' },
  };
  return map[type];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dcAddFormValid(t: DcNodeType, p: any): boolean {
  if (t === 'ENTRY_EVENT' || t === 'WAIT_UNTIL') return !!p.eventType;
  if (t === 'SEND') return !!(p.account && p.templateId);
  if (t === 'RANDOM_SPLIT') return p.branches.reduce((s: number, b: { pct: number }) => s + Number(b.pct || 0), 0) === 100;
  if (t === 'CHANNEL_FAILOVER') return !!(p.primaryChannel && p.fallbackChannel && p.primaryChannel !== p.fallbackChannel && p.account && p.templateId);
  if (t === 'DECISION_SPLIT') {
    if (p.source !== 'Previous step outcome' && !p.attribute) return false;
    return p.branches.length > 0 && p.branches.every((b: { value: string; operator: string; value2: string }) => b.value !== '' && b.value != null && (b.operator !== 'Between' || (b.value2 !== '' && b.value2 != null)));
  }
  return true;
}
