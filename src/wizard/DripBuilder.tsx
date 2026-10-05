// Thin step dispatcher holding all shared state — the create/edit flow
// is now 3 steps (Basic Details -> Goal Definition -> Builder, see the
// UX-rebuild plan) instead of the old Setup -> Build. `graph` is a small
// history stack rather than a bare useState, so the Builder step can
// offer real Undo/Redo. Doesn't know about the campaigns list or
// persistence; emits a finished payload via onSaveDraft/onSubmit for
// whatever owns the list (Phase 4) to persist.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState } from 'react';
import type { DripCampaign, DripGoal, DripGraph } from '../data/graphTypes';
import type { DcNodeType } from '../data/nodeMeta';
import { DC_ENTRY_TYPES } from '../data/typeSub';
import type { Channel } from '../data/sharedConstants';
import { dcConfirmAddNode, dcConfirmEditNode, dcRemoveEdge, dcRemoveRoot, dcConnectExisting, type DcAddingAt } from '../reducer/campaignReducer';
import { dcValidMergeTargets, dcGraphHasOpenBranches } from '../reducer/graphOps';
import { dcDefaultConfig } from '../reducer/defaultConfig';
import { BasicDetailsStep } from './BasicDetailsStep';
import { GoalDefinitionStep } from './GoalDefinitionStep';
import { BuilderStep } from './BuilderStep';
import { WizardStepper } from './WizardStepper';
import { AddEditDrawer } from './AddEditDrawer';
import './dripBuilder.css';

const EMPTY_GRAPH: DripGraph = { nodes: {}, edges: [], rootId: null };

// Mid-chain insert only reattaches cleanly when the new node (plus its
// own auto-children) leaves exactly one dangling continuation edge — a
// branching type (Random/Decision Split) leaves several open arms with
// no single correct one to reattach to, so those aren't offered here.
// The reducer itself is defensive about this too (see campaignReducer.ts).
const MID_EDGE_TYPES: DcNodeType[] = ['SEND', 'CHANNEL_FAILOVER', 'PAUSE', 'WAIT_UNTIL', 'SPLIT'];

export interface DripBuilderPayload {
  name: string;
  description: string;
  goal: DripGoal | null;
  controlPct: number;
  issuer: string;
  programs: string[];
  startDate: string;
  endDate: string;
  status: 'DRAFT' | 'PENDING_REVIEW';
  root: DripGraph;
}

type BuilderStepKind = 'basicDetails' | 'goalDefinition' | 'builder';

export function DripBuilder({
  initial,
  onSaveDraft,
  onSubmit,
  onBack,
}: {
  initial?: DripCampaign;
  onSaveDraft: (payload: DripBuilderPayload) => void;
  onSubmit: (payload: DripBuilderPayload) => void;
  onBack: () => void;
}) {
  const [step, setStep] = useState<BuilderStepKind>(initial ? 'builder' : 'basicDetails');
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [issuer, setIssuer] = useState(initial?.issuer || '');
  const [programs, setPrograms] = useState<string[]>(initial?.programs || []);
  const [controlPct, setControlPct] = useState(initial?.controlPct ?? 10);
  const [startDate, setStartDate] = useState(initial?.startDate || '');
  const [endDate, setEndDate] = useState(initial?.endDate || '');
  const [goal, setGoal] = useState<DripGoal | null>(initial?.goal || null);

  // Graph as a history stack — every mutation pushes a new entry
  // (truncating any redo tail first), so Undo/Redo just move the index.
  const [history, setHistory] = useState<DripGraph[]>([initial?.root ? structuredClone(initial.root) : EMPTY_GRAPH]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const graph = history[historyIndex];
  function pushGraph(next: DripGraph) {
    setHistory((h) => [...h.slice(0, historyIndex + 1), next]);
    setHistoryIndex((i) => i + 1);
  }
  const canUndo = historyIndex > 0;
  const canRedo = historyIndex < history.length - 1;

  const [entryEventCategory, setEntryEventCategory] = useState<string | null>(() => {
    const root = initial?.root?.rootId ? initial.root.nodes[initial.root.rootId] : null;
    return root?.type === 'ENTRY_EVENT' ? (root.meta.split(' · ')[0] ?? null) : null;
  });

  // Add/edit drawer state.
  const [addingAt, setAddingAt] = useState<DcAddingAt | null>(null);
  const [addingType, setAddingType] = useState<DcNodeType | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [pendingConfig, setPendingConfig] = useState<any>({});
  const [connectMode, setConnectMode] = useState(false);
  const [connectTargetId, setConnectTargetId] = useState<string | null>(null);
  const [showValidation, setShowValidation] = useState(false);

  const drawerOpen = addingAt !== null || editingNodeId !== null;

  const addingAtSourceId = useMemo(() => {
    if (!addingAt) return null;
    if (addingAt.kind === 'edge' || addingAt.kind === 'midEdge') return graph.edges.find((x) => x.id === addingAt.edgeId)?.from ?? null;
    if (addingAt.kind === 'growLeaf') return addingAt.nodeId;
    return null;
  }, [addingAt, graph]);

  // The channel of the most recent Send before this point — walks
  // backward via incoming edges, transparently skipping the auto
  // goal-check Split every Send inserts, so "previous step outcome"
  // means the last real message sent, not just the nearest node.
  const previousStepChannel: Channel | null = useMemo(() => {
    let nodeId = editingNodeId !== null ? editingNodeId : addingAtSourceId;
    while (nodeId) {
      const nd = graph.nodes[nodeId];
      if (nd && nd.type === 'SEND' && nd._config) return (nd._config as any).channel as Channel;
      const inc = graph.edges.find((e) => e.to === nodeId);
      nodeId = inc ? inc.from : null;
    }
    return null;
  }, [editingNodeId, addingAtSourceId, graph]);

  function selectAddAt(at: DcAddingAt) {
    setAddingAt(at);
    setAddingType(null);
    setPendingConfig({});
    setConnectMode(false);
    setConnectTargetId(null);
    setEditingNodeId(null);
  }

  function pickType(t: DcNodeType) {
    setAddingType(t);
    setPendingConfig(dcDefaultConfig(t, goal));
  }

  function cancelAdd() {
    setAddingAt(null);
    setAddingType(null);
    setConnectMode(false);
  }

  function confirmAddNode() {
    if (!addingType || !addingAt) return;
    const next = dcConfirmAddNode(graph, addingType, pendingConfig, addingAt, goal);
    pushGraph(next);
    if (addingType === 'ENTRY_EVENT') setEntryEventCategory(pendingConfig.eventCategory);
    cancelAdd();
  }

  function openEditNode(nodeId: string) {
    const node = graph.nodes[nodeId];
    if (!node) return;
    setEditingNodeId(nodeId);
    setAddingType(node.type);
    setPendingConfig(node._config ? structuredClone(node._config) : {});
  }
  function cancelEdit() {
    setEditingNodeId(null);
    setAddingType(null);
  }
  function confirmEditNode() {
    if (!editingNodeId || !addingType) return;
    const next = dcConfirmEditNode(graph, editingNodeId, addingType, pendingConfig, goal);
    pushGraph(next);
    cancelEdit();
  }

  function removeEdge(edgeId: string) {
    pushGraph(dcRemoveEdge(graph, edgeId));
  }
  function removeRoot() {
    pushGraph(dcRemoveRoot(graph));
  }
  function replaceAuto(edgeId: string) {
    removeEdge(edgeId);
    selectAddAt({ kind: 'edge', edgeId });
  }

  function enterConnectMode() {
    setConnectMode(true);
    setAddingType(null);
    setConnectTargetId(null);
  }
  function confirmConnectExisting() {
    if (!addingAt || !connectTargetId) return;
    pushGraph(dcConnectExisting(graph, addingAt, connectTargetId));
    cancelAdd();
  }

  const isEntry = graph.rootId === null;
  const connectTargets = addingAtSourceId ? dcValidMergeTargets(graph, addingAtSourceId) : [];
  // Connect-to-existing isn't wired up for a mid-chain insert — splicing
  // in a reference to an existing node mid-sequence has its own set of
  // questions (which of that node's existing paths applies here?) this
  // rebuild doesn't need to answer yet.
  const canConnect = !editingNodeId && !isEntry && addingAt?.kind !== 'midEdge' && !!addingAtSourceId && connectTargets.length > 0;
  const open = dcGraphHasOpenBranches(graph);
  const canSubmit = !!name && !!issuer && graph.rootId !== null && !open;

  const validationMessage: string | null = !showValidation
    ? null
    : !name
      ? 'Give this campaign a name first — see Edit Setup.'
      : !issuer
        ? 'Set an issuer first — see Edit Setup.'
        : graph.rootId === null
          ? 'Add an entry step before submitting.'
          : open
            ? 'Some branches still need a next step before this can be submitted.'
            : null;

  function buildPayload(status: 'DRAFT' | 'PENDING_REVIEW'): DripBuilderPayload {
    // Never persist a half-filled goal (category picked, no event type
    // yet) — same discipline the old GoalDrawer's disabled Save button
    // enforced, now applied at save time since Goal Definition no longer
    // has a separate draft/commit step of its own.
    const cleanGoal = goal && goal.eventType ? goal : null;
    return { name, description, goal: cleanGoal, controlPct: Number(controlPct), issuer, programs, startDate, endDate, status, root: graph };
  }

  function handleSubmitClick() {
    if (!canSubmit) {
      setShowValidation(true);
      return;
    }
    onSubmit(buildPayload('PENDING_REVIEW'));
  }

  const isStepComplete = (s: BuilderStepKind) => (s === 'basicDetails' ? !!name : s === 'goalDefinition' ? !!(goal && goal.eventType) : true);

  return (
    <div className="dcb-shell">
      <WizardStepper current={step} onNavigate={setStep} onBack={onBack} isStepComplete={isStepComplete}>
        {step === 'builder' && (
          <>
            <button className="btn secondary small" disabled={!canUndo} onClick={() => setHistoryIndex((i) => Math.max(0, i - 1))} title="Undo">
              ↶ Undo
            </button>
            <button className="btn secondary small" disabled={!canRedo} onClick={() => setHistoryIndex((i) => Math.min(history.length - 1, i + 1))} title="Redo">
              ↷ Redo
            </button>
            <button className="btn secondary" onClick={() => onSaveDraft(buildPayload('DRAFT'))}>
              Save as Draft
            </button>
            <button className="btn primary" onClick={handleSubmitClick}>
              Submit for Approval
            </button>
          </>
        )}
      </WizardStepper>

      {step === 'basicDetails' && (
        <div className="dcb-step-body">
          <BasicDetailsStep
            isEditing={!!initial}
            name={name}
            onNameChange={setName}
            description={description}
            onDescriptionChange={setDescription}
            issuer={issuer}
            onIssuerChange={setIssuer}
            programs={programs}
            onProgramsChange={setPrograms}
            controlPct={controlPct}
            onControlPctChange={setControlPct}
            startDate={startDate}
            onStartDateChange={setStartDate}
            endDate={endDate}
            onEndDateChange={setEndDate}
            onSaveDraft={() => onSaveDraft(buildPayload('DRAFT'))}
            onContinue={() => setStep('goalDefinition')}
            onSkipToBuilder={() => setStep('builder')}
          />
        </div>
      )}

      {step === 'goalDefinition' && (
        <div className="dcb-step-body">
          <GoalDefinitionStep goal={goal} onGoalChange={setGoal} onSaveDraft={() => onSaveDraft(buildPayload('DRAFT'))} onContinue={() => setStep('builder')} />
        </div>
      )}

      {step === 'builder' && (
        <BuilderStep
          graph={graph}
          validationMessage={validationMessage}
          onAddEntry={() => selectAddAt({ kind: 'root' })}
          onEditNode={openEditNode}
          onRemoveRoot={removeRoot}
          onReplaceAuto={replaceAuto}
          onRemoveEdge={removeEdge}
          onAddAtEdge={(edgeId) => selectAddAt({ kind: 'edge', edgeId })}
          onAddAtGrowLeaf={(nodeId) => selectAddAt({ kind: 'growLeaf', nodeId })}
          onAddAtMidEdge={(edgeId) => selectAddAt({ kind: 'midEdge', edgeId })}
        />
      )}

      <AddEditDrawer
        open={drawerOpen}
        isEditing={editingNodeId !== null}
        isEntry={isEntry}
        types={
          isEntry
            ? DC_ENTRY_TYPES
            : addingAt?.kind === 'midEdge'
              ? MID_EDGE_TYPES
              : (['SEND', 'CHANNEL_FAILOVER', 'PAUSE', 'WAIT_UNTIL', 'SPLIT', 'DECISION_SPLIT', 'RANDOM_SPLIT', 'GOAL_EXIT', 'EXIT'] as DcNodeType[])
        }
        selectedType={addingType}
        pendingConfig={pendingConfig}
        onConfigChange={(patch) => setPendingConfig((p: any) => ({ ...p, ...patch }))}
        onPickType={pickType}
        canConnect={canConnect}
        connectMode={connectMode}
        connectTargets={connectTargets}
        connectTargetId={connectTargetId}
        onEnterConnectMode={enterConnectMode}
        onSelectConnectTarget={setConnectTargetId}
        onCancel={editingNodeId !== null ? cancelEdit : cancelAdd}
        onConfirm={connectMode ? confirmConnectExisting : editingNodeId !== null ? confirmEditNode : confirmAddNode}
        goal={goal}
        entryEventCategory={entryEventCategory}
        previousStepChannel={previousStepChannel}
      />
    </div>
  );
}
