// Campaign Designer: canvas first.
//
// The campaign fills the screen: the entry on top, one column per behavioural
// bucket, each bucket's journey below it. The agent's questions pop up over
// the canvas. The chat on the right carries the conversation and a cue card
// that points at the canvas. No stages, no approvals: questions, then the
// whole campaign in one go, then changes by asking in the chat.
import { useEffect, useMemo, useRef, useState } from 'react';
import { MoreHorizontal, RotateCcw, X } from 'lucide-react';
import type { KnowledgeBase, Tenant } from '../types';
import { fetchCampaign, runAgentStream } from './api';
import { CampaignCanvas } from './CampaignCanvas';
import { buildCanvasModel, diffChangedSteps, type CStep } from './canvasModel';
import { ChatPanel, type Cue } from './ChatPanel';
import { mergeEvent } from './logic';
import { NodeDrawer } from './NodeDrawer';
import { QuestionOverlay } from './QuestionOverlay';
import { FLAG_LABELS, FLAG_ORDER, type AgentState, type PlanFile, type V2Event, type V2Turn } from './types';
import '../designer.css';
import './v2.css';

const STORE_KEY = 'cd-v3-session';
const EMPTY_PLAN: PlanFile = { brief: { findings: [] }, campaign: null, buckets: [] };

/** The browser keeps the conversation only. The campaign itself is on the server. */
const withoutCampaign = (s: AgentState | null): AgentState | null => (s ? { ...s, planFile: EMPTY_PLAN } : null);

interface Stored {
  sessionId: string;
  tenantId: string;
  turns: V2Turn[];
  state: AgentState | null;
  changed?: string[];
  lastBuilt?: boolean;
}

function loadStored(): Stored | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}

function saveStored(s: Stored) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* storage full or blocked: the session still works for this page load */
  }
}

const newId = () => `cv-${Date.now().toString(36)}`;

export function DesignerV2({ knowledge, tenant }: { knowledge: KnowledgeBase; tenant: Tenant }) {
  const stored = useMemo(loadStored, []);
  const fresh = stored?.tenantId === tenant.tenantId ? stored : null;
  const [sessionId, setSessionId] = useState(fresh?.sessionId ?? newId());
  const [turns, setTurns] = useState<V2Turn[]>(fresh?.turns ?? []);
  const [state, setState] = useState<AgentState | null>(withoutCampaign(fresh?.state ?? null));
  // The campaign as saved on the server for this chat.
  const [campaign, setCampaign] = useState<PlanFile | null>(null);
  useEffect(() => {
    let live = true;
    fetchCampaign(sessionId)
      .then((c) => live && setCampaign((cur) => cur ?? c))
      .catch(() => {
        /* offline: the canvas stays empty until the next turn */
      });
    return () => {
      live = false;
    };
  }, [sessionId]);
  const [changed, setChanged] = useState<string[]>(fresh?.changed ?? []);
  const [lastBuilt, setLastBuilt] = useState(!!fresh?.lastBuilt);
  const [live, setLive] = useState<V2Event[]>([]);
  const [livePlan, setLivePlan] = useState<PlanFile | null>(null);
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const [pulse, setPulse] = useState(0);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [activity, setActivity] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    saveStored({ sessionId, tenantId: tenant.tenantId, turns, state, changed, lastBuilt });
  }, [sessionId, tenant.tenantId, turns, state, changed, lastBuilt]);

  const plan = livePlan ?? campaign;
  const changedSet = useMemo(() => new Set(changed), [changed]);
  const model = useMemo(() => buildCanvasModel(plan), [plan]);
  const sends = model.nodes.filter((n) => n.data.kind === 'send').length;
  const buckets = plan?.buckets.length ?? 0;

  const send = (text: string, opts: { answers?: Record<string, string>; skipped?: string[] } = {}) => {
    if (busy || !text.trim()) return;
    const before = campaign;
    const next: V2Turn[] = [...turns, { role: 'user', content: text }];
    setTurns(next);
    setLive([]);
    setLivePlan(null);
    setDrawerId(null);
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let events: V2Event[] = [];
    runAgentStream(
      {
        sessionId,
        tenantId: tenant.tenantId,
        knowledge,
        messages: next.filter((t) => !t.error).map((t) => ({ role: t.role, content: t.content })),
        state,
        answers: opts.answers,
        skipped: opts.skipped,
      },
      {
        onEvent: (e) => {
          if (e.type === 'state.updated') {
            const pf = (e.data as { planFile?: PlanFile } | undefined)?.planFile;
            if (pf) setLivePlan(pf);
            return;
          }
          events = mergeEvent(events, e);
          setLive(events);
        },
        onResult: (r) => {
          const diff = diffChangedSteps(before, r.state.planFile);
          setCampaign(r.state.planFile);
          setState(withoutCampaign(r.state));
          setLivePlan(null);
          setChanged([...diff]);
          setLastBuilt(!!r.graph);
          setTurns((t) => [
            ...t,
            { role: 'assistant', content: r.reply || (r.error ? '' : '…'), questions: r.questionItems, events, ...(r.error ? { error: r.errorDetail ?? r.error } : {}) },
          ]);
          setLive([]);
          setBusy(false);
        },
        onError: (m) => {
          setTurns((t) => [...t, { role: 'assistant', content: '', events, error: m }]);
          setLive([]);
          setLivePlan(null);
          setBusy(false);
        },
      },
      ctrl.signal,
    );
  };

  const reset = () => {
    abortRef.current?.abort();
    setSessionId(newId());
    setTurns([]);
    setState(null);
    setCampaign(null);
    setChanged([]);
    setLastBuilt(false);
    setLive([]);
    setLivePlan(null);
    setBusy(false);
    setDrawerId(null);
  };

  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant');
  const openIds = new Set((state?.questions ?? []).filter((q) => !q.answer?.trim()).map((q) => q.id));
  const formQuestions = busy ? [] : (lastAssistant?.questions ?? []).filter((q) => openIds.has(q.id));
  const built = !!state?.flags.campaignBuilt;

  const showMe = () => {
    const first = model.nodes.find((n) => changedSet.has(n.id));
    if (first) setFocus({ id: first.id, n: Date.now() });
  };
  const viewAll = () => setFocus({ id: '__fit__', n: Date.now() });

  let cue: Cue | null = null;
  if (busy) {
    cue = {
      icon: 'busy',
      title: buckets ? 'Designing your campaign' : 'Working',
      text: buckets ? `${buckets} bucket${buckets === 1 ? '' : 's'} on the canvas so far. Watch them fill in.` : 'Reading what you said and checking what the platform supports.',
    };
  } else if (formQuestions.length) {
    cue = {
      icon: 'q',
      title: `${formQuestions.length} question${formQuestions.length === 1 ? '' : 's'} waiting`,
      text: "They're on the canvas. Answer what you know, or skip and I'll assume.",
      action: { label: 'Go to questions', run: () => setPulse((p) => p + 1) },
    };
  } else if (lastBuilt && changed.length) {
    cue = {
      icon: 'ok',
      title: 'Change applied and rebuilt',
      text: `Only what you asked about changed (${changed.length} step${changed.length === 1 ? '' : 's'}). It's highlighted on the canvas.`,
      action: { label: 'Show me', run: showMe },
    };
  } else if (lastBuilt && built) {
    cue = {
      icon: 'ok',
      title: 'Your campaign is ready',
      text: `${buckets} bucket${buckets === 1 ? '' : 's'} · ${sends} message${sends === 1 ? '' : 's'}. Ask here to change anything.`,
      action: { label: 'View campaign', run: viewAll },
    };
  }

  const drawerNode = drawerId ? model.nodes.find((n) => n.id === drawerId) : null;
  const drawerBucket = drawerNode ? plan?.buckets.find((b) => b.id === drawerNode.data.lane)?.name ?? 'Everyone else' : '';
  const opening = turns.find((t) => t.role === 'user')?.content;
  const hasCanvas = model.nodes.length > 0;

  return (
    <div className="cv-wrap">
      <header className="cv-top">
        <div className="cv-title">
          <b>{plan?.campaign?.name || 'New campaign'}</b>
          <span className="cv-sub">
            {opening ? `“${opening.length > 80 ? `${opening.slice(0, 80)}…` : opening}” · ` : ''}
            {tenant.displayName}
          </span>
        </div>
        <span
          className={`cv-wh${tenant.warehouseAccess ? ' on' : ''}`}
          title={tenant.warehouseAccess ? "Buckets are built and sized from this bank's data" : "No data warehouse for this bank: buckets are hypotheses from your answers and the agent's knowledge"}
        >
          Data warehouse: {tenant.warehouseAccess ? 'on' : 'off'}
        </span>
        <span className="cv-top-gap" />
        <button className="cv-btn" onClick={() => setActivity((v) => !v)}>
          <MoreHorizontal size={14} /> Activity
        </button>
        <button className="cv-btn" onClick={reset} title="Start a new campaign">
          <RotateCcw size={14} /> New chat
        </button>
      </header>

      <div className="cv-main">
        <section className="cv-stage">
          {hasCanvas ? (
            <CampaignCanvas planFile={plan} changed={changedSet} focus={focus} onOpenNode={setDrawerId} />
          ) : (
            <div className="cv-canvas-empty dc-graph-wrap">
              <div>
                <b>{busy ? 'Getting started…' : 'Your campaign will appear here'}</b>
                <p>The entry, one column per customer bucket, and each bucket's messages, laid out as a flow.</p>
              </div>
            </div>
          )}

          {formQuestions.length > 0 && (
            <QuestionOverlay
              key={formQuestions.map((q) => q.id).join(',')}
              intro={lastAssistant?.content ?? ''}
              questions={formQuestions}
              pulse={pulse}
              onSubmit={(message, answers, skipped) => send(message, { answers, skipped })}
            />
          )}

          {built && !busy && !formQuestions.length && !drawerNode && !activity && (
            <div className="cv-ready">
              <b>✓ Campaign ready</b>
              <span>
                {buckets} bucket{buckets === 1 ? '' : 's'} · {sends} message{sends === 1 ? '' : 's'}
                {lastBuilt && changed.length ? ` · ${changed.length} step${changed.length === 1 ? '' : 's'} changed in chat (highlighted)` : ''}. Want a change? Ask in the chat.
              </span>
            </div>
          )}

          {drawerNode?.data.step && <NodeDrawer step={drawerNode.data.step as CStep} bucketName={drawerBucket} onClose={() => setDrawerId(null)} />}

          {activity && <ActivityDrawer state={state} onClose={() => setActivity(false)} />}
        </section>

        <ChatPanel
          turns={turns}
          live={live}
          busy={busy}
          cue={cue}
          placeholder={formQuestions.length ? 'Or reply in your own words…' : built ? 'Ask for a change…' : 'Message the agent…'}
          onSend={(t) => send(t)}
        />
      </div>
    </div>
  );
}

function ActivityDrawer({ state, onClose }: { state: AgentState | null; onClose: () => void }) {
  return (
    <aside className="cv-drawer cv-activity" aria-label="Activity">
      <header>
        <b>Activity</b>
        <button className="cv-icon-btn" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </header>
      <div className="cv-flags">
        {FLAG_ORDER.map((f) => (
          <span key={f} className={`cv-flag${state?.flags[f] ? ' on' : ''}`}>
            {state?.flags[f] ? '✓' : '○'} {FLAG_LABELS[f]}
          </span>
        ))}
      </div>
      {state?.timeline.length ? (
        <ol className="cv-timeline">
          {[...state.timeline].reverse().map((t, i) => (
            <li key={i} className={t.actor}>
              <span className="cv-tl-actor">{t.actor}</span>
              <span>{t.note}</span>
              <span className="v2-muted">{new Date(t.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="v2-muted">Nothing has happened yet.</p>
      )}
    </aside>
  );
}
