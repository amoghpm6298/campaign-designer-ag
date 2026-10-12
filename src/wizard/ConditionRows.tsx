// Ported from journeysnudgesemi/emi-conversions-prototype.html's
// dcConditionsSectionHtml / dcPromotedFieldHtml / dcCondRowsHtml /
// dcCondUpdate / dcCondToggleMulti — React-idiomatic version: takes the
// conditions array + an onChange callback instead of a global containerKey
// lookup (dcCondArrayFor), since each caller now owns its own local state.
import { ELIGIBILITY_META, DC_PROMOTED_ATTR, LOCKED_ATTR_OPERATORS, type AttrType } from '../data/sharedConstants';
import type { DripGoalCondition } from '../data/graphTypes';
import { MultiSelectDropdown } from '../components/MultiSelectDropdown';

type Cond = DripGoalCondition;

function updateAt(conditions: Cond[], idx: number, patch: Partial<Cond>): Cond[] {
  return conditions.map((c, i) => (i === idx ? { ...c, ...patch } : c));
}

// Entry point every condition-row call site should use — some entities
// have one attribute that IS the point of picking that event type at all
// (New Status for EMI_STATUS_CHANGED), promoted to always-visible instead
// of buried behind "Add condition."
export function ConditionsSection({
  conditions,
  entity,
  lockedAttribute,
  onChange,
  label = 'Conditions',
}: {
  conditions: Cond[];
  entity: string | null;
  // Journey/Offer Events' one locked attribute (see
  // resolveEntryEventAttrSource / EVENT_ATTR_BY_TYPE) — passed instead of
  // an entity when the event category has no typed attribute set of its
  // own, just one fixed attribute per event type.
  lockedAttribute?: string | null;
  onChange: (next: Cond[]) => void;
  label?: string;
}) {
  if (entity && DC_PROMOTED_ATTR[entity]) {
    return <PromotedField conditions={conditions} entity={entity} attribute={DC_PROMOTED_ATTR[entity]} onChange={onChange} />;
  }
  // No typed entity and no locked attribute (Card Events, or no
  // eventType picked yet) — nothing to render. Transaction/EMI Events
  // always resolve a real entity; Journey/Offer Events resolve a locked
  // attribute once their eventType is known — this is never a silent gap
  // for any of those three, only an honest "there's nothing here" for
  // Card Events, which has neither in the source this was ported from
  // either (see CLAUDE.md).
  if (!entity && !lockedAttribute) return null;
  return (
    <div className="f-group">
      <label className="f-label">
        {label} <span style={{ fontWeight: 400, color: 'var(--gray-500)' }}>(optional)</span>
      </label>
      <ConditionRows conditions={conditions} entity={entity} lockedAttribute={lockedAttribute} onChange={onChange} />
    </div>
  );
}

function PromotedField({ conditions, entity, attribute, onChange }: { conditions: Cond[]; entity: string; attribute: string; onChange: (next: Cond[]) => void }) {
  let idx = conditions.findIndex((c) => c.attribute === attribute);
  let list = conditions;
  if (idx === -1) {
    list = [...conditions, { attribute, operator: 'Equals', value: '' }];
    idx = list.length - 1;
  }
  const meta = ELIGIBILITY_META[entity][attribute];
  const val = list[idx].value || '';
  return (
    <div className="f-group">
      <label className="f-label">Status</label>
      <select
        className="f-input"
        value={val}
        onChange={(e) => {
          onChange(updateAt(list, idx, { value: e.target.value }));
        }}
      >
        <option value="">Any status</option>
        {(meta.options || []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}

export function ConditionRows({
  conditions,
  entity,
  lockedAttribute,
  onChange,
}: {
  conditions: Cond[];
  entity: string | null;
  lockedAttribute?: string | null;
  onChange: (next: Cond[]) => void;
}) {
  const meta = entity ? ELIGIBILITY_META[entity] : null;
  const attrOptions = meta ? Object.keys(meta) : null;

  // Every row's attribute is forced to the current locked value on every
  // edit — same "re-sync on every write" fix as the original prototype's
  // own `d.triggerConditions[0].attribute = lockedAttr` force-overwrite,
  // just done through the normal onChange flow instead of a render-time
  // side effect. This is what keeps a row correct if eventType changes
  // (e.g. Pageload → Button Click) after rows already exist — the
  // attribute cell always displays `lockedAttribute` directly regardless
  // of what's stored, and the stored value gets quietly corrected the
  // next time any field on that row changes.
  const setRow = (idx: number, patch: Partial<Cond>) => onChange(updateAt(conditions, idx, lockedAttribute ? { ...patch, attribute: lockedAttribute } : patch));
  const removeRow = (idx: number) => onChange(conditions.filter((_, i) => i !== idx));
  const addRow = () => onChange([...conditions, { attribute: lockedAttribute || '', operator: '', value: '' }]);
  const toggleMulti = (idx: number, val: string) => {
    const c = conditions[idx];
    const values = c.values ? [...c.values] : [];
    const i = values.indexOf(val);
    if (i > -1) values.splice(i, 1);
    else values.push(val);
    // Persist the operator too, not just display it — multiSelect only
    // ever has one real operator, same auto-fill the original applied
    // directly to the live condition object.
    onChange(updateAt(conditions, idx, { values, operator: 'Any of' }));
  };

  return (
    <>
      {conditions.map((c, i) => {
        const attrMeta = meta ? meta[c.attribute] : null;
        const opOptions: string[] = lockedAttribute
          ? LOCKED_ATTR_OPERATORS
          : attrMeta?.type === 'multiSelect'
            ? ['Any of']
            : attrMeta?.type === 'number' || attrMeta?.type === 'date'
              ? ['Equals', 'Greater than', 'Less than', 'Between']
              : ['Equals', 'Not Equals'];
        // multiSelect only has one real operator — rendered as already
        // selected rather than making someone pick from a 1-option list,
        // same precedent used throughout this file. The underlying
        // condition object is backfilled with it once a value is toggled.
        const effectiveOperator = attrMeta?.type === 'multiSelect' ? 'Any of' : c.operator;
        // Every condition in this list is AND'd together — picking the
        // same attribute in two rows can trivially produce a
        // self-contradictory, always-false condition (e.g. "Status =
        // Active" AND "Status ≠ Active" in the same list) with nothing
        // to warn about it. Excluding attributes already claimed by
        // OTHER rows (not this row's own pick) from this row's own
        // dropdown rules that out structurally instead of relying on a
        // warning someone could ignore.
        const usedElsewhere = new Set(conditions.filter((_, idx) => idx !== i).map((cc) => cc.attribute).filter(Boolean));

        return (
          <div className="cond-row" key={i}>
            {attrOptions ? (
              <select value={c.attribute} onChange={(e) => setRow(i, { attribute: e.target.value, value: '', values: [] })}>
                <option value="">Attribute</option>
                {attrOptions
                  .filter((a) => a === c.attribute || !usedElsewhere.has(a))
                  .map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
              </select>
            ) : lockedAttribute ? (
              // Not editable — this event type has exactly one real
              // attribute to narrow on (see EVENT_ATTR_BY_TYPE), so
              // there's nothing to pick. Shown, not hidden, so it still
              // reads as "this row is about X," same as a picked select
              // value would.
              <input type="text" className="f-input" value={lockedAttribute} disabled />
            ) : (
              <input type="text" className="f-input" placeholder="Attribute" value={c.attribute || ''} onChange={(e) => setRow(i, { attribute: e.target.value })} />
            )}

            <select value={effectiveOperator} onChange={(e) => setRow(i, { operator: e.target.value })}>
              <option value="">Operator</option>
              {opOptions.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>

            <ValueField cond={c} attrMeta={attrMeta} onPatch={(patch) => setRow(i, patch)} onToggleMulti={(v) => toggleMulti(i, v)} />

            <div className="cond-remove" onClick={() => removeRow(i)}>
              ✕
            </div>
          </div>
        );
      })}
      <div className="add-link" onClick={addRow}>
        + Add condition
      </div>
    </>
  );
}

export function ValueField({
  cond,
  attrMeta,
  onPatch,
  onToggleMulti,
}: {
  cond: Cond;
  attrMeta: { type: AttrType; options?: string[] } | null | undefined;
  onPatch: (patch: Partial<Cond>) => void;
  onToggleMulti: (val: string) => void;
}) {
  if (attrMeta?.type === 'multiSelect') {
    return <MultiSelectDropdown options={attrMeta.options || []} selected={cond.values || []} onToggle={onToggleMulti} />;
  }
  if (attrMeta?.type === 'select') {
    return (
      <select value={cond.value || ''} onChange={(e) => onPatch({ value: e.target.value })}>
        <option value="">Value</option>
        {(attrMeta.options || []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (attrMeta?.type === 'bool') {
    return (
      <select value={cond.value || ''} onChange={(e) => onPatch({ value: e.target.value })}>
        <option value="">Value</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (attrMeta?.type === 'number' && cond.operator === 'Between') {
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        <input type="number" className="f-input" placeholder="From" value={cond.value || ''} onChange={(e) => onPatch({ value: e.target.value })} />
        <input type="number" className="f-input" placeholder="To" value={cond.value2 || ''} onChange={(e) => onPatch({ value2: e.target.value })} />
      </div>
    );
  }
  if (attrMeta?.type === 'number') {
    return <input type="number" className="f-input" placeholder="Value" value={cond.value || ''} onChange={(e) => onPatch({ value: e.target.value })} />;
  }
  if (attrMeta?.type === 'date') {
    return <input type="date" className="f-input" value={cond.value || ''} onChange={(e) => onPatch({ value: e.target.value })} />;
  }
  return <input type="text" className="f-input" placeholder="Value" value={cond.value || ''} onChange={(e) => onPatch({ value: e.target.value })} />;
}
