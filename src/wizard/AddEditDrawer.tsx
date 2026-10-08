// Orchestrates the add/edit-node drawer: type picker (add only), then
// the selected type's config form, then the footer buttons. Ported from
// dcRenderAddDrawer. "Connect to an Existing Step" (merge a branch into
// an already-built node elsewhere in the tree) was removed — real gap
// between what it solved and how rarely it mattered in practice next to
// the normal add/mid-insert flows.
import { useEffect, useState } from 'react';
import { SideDrawer, SideDrawerHead, SideDrawerFoot } from '../components/SideDrawer';
import { TypePicker } from './TypePicker';
import * as Forms from './NodeForms';
import { dcAddFormValid } from '../reducer/defaultConfig';
import type { DcNodeType } from '../data/nodeMeta';
import type { DripGoal } from '../data/graphTypes';
import type { Channel } from '../data/sharedConstants';

export interface AddEditDrawerProps {
  open: boolean;
  isEditing: boolean;
  isEntry: boolean;
  // True when this add is splicing a new node into an edge that already
  // connects two real nodes (mid-chain insert) — the type list is
  // narrowed to single-continuation types only there (no Random/Decision
  // Split, no Goal-Based Exit/Exit), since a branching type would leave
  // several open arms with no single correct downstream node to
  // reattach. Drives an explanatory line in the picker so a shorter list
  // here reads as deliberate, not broken/incomplete.
  isMidEdge: boolean;
  types: DcNodeType[];
  disabledTypes?: Partial<Record<DcNodeType, string>>;
  selectedType: DcNodeType | null;
  pendingConfig: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  onConfigChange: (patch: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
  onPickType: (t: DcNodeType) => void;
  onCancel: () => void;
  onConfirm: () => void;
  goal: DripGoal | null;
  entryEventCategory: string | null;
  previousStepChannel: Channel | null;
  // Goal Check's own "edit" view is read-only (see NodeForms.tsx's
  // GoalCheckInfo) — this is its one real action, a shortcut back to the
  // Goal Definition step rather than a dead end.
  onGoToGoal?: () => void;
}

export function AddEditDrawer(props: AddEditDrawerProps) {
  const { open, isEditing, isEntry, isMidEdge, types, disabledTypes, selectedType, pendingConfig, onConfigChange, onPickType, onCancel, onConfirm, goal, entryEventCategory, previousStepChannel, onGoToGoal } = props;

  // Whether the type grid should be showing right now, as opposed to the
  // collapsed chip. True initially (nothing picked yet) and whenever the
  // "Change" button re-opens it; false the instant a type is picked. This
  // drawer never unmounts between separate add actions (DripBuilder keeps
  // it mounted, only toggling `open`), so it's reset explicitly below
  // rather than relying on fresh component state for each add.
  const [choosingType, setChoosingType] = useState(true);
  useEffect(() => {
    if (selectedType === null) setChoosingType(true);
  }, [selectedType]);

  const isGoalCheck = selectedType === 'GOAL_CHECK';
  const primaryDisabled = !(selectedType && dcAddFormValid(selectedType, pendingConfig));
  const primaryLabel = isEditing ? 'Save Changes' : isEntry ? 'Add Entry' : 'Add Step';
  const title = isGoalCheck ? 'Goal Check' : isEditing ? 'Edit Step' : isEntry ? 'Add Entry' : 'Add Next Step';
  // Editing never shows the type grid at all, so it never has a "still
  // choosing" state to begin with — the form is always what's wanted.
  const showForm = selectedType && (isEditing || !choosingType);

  return (
    <SideDrawer open={open} widthPx={620} onClose={onCancel}>
      <SideDrawerHead title={title} onClose={onCancel} />
      <div className="sd-body">
        {!isEditing && (
          <TypePicker
            types={types}
            disabledTypes={disabledTypes}
            selectedType={selectedType}
            choosing={choosingType}
            hint={isMidEdge && choosingType ? 'Inserting mid-chain only supports single-continuation steps — branching and terminal types are shown below but disabled, since they would leave more than one new path (or none) with nothing to reconnect to.' : undefined}
            onPick={(t) => {
              setChoosingType(false);
              onPickType(t);
            }}
            onChangeClick={() => setChoosingType(true)}
          />
        )}
        {showForm && isGoalCheck && <Forms.GoalCheckInfo goal={goal} onGoToGoal={onGoToGoal} />}
        {showForm && !isGoalCheck && (
          <NodeForm type={selectedType!} p={pendingConfig} onChange={(patch) => onConfigChange(patch)} goal={goal} entryEventCategory={entryEventCategory} previousStepChannel={previousStepChannel} />
        )}
      </div>
      {isGoalCheck ? (
        <div className="sd-foot">
          <button className="btn secondary" onClick={onCancel}>
            Close
          </button>
        </div>
      ) : (
        <SideDrawerFoot onCancel={onCancel} onPrimary={onConfirm} primaryLabel={primaryLabel} primaryDisabled={primaryDisabled} />
      )}
    </SideDrawer>
  );
}

function NodeForm({
  type,
  p,
  onChange,
  goal,
  entryEventCategory,
  previousStepChannel,
}: {
  type: DcNodeType;
  p: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  onChange: (patch: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
  goal: DripGoal | null;
  entryEventCategory: string | null;
  previousStepChannel: Channel | null;
}) {
  switch (type) {
    case 'ENTRY_SEGMENT':
      return <Forms.EntrySegmentForm p={p} onChange={onChange} />;
    case 'ENTRY_EVENT':
      return <Forms.EntryEventForm p={p} onChange={onChange} />;
    case 'SEND':
      return <Forms.SendForm p={p} onChange={onChange} />;
    case 'PAUSE':
      return <Forms.PauseForm p={p} onChange={onChange} />;
    case 'WAIT_UNTIL':
      return <Forms.WaitUntilForm p={p} onChange={onChange} />;
    case 'SPLIT':
      return <Forms.SplitForm p={p} onChange={onChange} goal={goal} entryEventCategory={entryEventCategory} previousStepChannel={previousStepChannel} />;
    case 'DECISION_SPLIT':
      return <Forms.DecisionSplitForm p={p} onChange={onChange} entryEventCategory={entryEventCategory} previousStepChannel={previousStepChannel} />;
    case 'RANDOM_SPLIT':
      return <Forms.RandomSplitForm p={p} onChange={onChange} />;
    case 'GOAL_CHECK':
      // Never actually reached — AddEditDrawer renders GoalCheckInfo
      // directly for this type instead of routing through NodeForm, since
      // it also needs the onGoToGoal callback this switch doesn't carry.
      return null;
    case 'GOAL_EXIT':
    case 'EXIT':
      return <Forms.ReasonForm p={p} onChange={onChange} />;
    default:
      return null;
  }
}
