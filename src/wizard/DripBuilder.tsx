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
import type { PrevStepSend } from '../data/sharedConstants';
import { dcConfirmAddNode, dcConfirmEditNode, dcRemoveEdge, dcRemoveGoalCheck, dcRemoveRoot, type DcAddingAt } from '../reducer/campaignReducer';
import { dcGraphHasOpenBranches } from '../reducer/graphOps';
import { dcDefaultConfig, dcDefaultExitReason } from '../reducer/defaultConfig';
import { BasicDetailsStep } from './BasicDetailsStep';
import { GoalDefinitionStep } from './GoalDefinitionStep';
import { BuilderStep } from './BuilderStep';
import { GuardrailsStep } from './GuardrailsStep';
import { ReviewStep } from './ReviewStep';
import { WizardStepper } from './WizardStepper';
import { AddEditDrawer } from './AddEditDrawer';
import { Icon } from '../components/icons';
import './dripBuilder.css';

const EMPTY_GRAPH: DripGraph = { nodes: {}, edges: [], rootId: null };

// Full user-facing taxonomy, every non-Entry context (Phase 1 §10A) —
// GOAL_CHECK is never a member: it's 100% system-generated, never a tile
// in any Add Step context. Always passed in full; which tiles are
// actually pickable right now is controlled by `disabledTypes` below, not
// by shortening this list (Phase 1 §10: show disabled-with-a-reason,
// never silently omit).
const ALL_STEP_TYPES: DcNodeType[] = ['SEND', 'PAUSE', 'WAIT_UNTIL', 'SPLIT', 'DECISION_SPLIT', 'RANDOM_SPLIT', 'GOAL_EXIT', 'EXIT'];

// Mid-chain insert only reattaches cleanly when the new node (plus its
// own auto-children) leaves exactly one dangling continuation edge — a
// branching type (Branch/Experiment) leaves several open arms, and a
// terminal type (Exit/Goal Reached) leaves none, with no single correct
// edge to reattach to. The reducer itself is defensive about this too
// (see campaignReducer.ts) — this list is what the UI disables/explains.
const MID_EDGE_DISABLED_REASON = "Branching and terminal steps can't be inserted mid-chain — add this after the step above instead.";
const MID_EDGE_RESTRICTED_TYPES: DcNodeType[] = ['DECISION_SPLIT', 'RANDOM_SPLIT', 'GOAL_EXIT', 'EXIT'];

// Goal Reached is only a legitimate manual pick on an already-forked
// branch arm (Phase 1 §5) — anywhere else it would silently mark
// everyone who reaches that point as having achieved the goal,
// unconditionally, with no way back (the exact dead-end pattern this
// restriction exists to prevent).
const GOAL_REACHED_LINEAR_REASON = 'This would mark everyone who reaches this point as having achieved the goal, unconditionally. Add a Condition or Branch first if you want to check for it.';

export interface DripBuilderPayload {
  name: string;
  description: string;
  goal: DripGoal | null;
  controlPct: number;
  issuer: string;
  applyToAllPrograms: boolean;
  programs: string[];
  startDate: string;
  endDate: string;
  allowReEntry: boolean;
  reEntryCooloffDuration: number;
  reEntryCooloffUnit: 'days' | 'hours';
  guardrails: { dnc: boolean; npa: boolean };
  status: 'DRAFT' | 'PENDING_REVIEW';
  root: DripGraph;
}

type BuilderStepKind = 'basicDetails' | 'goalDefinition' | 'builder' | 'guardrails' | 'review';

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
  const [applyToAllPrograms, setApplyToAllPrograms] = useState(initial?.applyToAllPrograms ?? false);
  const [programs, setPrograms] = useState<string[]>(initial?.programs || []);
  const [controlPct, setControlPct] = useState(initial?.controlPct ?? 10);
  const [allowReEntry, setAllowReEntry] = useState(initial?.allowReEntry ?? false);
  const [reEntryCooloffDuration, setReEntryCooloffDuration] = useState(initial?.reEntryCooloffDuration ?? 0);
  const [reEntryCooloffUnit, setReEntryCooloffUnit] = useState<'days' | 'hours'>(initial?.reEntryCooloffUnit ?? 'days');
  const [dnc, setDnc] = useState(initial?.guardrails?.dnc ?? true);
  const [npa, setNpa] = useState(initial?.guardrails?.npa ?? true);
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
  const [showValidation, setShowValidation] = useState(false);

  const drawerOpen = addingAt !== null || editingNodeId !== null;

  const addingAtSourceId = useMemo(() => {
    if (!addingAt) return null;
    if (addingAt.kind === 'edge' || addingAt.kind === 'midEdge') return graph.edges.find((x) => x.id === addingAt.edgeId)?.from ?? null;
    if (addingAt.kind === 'growLeaf') return addingAt.nodeId;
    return null;
  }, [addingAt, graph]);

  // Which Add Step tiles are offered but disabled right now, and why —
  // every tile always renders (Phase 1 §10), this only controls which
  // ones are clickable. Two independent restrictions can apply at once
  // (mid-chain insert into a linear edge), so they're merged rather than
  // treated as mutually exclusive.
  const disabledTypes = useMemo((): Partial<Record<DcNodeType, string>> => {
    const d: Partial<Record<DcNodeType, string>> = {};
    if (addingAt?.kind === 'midEdge') {
      MID_EDGE_RESTRICTED_TYPES.forEach((t) => {
        d[t] = MID_EDGE_DISABLED_REASON;
      });
    }
    // Goal Reached is only offered on an already-forked branch arm — a
    // real edge coming off a node with 2+ outgoing edges (Condition/
    // Branch/Experiment/Goal Check). `growLeaf` and a source with only
    // one outgoing edge are both the plain, linear "whatever comes next"
    // case this restriction exists to catch.
    const sourceOutCount = addingAtSourceId ? graph.edges.filter((e) => e.from === addingAtSourceId).length : 0;
    const isBranchArm = addingAt?.kind === 'edge' && sourceOutCount > 1;
    if (!isBranchArm && !d['GOAL_EXIT']) d['GOAL_EXIT'] = GOAL_REACHED_LINEAR_REASON;
    return d;
  }, [addingAt, addingAtSourceId, graph]);

  // The most recent Send before this point — walks backward via incoming
  // edges, transparently skipping the auto goal-check Split every Send
  // inserts, so "previous step outcome" means the last real message sent,
  // not just the nearest node. Carries the fallback channel along too —
  // if a fallback is configured, the primary could have failed and the
  // fallback delivered instead, so "previous step outcome" needs both
  // channels' delivery-status vocabularies, not just the primary's.
  const previousStepChannel: PrevStepSend | null = useMemo(() => {
    let nodeId = editingNodeId !== null ? editingNodeId : addingAtSourceId;
    while (nodeId) {
      const nd = graph.nodes[nodeId];
      if (nd && nd.type === 'SEND' && nd._config) {
        const cfg = nd._config as any;
        return { channel: cfg.channel, fallbackChannel: cfg.fallbackChannel || null };
      }
      const inc = graph.edges.find((e) => e.to === nodeId);
      nodeId = inc ? inc.from : null;
    }
    return null;
  }, [editingNodeId, addingAtSourceId, graph]);

  function selectAddAt(at: DcAddingAt) {
    setAddingAt(at);
    setAddingType(null);
    setPendingConfig({});
    setEditingNodeId(null);
  }

  function pickType(t: DcNodeType) {
    setAddingType(t);
    const config = dcDefaultConfig(t, goal);
    if (t === 'EXIT') config.reason = dcDefaultExitReason(graph, addingAt);
    setPendingConfig(config);
  }

  function cancelAdd() {
    setAddingAt(null);
    setAddingType(null);
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
    // Auto-generated nodes (a Send's goal-check Split, its GOAL_EXIT, a
    // Wait Until's outcome-check Split) are created with `_config: null`
    // by design (dcConfirmAddNode) — their label/meta is hardcoded
    // directly, not form-driven. Falling back to `{}` here left every
    // field genuinely undefined, which NodeForms.tsx renders as broken
    // rather than blank (e.g. a SPLIT's `p.basis === 'Goal reached'`
    // check silently fails and misroutes into the empty Custom-condition
    // branch). dcDefaultConfig gives a type-correct, sensibly-prefilled
    // starting point instead — exactly the shape a brand-new node of
    // this type would start from.
    setPendingConfig(node._config ? structuredClone(node._config) : dcDefaultConfig(node.type, goal));
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
  function removeGoalCheck(nodeId: string) {
    pushGraph(dcRemoveGoalCheck(graph, nodeId));
  }

  const isEntry = graph.rootId === null;
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
    return {
      name,
      description,
      goal: cleanGoal,
      controlPct: Number(controlPct),
      issuer,
      applyToAllPrograms,
      programs,
      startDate,
      endDate,
      allowReEntry,
      reEntryCooloffDuration: Number(reEntryCooloffDuration),
      reEntryCooloffUnit,
      guardrails: { dnc, npa },
      status,
      root: graph,
    };
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
      <WizardStepper current={step} onNavigate={setStep} onBack={onBack} isStepComplete={isStepComplete} isEditing={!!initial} />

      <div className="dcb-main">
        {step === 'basicDetails' && (
          <div className="dcb-step-body">
            <BasicDetailsStep
              name={name}
              onNameChange={setName}
              description={description}
              onDescriptionChange={setDescription}
              issuer={issuer}
              onIssuerChange={setIssuer}
              applyToAllPrograms={applyToAllPrograms}
              onApplyToAllProgramsChange={setApplyToAllPrograms}
              programs={programs}
              onProgramsChange={setPrograms}
              controlPct={controlPct}
              onControlPctChange={setControlPct}
              allowReEntry={allowReEntry}
              onAllowReEntryChange={setAllowReEntry}
              reEntryCooloffDuration={reEntryCooloffDuration}
              onReEntryCooloffDurationChange={setReEntryCooloffDuration}
              reEntryCooloffUnit={reEntryCooloffUnit}
              onReEntryCooloffUnitChange={setReEntryCooloffUnit}
              startDate={startDate}
              onStartDateChange={setStartDate}
              endDate={endDate}
              onEndDateChange={setEndDate}
              onSaveDraft={() => onSaveDraft(buildPayload('DRAFT'))}
              onContinue={() => setStep('goalDefinition')}
            />
          </div>
        )}

        {step === 'goalDefinition' && (
          <div className="dcb-step-body">
            <GoalDefinitionStep goal={goal} onGoalChange={setGoal} onSaveDraft={() => onSaveDraft(buildPayload('DRAFT'))} onContinue={() => setStep('builder')} />
          </div>
        )}

        {step === 'builder' && (
          <>
            <div className="dcb-builder-topbar">
              <button className="btn secondary small" disabled={!canUndo} onClick={() => setHistoryIndex((i) => Math.max(0, i - 1))} title="Undo">
                <Icon name="undo" /> Undo
              </button>
              <button className="btn secondary small" disabled={!canRedo} onClick={() => setHistoryIndex((i) => Math.min(history.length - 1, i + 1))} title="Redo">
                <Icon name="redo" /> Redo
              </button>
              <div className="dcb-builder-topbar-spacer" />
              <button className="btn primary" onClick={() => setStep('guardrails')}>
                Continue to Guardrails →
              </button>
            </div>
            <BuilderStep
              graph={graph}
              onAddEntry={() => selectAddAt({ kind: 'root' })}
              onEditNode={openEditNode}
              onRemoveRoot={removeRoot}
              onReplaceAuto={replaceAuto}
              onRemoveEdge={removeEdge}
              onAddAtEdge={(edgeId) => selectAddAt({ kind: 'edge', edgeId })}
              onAddAtGrowLeaf={(nodeId) => selectAddAt({ kind: 'growLeaf', nodeId })}
              onAddAtMidEdge={(edgeId) => selectAddAt({ kind: 'midEdge', edgeId })}
              onRemoveGoalCheck={removeGoalCheck}
            />
          </>
        )}

        {step === 'guardrails' && (
          <div className="dcb-step-body">
            <GuardrailsStep
              dnc={dnc}
              onDncChange={setDnc}
              npa={npa}
              onNpaChange={setNpa}
              onSaveDraft={() => onSaveDraft(buildPayload('DRAFT'))}
              onContinue={() => setStep('review')}
            />
          </div>
        )}

        {step === 'review' && (
          <div className="dcb-step-body">
            <ReviewStep
              name={name}
              description={description}
              issuer={issuer}
              applyToAllPrograms={applyToAllPrograms}
              programs={programs}
              controlPct={controlPct}
              startDate={startDate}
              endDate={endDate}
              allowReEntry={allowReEntry}
              reEntryCooloffDuration={reEntryCooloffDuration}
              reEntryCooloffUnit={reEntryCooloffUnit}
              dnc={dnc}
              npa={npa}
              goal={goal}
              graph={graph}
              validationMessage={validationMessage}
              onSaveDraft={() => onSaveDraft(buildPayload('DRAFT'))}
              onSubmit={handleSubmitClick}
            />
          </div>
        )}
      </div>

      <AddEditDrawer
        open={drawerOpen}
        isEditing={editingNodeId !== null}
        isEntry={isEntry}
        isMidEdge={addingAt?.kind === 'midEdge'}
        types={isEntry ? DC_ENTRY_TYPES : ALL_STEP_TYPES}
        disabledTypes={isEntry ? undefined : disabledTypes}
        selectedType={addingType}
        pendingConfig={pendingConfig}
        onConfigChange={(patch) => setPendingConfig((p: any) => ({ ...p, ...patch }))}
        onPickType={pickType}
        onCancel={editingNodeId !== null ? cancelEdit : cancelAdd}
        onConfirm={editingNodeId !== null ? confirmEditNode : confirmAddNode}
        goal={goal}
        entryEventCategory={entryEventCategory}
        previousStepChannel={previousStepChannel}
        onGoToGoal={() => {
          cancelEdit();
          setStep('goalDefinition');
        }}
      />
    </div>
  );
}
