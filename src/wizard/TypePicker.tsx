// Ported from dcTypePickerHtml — the categorized add-step type picker
// plus the "Connect to an Existing Step" reuse tile.
import { DC_NODE_META, DC_TYPE_CATEGORIES, type DcNodeType } from '../data/nodeMeta';
import { DC_ENTRY_TYPES, DC_TYPE_SUB } from '../data/typeSub';

export function TypePicker({
  types,
  selectedType,
  canConnect,
  connectMode,
  onPick,
  onEnterConnectMode,
}: {
  types: DcNodeType[];
  selectedType: DcNodeType | null;
  canConnect: boolean;
  connectMode: boolean;
  onPick: (t: DcNodeType) => void;
  onEnterConnectMode: () => void;
}) {
  const isEntryPicker = types === DC_ENTRY_TYPES || (types.length === 3 && types.every((t) => DC_ENTRY_TYPES.includes(t)));

  const tile = (t: DcNodeType) => (
    <div key={t} className={`dc-type-opt cat-${DC_NODE_META[t].cat}${selectedType === t ? ' active' : ''}`} onClick={() => onPick(t)}>
      {DC_NODE_META[t].type}
      <div className="dc-type-opt-sub">{DC_TYPE_SUB[t]}</div>
    </div>
  );

  return (
    <>
      {isEntryPicker ? (
        <div className="dc-type-picker">{types.map(tile)}</div>
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
      {canConnect && (
        <>
          <div className="dc-type-group-label">Reuse</div>
          <div className="dc-type-picker" style={{ gridTemplateColumns: '1fr' }}>
            <div className={`dc-type-opt cat-link${connectMode ? ' active' : ''}`} onClick={onEnterConnectMode}>
              🔗 Connect to an Existing Step
              <div className="dc-type-opt-sub">Point this branch at a step you've already built, instead of duplicating it</div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
