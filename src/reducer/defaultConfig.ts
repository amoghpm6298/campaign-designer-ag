// Ported from journeysnudgesemi/emi-conversions-prototype.html's
// dcPickType (the default pendingConfig per node type) and dcAddFormValid.
import { EVENT_CATEGORIES } from '../data/sharedConstants';
import type { DripGoal, DripGraph, DripMilestoneCondition, DripTxnHistoryCriteria } from '../data/graphTypes';
import type { DcNodeType } from '../data/nodeMeta';
import type { DcAddingAt } from './campaignReducer';
import { dcGoalLabel } from './labelMeta';
import { dcNewBranchId } from './idGen';

// Shared default for Condition's "Transaction history" source and Entry ·
// Audience's own optional block — same starting shape for both, so neither
// entry point drifts from the other. 90 days / "at least one" is a
// reasonable starting point, not a prescribed dormancy threshold — fully
// editable, and the lookback window must stay issuer-configurable.
export function dcDefaultTxnHistory(): DripTxnHistoryCriteria {
  return { filters: [], lookbackDuration: 90, lookbackUnit: 'days', existence: 'exists' };
}

// Shared by Entry · Audience (entity = 'Milestone'), Condition
// (customSource = 'Milestone'), and Branch (source = 'Milestone') — same
// starting shape everywhere, same reasoning as dcDefaultTxnHistory above.
// Defaults to "Is Completed", the single most natural starting question
// for a milestone check, matching the real form's own default behavior
// of writing value: "100" the moment a status is picked.
export function dcDefaultMilestone(): DripMilestoneCondition {
  return { benefitId: '', operator: 'IS', statusChoice: 'COMPLETED', value: '100' };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dcDefaultConfig(type: DcNodeType, goal: DripGoal | null): any {
  const map: Record<DcNodeType, unknown> = {
    ENTRY_SEGMENT: {
      // No conditions by default, on purpose — Entity only has a visible
      // effect once a real condition exists to scope (see
      // EntrySegmentForm), so there's nothing for it to do yet either.
      cohortDesc: 'All eligible customers', entity: 'Customer', conditions: [],
      repeat: false, recurrenceType: 'Monthly', dayOfMonth: '1', weekInterval: '1', dayOfWeek: 'Monday', dayInterval: '1', timeOfDay: '09:00',
      // Only meaningful once entity = 'Transaction' (see EntityConditionBlock
      // in NodeForms.tsx) — pre-defaulted anyway, same convention as the
      // recurrence fields above, which are pre-defaulted despite being
      // hidden until repeat is true.
      lookbackDuration: 90, lookbackUnit: 'days', existence: 'exists',
      // Additional entity-scoped filter blocks, all AND'd with the
      // primary entity/conditions above and with each other (e.g. "Account
      // = Dormant AND Card = Active", or two Transaction blocks each with
      // their own filters/window/direction). Empty by default; existing
      // campaigns without this key behave exactly as before.
      extraEntityGroups: [],
    },
    // journey/batch/offerType/offerName: Journey/Offer Events' own
    // scoping, same optional-field pattern as everything else added this
    // session — blank by default, only ever meaningful for those two
    // categories (see EventScopingFields.tsx), absent on every campaign
    // saved before this existed.
    ENTRY_EVENT: { eventCategory: Object.keys(EVENT_CATEGORIES)[0], eventType: '', conditions: [], journey: '', batch: '', offerType: '', offerName: '' },
    // fallbackChannel '' means no fallback configured — a Send is a
    // single-channel message by default. account/templateId are the
    // primary channel's; fallbackAccount/fallbackTemplateId are a
    // separate pair for the fallback channel, since a template is
    // always locked to one channel and can't be shared across both.
    SEND: { name: 'Send Message', channel: 'WHATSAPP', account: '', templateId: '', timing: 'Absolute', absTime: '11:00', relativeAnchor: 'Previous Step', relativeDuration: 1, relativeUnit: 'days', fallbackChannel: '', fallbackAccount: '', fallbackTemplateId: '' },
    PAUSE: { duration: 2, unit: 'days' },
    WAIT_UNTIL: { eventCategory: Object.keys(EVENT_CATEGORIES)[0], eventType: '', duration: 7, unit: 'days', conditions: [], journey: '', batch: '', offerType: '', offerName: '' },
    // No `basis` field anymore — a Condition is always a user-defined
    // question now (Phase 1: "Goal reached" moved out entirely into the
    // separate GOAL_CHECK node type, which has no config of its own).
    // outcome (singular) kept only for back-compat with journeys saved
    // before multi-outcome matching — new picks always write `outcomes`.
    SPLIT: { customSource: 'Previous step outcome', outcome: '', outcomes: [], customConditions: [], txnHistory: dcDefaultTxnHistory() },
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

// Shared by SPLIT's "Milestone" source and ENTRY_SEGMENT's entity =
// 'Milestone' block. 'IS' is covered by the generic `!!m.value` check
// since picking a status writes value: "100" (see dcDefaultMilestone) —
// 'BETWEEN' is the only operator needing a second value.
function dcMilestoneConditionValid(m: DripMilestoneCondition | undefined): boolean {
  if (!m?.benefitId) return false;
  if (m.operator === 'BETWEEN') return !!(m.value && m.value2);
  return !!m.value;
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
    // Milestone's "pick one thing" field is milestoneBenefitId, not
    // attribute — same requirement, different key, since a benefit
    // identity isn't an entity attribute.
    if (p.source === 'Milestone') {
      if (!p.milestoneBenefitId) return false;
    } else if (p.source !== 'Previous step outcome' && !p.attribute) {
      return false;
    }
    // multiSelect branches store their pick in `values[]`, not `value` —
    // a branch is "filled in" if either representation is populated.
    // Milestone's 'IS' operator writes value: "100" the moment a status
    // is picked (see dcDefaultMilestone), so it's covered by the same
    // `b.value !== ''` check without a separate branch here. 'BETWEEN'
    // is spelled both ways across this app's two operator vocabularies
    // (generic 'Between' vs. Milestone's real 'BETWEEN') — checked for
    // both rather than normalizing one into the other.
    return (
      p.branches.length > 0 &&
      p.branches.every(
        (b: { value: string; operator: string; value2: string; values?: string[] }) =>
          ((b.value !== '' && b.value != null) || (b.values && b.values.length > 0)) &&
          ((b.operator !== 'Between' && b.operator !== 'BETWEEN') || (b.value2 !== '' && b.value2 != null))
      )
    );
  }
  // A Condition has to actually check something — otherwise Yes/No is
  // meaningless. Each source needs its own real input before it's valid.
  if (t === 'SPLIT') {
    if (p.customSource === 'Previous step outcome') return !!(p.outcomes && p.outcomes.length) || !!p.outcome;
    // Filters are optional (zero filters = "any transaction at all" is a
    // meaningful question on its own) — only the lookback window is
    // required, same as Pause's duration.
    if (p.customSource === 'Transaction history') return Number(p.txnHistory?.lookbackDuration) > 0;
    if (p.customSource === 'Milestone') return dcMilestoneConditionValid(p.milestone);
    return (p.customConditions || []).some((c: { attribute: string }) => c.attribute);
  }
  // Entry · Audience: a lookback window is only required of a block
  // whose entity is 'Transaction', and a complete milestone condition is
  // only required of a block whose entity is 'Milestone' — same rule
  // Condition's own Transaction history / Milestone sources use, just
  // applied per-block instead of once, since the primary block and every
  // extra group can independently be either. Every other entity needs no
  // such check.
  if (t === 'ENTRY_SEGMENT') {
    const groups = [{ entity: p.entity, lookbackDuration: p.lookbackDuration, milestone: p.milestone }, ...(p.extraEntityGroups || [])];
    return groups.every((g: { entity: string; lookbackDuration?: number; milestone?: DripMilestoneCondition }) => {
      if (g.entity === 'Transaction') return Number(g.lookbackDuration) > 0;
      if (g.entity === 'Milestone') return dcMilestoneConditionValid(g.milestone);
      return true;
    });
  }
  return true;
}

// Exit's reason has no smart default today, unlike Goal Reached (which
// auto-fills from the campaign Goal's own label) — it's always the same
// generic 'Sequence exhausted' regardless of context. Derives a real
// starting reason from whichever branch this Exit is being added on
// (e.g. a Condition's "New Status = Failed" Yes arm, or a Branch's
// "Failed" arm), so the canvas shows why instead of a placeholder. Still
// freely editable afterward — this only sets the initial value.
export function dcDefaultExitReason(graph: DripGraph, addingAt: DcAddingAt | null): string {
  const fallback = 'Sequence exhausted';
  if (!addingAt || addingAt.kind !== 'edge') return fallback;
  const edge = graph.edges.find((e) => e.id === addingAt.edgeId);
  if (!edge || !edge.branchLabel) return fallback;
  const src = graph.nodes[edge.from];
  if (!src) return fallback;
  const baseLabel = src.label.replace(/\?$/, '');
  return `${baseLabel} — ${edge.branchLabel}`;
}
