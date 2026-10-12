// Shared by Condition's "Transaction history" source and, indirectly, by
// Entry · Audience's entity blocks (NodeForms.tsx's EntityConditionBlock
// renders TxnLookbackFields directly whenever a block's entity is
// 'Transaction') — one lookback/existence component, so neither drifts.
import { ConditionRows } from './ConditionRows';
import type { DripTxnHistoryCriteria } from '../data/graphTypes';

export function TxnLookbackFields({
  lookbackDuration,
  lookbackUnit,
  existence,
  onChange,
}: {
  lookbackDuration: number;
  lookbackUnit: 'days' | 'hours';
  existence: 'exists' | 'none';
  onChange: (patch: { lookbackDuration?: number; lookbackUnit?: 'days' | 'hours'; existence?: 'exists' | 'none' }) => void;
}) {
  return (
    <>
      <div className="f-row2">
        <div className="f-group">
          <label className="f-label">Lookback</label>
          <input className="f-input" type="number" min={1} value={lookbackDuration} onChange={(e) => onChange({ lookbackDuration: Number(e.target.value) })} />
        </div>
        <div className="f-group">
          <label className="f-label">Unit</label>
          <select className="f-input" value={lookbackUnit} onChange={(e) => onChange({ lookbackUnit: e.target.value as 'days' | 'hours' })}>
            <option>days</option>
            <option>hours</option>
          </select>
        </div>
      </div>
      <div className="f-group" style={{ marginBottom: 0 }}>
        <label className="f-label">Match</label>
        <select className="f-input" value={existence} onChange={(e) => onChange({ existence: e.target.value as 'exists' | 'none' })}>
          <option value="exists">At least one matching transaction exists</option>
          <option value="none">No matching transaction exists</option>
        </select>
      </div>
    </>
  );
}

export function TxnHistoryFields({ value, onChange }: { value: DripTxnHistoryCriteria; onChange: (next: DripTxnHistoryCriteria) => void }) {
  return (
    <>
      <div className="f-group">
        <label className="f-label">
          Transaction filters <span style={{ fontWeight: 400, color: 'var(--gray-500)' }}>(optional)</span>
        </label>
        <ConditionRows conditions={value.filters} entity="Transaction" onChange={(filters) => onChange({ ...value, filters })} />
      </div>
      <TxnLookbackFields
        lookbackDuration={value.lookbackDuration}
        lookbackUnit={value.lookbackUnit}
        existence={value.existence}
        onChange={(patch) => onChange({ ...value, ...patch })}
      />
    </>
  );
}
