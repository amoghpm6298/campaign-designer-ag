// Orchestrates the add/edit-node drawer: type picker (add only) or
// connect-existing UI, then the selected type's config form, then the
// footer buttons. Ported from dcRenderAddDrawer.
import { SideDrawer, SideDrawerHead, SideDrawerFoot } from '../components/SideDrawer';
import { TypePicker } from './TypePicker';
import { ConnectExisting } from './ConnectExisting';
import * as Forms from './NodeForms';
import { dcAddFormValid } from '../reducer/defaultConfig';
import type { DcNodeType } from '../data/nodeMeta';
import type { DripGoal, DripNode } from '../data/graphTypes';
import type { Channel } from '../data/sharedConstants';

export interface AddEditDrawerProps {
  open: boolean;
  isEditing: boolean;
  isEntry: boolean;
  types: DcNodeType[];
  selectedType: DcNodeType | null;
  pendingConfig: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  onConfigChange: (patch: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any
  onPickType: (t: DcNodeType) => void;
  canConnect: boolean;
  connectMode: boolean;
  connectTargets: DripNode[];
  connectTargetId: string | null;
  onEnterConnectMode: () => void;
  onSelectConnectTarget: (id: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  goal: DripGoal | null;
  entryEventCategory: string | null;
  previousStepChannel: Channel | null;
}

export function AddEditDrawer(props: AddEditDrawerProps) {
  const { open, isEditing, isEntry, types, selectedType, pendingConfig, onConfigChange, onPickType, canConnect, connectMode, connectTargets, connectTargetId, onEnterConnectMode, onSelectConnectTarget, onCancel, onConfirm, goal, entryEventCategory, previousStepChannel } = props;

  const primaryDisabled = connectMode ? !connectTargetId : !(selectedType && dcAddFormValid(selectedType, pendingConfig));
  const primaryLabel = connectMode ? 'Connect' : isEditing ? 'Save Changes' : isEntry ? 'Add Entry' : 'Add Step';
  const title = isEditing ? 'Edit Step' : isEntry ? 'Add Entry' : 'Add Next Step';

  return (
    <SideDrawer open={open} widthPx={620} onClose={onCancel}>
      <SideDrawerHead title={title} onClose={onCancel} />
      <div className="sd-body">
        {!isEditing && (
          <TypePicker types={types} selectedType={selectedType} canConnect={canConnect} connectMode={connectMode} onPick={onPickType} onEnterConnectMode={onEnterConnectMode} />
        )}
        {connectMode ? (
          <ConnectExisting targets={connectTargets} selectedId={connectTargetId} onSelect={onSelectConnectTarget} />
        ) : (
          selectedType && <NodeForm type={selectedType} p={pendingConfig} onChange={(patch) => onConfigChange(patch)} goal={goal} entryEventCategory={entryEventCategory} previousStepChannel={previousStepChannel} />
        )}
      </div>
      <SideDrawerFoot onCancel={onCancel} onPrimary={onConfirm} primaryLabel={primaryLabel} primaryDisabled={primaryDisabled} />
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
    case 'ENTRY_SCHEDULED':
      return <Forms.EntryScheduledForm p={p} onChange={onChange} />;
    case 'SEND':
      return <Forms.SendForm p={p} onChange={onChange} />;
    case 'CHANNEL_FAILOVER':
      return <Forms.ChannelFailoverForm p={p} onChange={onChange} />;
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
    case 'GOAL_EXIT':
    case 'EXIT':
      return <Forms.ReasonForm p={p} onChange={onChange} />;
    default:
      return null;
  }
}
