// Ported from dcTypePickerHtml — the categorized add-step type picker.
// The "Connect to an Existing Step" reuse tile (merge a branch into a
// node elsewhere in the tree) was removed — real gap between what it
// solved and how rarely it mattered next to the normal add/mid-insert
// flows.
//
// Once a type is picked, the full grid collapses to a single summary
// chip + an explicit "Change" button, and the config form renders right
// below it — the picker's only job is picking; showing every other
// option after you've already committed was pure noise sitting between
// the tile you clicked and the fields you actually came here for. The
// "Change" affordance is a real bordered button, not a text link —
// someone who picked the wrong type needs to find their way back to the
// grid without it reading as "cancel and start over."
//
// `choosing` is owned by AddEditDrawer, not local state here — while
// re-opened via "Change," the still-stale config form for the old type
// has to disappear too (there's no "chosen" type to show a form for
// until a new pick lands), so the parent needs to know the grid is open
// in order to hide it, not just this component.
import { DC_NODE_META, DC_CATEGORY_ICON, DC_TYPE_CATEGORIES, type DcNodeType } from '../data/nodeMeta';
import { DC_ENTRY_TYPES, DC_TYPE_SUB } from '../data/typeSub';
import { Icon } from '../components/icons';

export function TypePicker({
  types,
  selectedType,
  choosing,
  hint,
  disabledTypes,
  onPick,
  onChangeClick,
}: {
  types: DcNodeType[];
  selectedType: DcNodeType | null;
  choosing: boolean;
  // Explains why some tiles are disabled below — rendered above the grid
  // so the reason reads as deliberate, not broken/incomplete.
  hint?: string;
  // Every offerable tile is always shown (Phase 1 §10: silent omission
  // is worse than visible-but-explained) — a type present here with a
  // reason string renders greyed-out with that reason as its tooltip,
  // instead of being filtered out of `types` entirely.
  disabledTypes?: Partial<Record<DcNodeType, string>>;
  onPick: (t: DcNodeType) => void;
  onChangeClick: () => void;
}) {
  const isEntryPicker = types === DC_ENTRY_TYPES || (types.length === DC_ENTRY_TYPES.length && types.every((t) => DC_ENTRY_TYPES.includes(t)));

  if (selectedType && !choosing) {
    const meta = DC_NODE_META[selectedType];
    return (
      <div className={`dc-type-chip cat-${meta.cat}`}>
        <span className="dc-type-chip-label">{meta.type}</span>
        <button type="button" className="dc-type-chip-change" onClick={onChangeClick}>
          Change
        </button>
      </div>
    );
  }

  const tile = (t: DcNodeType) => {
    const disabledReason = disabledTypes?.[t];
    const cat = DC_NODE_META[t].cat;
    return (
      <div
        key={t}
        className={`dc-type-opt cat-${cat}${selectedType === t ? ' active' : ''}${disabledReason ? ' disabled' : ''}`}
        onClick={disabledReason ? undefined : () => onPick(t)}
        title={disabledReason}
      >
        <span className="dc-type-opt-icon">
          <Icon name={DC_CATEGORY_ICON[cat]} />
        </span>
        <span className="dc-type-opt-text">
          <span className="dc-type-opt-name">{DC_NODE_META[t].type}</span>
          <span className="dc-type-opt-sub">{disabledReason || DC_TYPE_SUB[t]}</span>
        </span>
      </div>
    );
  };

  return (
    <>
      {hint && (
        <p className="f-hint" style={{ margin: '0 0 12px' }}>
          {hint}
        </p>
      )}
      {isEntryPicker ? (
        <div className="dc-type-picker dc-type-picker-entry">{types.map(tile)}</div>
      ) : (
        DC_TYPE_CATEGORIES.map((g) => {
          const groupTypes = g.types.filter((t) => types.includes(t));
          if (!groupTypes.length) return null;
          return (
            <div key={g.label}>
              <div className="dc-type-group-label">{g.label}</div>
              <div className="dc-type-picker">{groupTypes.map(tile)}</div>
            </div>
          );
        })
      )}
    </>
  );
}
