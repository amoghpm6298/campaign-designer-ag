// Shared by Entry · Audience's entity = 'Milestone' block, Condition's
// "Milestone" source, and Branch's per-branch "Milestone" source — one
// component, three call sites, same discipline as TxnHistoryFields.tsx.
// Mirrors the real ironbank-face Promotional Nudge eligibility form
// (createEligibilityComponent.js): pick one benefit, pick one of the 8
// real operators, then either a Completed/Not Completed choice (for
// "Is") or a number input (plain, or a '%' one for the two _PCT
// operators), with Between getting two number inputs.
import { MILESTONE_BENEFITS, MILESTONE_OPERATORS } from '../data/sharedConstants';
import type { DripMilestoneCondition } from '../data/graphTypes';

export function MilestoneValueField({
  operator,
  value,
  value2,
  statusChoice,
  onPatch,
}: {
  operator: string;
  value?: string;
  value2?: string;
  statusChoice?: 'COMPLETED' | 'NOT_COMPLETED';
  onPatch: (patch: Partial<DripMilestoneCondition>) => void;
}) {
  if (operator === 'IS') {
    return (
      <select
        className="f-input"
        value={statusChoice || ''}
        onChange={(e) => {
          // Matches the real form exactly: picking either status also
          // writes value: "100" — the condition type stays 'IS', but a
          // value is always present, same as every other operator.
          const next = e.target.value as 'COMPLETED' | 'NOT_COMPLETED' | '';
          onPatch({ statusChoice: next || undefined, value: next ? '100' : '' });
        }}
      >
        <option value="">Select status</option>
        <option value="COMPLETED">Completed</option>
        <option value="NOT_COMPLETED">Not Completed</option>
      </select>
    );
  }
  if (operator === 'BETWEEN') {
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <input className="f-input" type="number" placeholder="From" value={value || ''} onChange={(e) => onPatch({ value: e.target.value })} />
        <input className="f-input" type="number" placeholder="To" value={value2 || ''} onChange={(e) => onPatch({ value2: e.target.value })} />
      </div>
    );
  }
  const isPct = operator === 'GTE_PCT' || operator === 'LTE_PCT';
  return <input className="f-input" type="number" placeholder={isPct ? 'Value (%)' : 'Value'} value={value || ''} onChange={(e) => onPatch({ value: e.target.value })} />;
}

export function MilestoneConditionFields({ value, onChange }: { value: DripMilestoneCondition; onChange: (next: DripMilestoneCondition) => void }) {
  return (
    <>
      <div className="f-group">
        <label className="f-label">Milestone benefit</label>
        <select className="f-input" value={value.benefitId} onChange={(e) => onChange({ ...value, benefitId: e.target.value })}>
          <option value="">Select benefit</option>
          {MILESTONE_BENEFITS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>
      <div className="f-group">
        <label className="f-label">Condition</label>
        <select className="f-input" value={value.operator} onChange={(e) => onChange({ ...value, operator: e.target.value, value: '', value2: '', statusChoice: undefined })}>
          {MILESTONE_OPERATORS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div className="f-group" style={{ marginBottom: 0 }}>
        <label className="f-label">Value</label>
        <MilestoneValueField
          operator={value.operator}
          value={value.value}
          value2={value.value2}
          statusChoice={value.statusChoice}
          onPatch={(patch) => onChange({ ...value, ...patch })}
        />
      </div>
    </>
  );
}
