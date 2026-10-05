// Ported from renderDripSetupStep/renderDripBuildStep/dcSelectAddAt/
// dcPickType/dcConfigField/dcConfirmAddNode/dcConfirmEditNode/
// dcOpenEditNode/dcRemoveEdge/dcReplaceAutoNode/dcEnterConnectMode/
// dcConfirmConnectExisting/dcOpenGoalDrawer/dcConfirmGoal — the real
// create/edit builder, now a self-contained React component. Doesn't know
// about the campaigns list or persistence; emits a finished payload via
// onSaveDraft/onSubmit for whatever owns the list (Phase 4) to persist.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo, useState } from 'react';
import type { DripCampaign, DripGoal, DripGraph } from '../data/graphTypes';
import type { DcNodeType } from '../data/nodeMeta';
import { DC_ENTRY_TYPES } from '../data/typeSub';
import { PROGRAM_OPTIONS, EVENT_CATEGORIES, computeMakerCheckerFlag } from '../data/sharedConstants';
import type { Channel } from '../data/sharedConstants';
import { dcConfirmAddNode, dcConfirmEditNode, dcRemoveEdge, dcRemoveRoot, dcConnectExisting, type DcAddingAt } from '../reducer/campaignReducer';
import { dcValidMergeTargets, dcGraphHasOpenBranches } from '../reducer/graphOps';
import { dcDefaultConfig } from '../reducer/defaultConfig';
import { dcGoalLabel } from '../reducer/labelMeta';
import { DripCanvas } from '../canvas/DripCanvas';
import { AddEditDrawer } from './AddEditDrawer';
import { GoalDrawer } from './GoalDrawer';
import { ChipPicker } from '../components/ChipPicker';
import './dripBuilder.css';

const EMPTY_GRAPH: DripGraph = { nodes: {}, edges: [], rootId: null };

export interface DripBuilderPayload {
  name: string;
  goal: DripGoal | null;
  controlPct: number;
  issuer: string;
  programs: string[];
  startDate: string;
  endDate: string;
  status: 'DRAFT' | 'PENDING_REVIEW';
  root: DripGraph;
}

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
  const [step, setStep] = useState<'setup' | 'build'>(initial ? 'build' : 'setup');
  const [name, setName] = useState(initial?.name || '');
  const [issuer, setIssuer] = useState(initial?.issuer || '');
  const [programs, setPrograms] = useState<string[]>(initial?.programs || []);
  const [controlPct, setControlPct] = useState(initial?.controlPct ?? 10);
  const [startDate, setStartDate] = useState(initial?.startDate || '');
  const [endDate, setEndDate] = useState(initial?.endDate || '');
  const [goal, setGoal] = useState<DripGoal | null>(initial?.goal || null);
  const [graph, setGraph] = useState<DripGraph>(initial?.root ? structuredClone(initial.root) : EMPTY_GRAPH);
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
  const [goalDraft, setGoalDraft] = useState<DripGoal | null>(null);

  const drawerOpen = addingAt !== null || editingNodeId !== null;

  const addingAtSourceId = useMemo(() => {
    if (!addingAt) return null;
    if (addingAt.kind === 'edge') return graph.edges.find((x) => x.id === addingAt.edgeId)?.from ?? null;
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
    setGraph(next);
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
    setGraph(next);
    cancelEdit();
  }

  function removeEdge(edgeId: string) {
    setGraph((g) => dcRemoveEdge(g, edgeId));
  }
  function removeRoot() {
    setGraph((g) => dcRemoveRoot(g));
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
    setGraph((g) => dcConnectExisting(g, addingAt, connectTargetId));
    cancelAdd();
  }

  function openGoalDrawer() {
    setGoalDraft(goal ? { ...goal, conditions: [...(goal.conditions || [])] } : { eventCategory: Object.keys(EVENT_CATEGORIES)[0], eventType: '', conditions: [] });
  }

  const isEntry = graph.rootId === null;
  const connectTargets = addingAtSourceId ? dcValidMergeTargets(graph, addingAtSourceId) : [];
  const canConnect = !editingNodeId && !isEntry && !!addingAtSourceId && connectTargets.length > 0;
  const open = dcGraphHasOpenBranches(graph);
  const canSubmit = !!name && !!issuer && graph.rootId !== null && !open;

  function buildPayload(status: 'DRAFT' | 'PENDING_REVIEW'): DripBuilderPayload {
    return { name, goal, controlPct: Number(controlPct), issuer, programs, startDate, endDate, status, root: graph };
  }

  if (step === 'setup') {
    return (
      <div className="dcb-mid-inner">
        <h1 className="wiz-heading">{initial ? 'Edit Drip Campaign' : 'New Drip Campaign'}</h1>
        <p className="wiz-sub">Set identity, scope, and launch settings — you'll define the goal and build the flow next.</p>

        <div className="wiz-group-label">Identity</div>
        <div className="f-group">
          <label className="f-label">Campaign name</label>
          <input className="f-input" type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="wiz-group-label">Scope</div>
        <div className="f-row2" style={{ alignItems: 'start' }}>
          <div className="f-group">
            <label className="f-label">Issuer</label>
            <select
              className="f-input"
              value={issuer}
              onChange={(e) => {
                setIssuer(e.target.value);
                setPrograms([]);
              }}
            >
              <option value="">Select Issuer</option>
              {Object.keys(PROGRAM_OPTIONS).map((i) => (
                <option key={i}>{i}</option>
              ))}
            </select>
          </div>
          <div className="f-group">
            <label className="f-label">Program(s)</label>
            {issuer ? (
              <ChipPicker
                options={PROGRAM_OPTIONS[issuer] || []}
                selected={programs}
                onToggle={(v) => setPrograms((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]))}
              />
            ) : (
              <p className="f-hint" style={{ margin: '8px 0 0' }}>
                Select an issuer first
              </p>
            )}
          </div>
        </div>
        {issuer && computeMakerCheckerFlag(issuer, programs) && (
          <p className="f-hint" style={{ color: 'var(--warning-text)', marginTop: -8 }}>
            Maker-checker applies — this issuer/program requires a separate approver.
          </p>
        )}

        <div className="wiz-group-label">Launch Settings</div>
        <div className="f-group" style={{ maxWidth: 200 }}>
          <label className="f-label">Control Group %</label>
          <input className="f-input" type="number" min={0} max={50} value={controlPct} onChange={(e) => setControlPct(Number(e.target.value))} />
        </div>
        <div className="f-row2">
          <div className="f-group">
            <label className="f-label">Start</label>
            <input className="f-input" type="datetime-local" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="f-group">
            <label className="f-label">End</label>
            <input className="f-input" type="datetime-local" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        </div>
        <p className="f-hint" style={{ marginTop: -10 }}>
          Control Group is held back as a baseline for uplift. Leave Start blank to activate immediately once approved — a future Start holds it as Scheduled until then.
        </p>
        <p className="f-hint" style={{ background: 'var(--gray-50)', padding: '10px 12px', borderRadius: 6, marginTop: 14 }}>
          🛡 DNC and opt-outs are checked automatically before every send in this campaign — not something you configure per step, same as Nudges.
        </p>

        <div style={{ display: 'flex', gap: 10, marginTop: 32 }}>
          <button className="btn secondary" disabled={!name} onClick={() => onSaveDraft(buildPayload('DRAFT'))}>
            Save as Draft
          </button>
          <button className="btn primary" disabled={!name} onClick={() => setStep('build')}>
            Continue to Build →
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="dcb-shell">
      <div className="dcb-rail">
        <div className="add-link" onClick={onBack} style={{ marginBottom: 10 }}>
          ← Back to Drip Campaigns
        </div>
        <div className="wiz-rail-title">{name || 'Untitled Campaign'}</div>
        <div className="wiz-rail-sub">Step 2 of 2 — Build</div>
        {issuer && (
          <div className="f-group" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            <span className="badge gray">{issuer}</span>
          </div>
        )}
        <div className="add-link" style={{ marginBottom: 14 }} onClick={() => setStep('setup')}>
          Edit Setup
        </div>
        <hr className="dcb-hr" />
        <div className="f-group">
          <label className="f-label">Goal</label>
          {goal ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              <span className="badge success">{dcGoalLabel(goal)}</span>
              <span style={{ fontSize: 11, color: 'var(--gray-500)' }}>{goal.eventCategory}</span>
            </div>
          ) : (
            <p className="f-hint" style={{ margin: '0 0 8px' }}>
              Not set yet — a milestone-style campaign can legitimately have none.
            </p>
          )}
          <button className="btn secondary small" style={{ width: '100%' }} onClick={openGoalDrawer}>
            {goal ? 'Change Goal' : 'Define Goal'}
          </button>
        </div>
        <hr className="dcb-hr" />
        {graph.rootId === null ? (
          <p className="f-hint">
            Click <b>+ Add Entry</b> on the canvas to choose how customers enter this campaign.
          </p>
        ) : (
          <>
            <p className="f-hint">
              Click any <b>+</b> on the canvas to add the next step. Every branch needs to end in a Goal-Based Exit or Exit before this campaign is ready to submit for approval — saving as a draft has no such requirement.
            </p>
            {open && (
              <p className="f-hint" style={{ color: 'var(--warning-text)', fontWeight: 600 }}>
                ⚠ Open branches remaining — fine to save as a draft, blocks submission.
              </p>
            )}
            <StepsOutline graph={graph} />
          </>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
          <button className="btn secondary" style={{ flex: 1 }} disabled={!name} onClick={() => onSaveDraft(buildPayload('DRAFT'))}>
            Save as Draft
          </button>
          <button className="btn primary" style={{ flex: 1 }} disabled={!canSubmit} onClick={() => onSubmit(buildPayload('PENDING_REVIEW'))}>
            Submit for Approval
          </button>
        </div>
      </div>
      <div className="dcb-canvas">
        <DripCanvas
          graph={graph}
          editable
          onAddEntry={() => selectAddAt({ kind: 'root' })}
          onEditNode={openEditNode}
          onRemoveRoot={removeRoot}
          onReplaceAuto={replaceAuto}
          onRemoveEdge={removeEdge}
          onAddAtEdge={(edgeId) => selectAddAt({ kind: 'edge', edgeId })}
          onAddAtGrowLeaf={(nodeId) => selectAddAt({ kind: 'growLeaf', nodeId })}
        />
      </div>

      <AddEditDrawer
        open={drawerOpen}
        isEditing={editingNodeId !== null}
        isEntry={isEntry}
        types={isEntry ? DC_ENTRY_TYPES : (['SEND', 'CHANNEL_FAILOVER', 'PAUSE', 'WAIT_UNTIL', 'SPLIT', 'DECISION_SPLIT', 'RANDOM_SPLIT', 'GOAL_EXIT', 'EXIT'] as DcNodeType[])}
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

      {goalDraft && (
        <GoalDrawer
          open={!!goalDraft}
          draft={goalDraft}
          onChange={(patch) => setGoalDraft((g) => (g ? { ...g, ...patch } : g))}
          onCancel={() => setGoalDraft(null)}
          onSave={() => {
            setGoal(goalDraft ? { ...goalDraft, conditions: [...goalDraft.conditions] } : null);
            setGoalDraft(null);
          }}
        />
      )}
    </div>
  );
}

function StepsOutline({ graph }: { graph: DripGraph }) {
  if (!graph.rootId) return null;
  const steps: string[] = [];
  const visited = new Set<string>();
  (function walk(nodeId: string) {
    if (visited.has(nodeId)) return;
    visited.add(nodeId);
    const node = graph.nodes[nodeId];
    if (!node) return;
    if (node.type === 'SEND' || node.type === 'CHANNEL_FAILOVER') steps.push(node.label);
    graph.edges.filter((e) => e.from === nodeId && e.to).forEach((e) => walk(e.to!));
  })(graph.rootId);
  if (!steps.length) return null;
  return (
    <>
      <div className="wiz-group-label" style={{ margin: '16px 0 6px' }}>
        Steps so far
      </div>
      <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, color: 'var(--neutral-800)', lineHeight: 1.9 }}>
        {steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
    </>
  );
}
