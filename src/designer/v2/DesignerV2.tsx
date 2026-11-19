// Campaign Designer: canvas first.
//
// The campaign fills the screen: the entry on top, one column per behavioural
// bucket, each bucket's journey below it. The agent's questions pop up over
// the canvas. The chat on the right carries the conversation and a cue card
// that points at the canvas. No stages, no approvals: questions, then the
// whole campaign in one go, then changes by asking in the chat.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Copy, Eye, MoreHorizontal, Trash2, X } from 'lucide-react';
import type { KnowledgeBase, Tenant } from '../types';
import { apiUrl } from '../api';
import { CostPanel } from './CostPanel';
import { directEdit, fetchProblems, fetchStores, getVersion, listVersions, restoreVersion, runAgentStream, withdrawCampaign, copyCampaign, submitCampaignApi, runBucketSizing, fetchOffers, fetchCost, type CostReportView, type Offer, type Stores, type Submission, type Withdrawal } from './api';
import { fetchLinks, type BankLink } from '../LinksSection';
import { EditPopover, breadcrumb, type DirectOp } from './EditPopover';
import { VersionMenu } from './VersionMenu';
import type { CdNodeData, EditApi } from './canvasNodes';
import { CampaignCanvas } from './CampaignCanvas';
import { buildCanvasModel, classifyChanges, diffChangedSteps, type CStep } from './canvasModel';
import { ChatPanel, type Cue } from './ChatPanel';
import { mergeEvent, plainText } from './logic';
import { STAGE_LABEL, submittedStage } from './lifecycle';
import { NodeDrawer } from './NodeDrawer';
import { QuestionOverlay } from './QuestionOverlay';
import { FLAG_LABELS, FLAG_ORDER, type AgentState, type CampaignContext, type CampaignObject, type AnswerItem, type Focus, type V2Event, type V2Turn, type VersionEntry } from './types';
import '../designer.css';
import './v2.css';

const STORE_KEY = 'cd-v3-session';
const EMPTY_CAMPAIGN: CampaignObject = { goal: null, entry: null, membership: null, buckets: [], everyoneElse: null };
const EMPTY_CONTEXT: CampaignContext = { entries: [] };

/** The browser keeps the conversation only. The campaign object and its context live on the server. */
const withoutCampaign = (s: AgentState | null): AgentState | null => (s ? { ...s, campaign: EMPTY_CAMPAIGN, context: EMPTY_CONTEXT } : null);

/** One campaign's chat, saved on the server next to the campaign (chat.json). */
export interface Stored {
  sessionId: string;
  tenantId: string;
  turns: V2Turn[];
  state: AgentState | null;
  changed?: string[];
  /** The block the last change was pointed at, to tell "what you asked" from knock-on changes. */
  changeFocus?: Focus | null;
  /** The last problem set an automatic fix was started for, so it runs once. */
  repairKey?: string;
  lastBuilt?: boolean;
}

/** The chat for one campaign, from the server. Falls back to the copy this browser kept before chats were saved on the server. */
export async function loadChat(sessionId: string): Promise<Stored | null> {
  try {
    const res = await fetch(apiUrl(`/api/campaign/chat?sessionId=${encodeURIComponent(sessionId)}`));
    const chat = res.ok ? ((await res.json()) as { chat?: Stored | null }).chat : null;
    if (chat) return chat;
  } catch {
    /* offline: try the local copy */
  }
  try {
    const legacy = JSON.parse(localStorage.getItem(STORE_KEY) || 'null') as Stored | null;
    return legacy?.sessionId === sessionId ? legacy : null;
  } catch {
    return null;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
/** Saves the chat on the server (debounced): the campaign reopens exactly as it was left. */
function saveChat(s: Stored) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fetch(apiUrl('/api/campaign/chat'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: s.sessionId, tenantId: s.tenantId, chat: s }) }).catch(() => undefined);
  }, 600);
}

/** Drops a pending chat save, so a deleted campaign is not written back. */
function cancelChatSave() {
  clearTimeout(saveTimer);
}

/** "20 Nov" (or "20 Nov 2027" outside this year) from "2026-11-20". */
const fmtShortDay = (d: string) => {
  const dt = new Date(`${d}T00:00:00Z`);
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...(dt.getUTCFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}), timeZone: 'UTC' });
};

export const newCampaignId = () => `cv-${Date.now().toString(36)}`;

export function DesignerV2({ knowledge, tenant, sessionId, initial, onBack }: { knowledge: KnowledgeBase; tenant: Tenant; sessionId: string; initial: Stored | null; onBack: () => void }) {
  const fresh = initial;
  const [turns, setTurns] = useState<V2Turn[]>(fresh?.turns ?? []);
  const [state, setState] = useState<AgentState | null>(withoutCampaign(fresh?.state ?? null));
  // The campaign object and its context, as saved on the server for this chat.
  const [stores, setStores] = useState<Stores>({ campaign: null, context: null });
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [lastWithdrawal, setLastWithdrawal] = useState<Withdrawal | null>(null);
  const [withdrawing, setWithdrawing] = useState<'ask' | 'busy' | string | null>(null);
  const [submitting, setSubmitting] = useState<'ask' | 'busy' | string | null>(null);
  const pauseLabel = 'Stop campaign';
  const [subStart, setSubStart] = useState('');
  const [subEnd, setSubEnd] = useState('');
  useEffect(() => {
    let live = true;
    fetchStores(sessionId)
      .then(({ submission: sub, lastWithdrawal: lw, ...st }) => {
        if (!live) return;
        setSubmission(sub);
        setLastWithdrawal(lw);
        setStores((cur) => (cur.campaign || cur.context ? cur : st));
      })
      .catch(() => {
        /* offline: the canvas stays empty until the next turn */
      });
    return () => {
      live = false;
    };
  }, [sessionId]);
  const [changed, setChanged] = useState<string[]>(fresh?.changed ?? []);
  const [lastBuilt, setLastBuilt] = useState(!!fresh?.lastBuilt);
  const [changeFocus, setChangeFocus] = useState<Focus | null>(fresh?.changeFocus ?? null);
  const [repairKey, setRepairKey] = useState<string>(fresh?.repairKey ?? '');
  // The bank's link registry: where each message's link really goes.
  const [links, setLinks] = useState<BankLink[]>([]);
  const [offers, setOffers] = useState<Offer[]>([]);
  // Potential spend on offers: worked out by the server whenever the campaign changes.
  const [cost, setCost] = useState<CostReportView | null>(null);
  const [costOpen, setCostOpen] = useState<{ bucketId?: string } | null>(null);
  useEffect(() => {
    if (!stores.campaign) return setCost(null);
    let live = true;
    fetchCost(sessionId, tenant.tenantId).then((r) => live && setCost(r));
    return () => {
      live = false;
    };
  }, [stores.campaign, stores.context, sessionId, tenant.tenantId]);
  // The bank's delivery setting: undelivered WhatsApp goes again by SMS.
  const [smsFallback, setSmsFallback] = useState(true);
  useEffect(() => {
    fetchLinks(tenant.tenantId).then(setLinks).catch(() => setLinks([]));
    fetchOffers(tenant.tenantId).then(setOffers).catch(() => setOffers([]));
    fetch(apiUrl(`/api/bank-settings?tenantId=${encodeURIComponent(tenant.tenantId)}`))
      .then((r) => r.json())
      .then((d: { settings?: { smsFallback?: boolean } }) => setSmsFallback(d.settings?.smsFallback !== false))
      .catch(() => undefined);
  }, [tenant.tenantId]);
  // Point-and-edit: the box being edited.
  const [editing, setEditing] = useState<{ nodeId: string; data: CdNodeData } | null>(null);
  // Versions of the campaign object; viewing one makes the canvas read-only.
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [viewing, setViewing] = useState<{ v: VersionEntry; campaign: Stores['campaign']; changed: Set<string> } | null>(null);
  const refreshVersions = () => listVersions(sessionId).then(setVersions).catch(() => undefined);
  useEffect(() => {
    refreshVersions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
  const [live, setLive] = useState<V2Event[]>([]);
  const [liveStores, setLiveStores] = useState<Stores | null>(null);
  const [busy, setBusy] = useState(false);
  const [focus, setFocus] = useState<{ id: string; n: number } | null>(null);
  const [pulse, setPulse] = useState(0);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [activity, setActivity] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<'ask' | 'deleting' | string | null>(null);
  const deleteCampaign = async () => {
    setConfirmDelete('deleting');
    cancelChatSave();
    try {
      const r = await fetch(apiUrl(`/api/campaign?sessionId=${encodeURIComponent(sessionId)}&tenantId=${encodeURIComponent(tenant.tenantId)}`), { method: 'DELETE' });
      const d = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      // A campaign never saved (no chat yet) has nothing on file: leaving is enough.
      if (r.ok || d.error === 'No such campaign.') return onBack();
      setConfirmDelete(d.error || 'Could not delete the campaign.');
    } catch {
      setConfirmDelete('Could not reach the server.');
    }
  };
  const abortRef = useRef<AbortController | null>(null);
  // Opened from a signed view link (?view=…): this one campaign, read-only.
  const viewOnly = useMemo(() => new URLSearchParams(location.search).has('view'), []);
  const locked = !!submission || viewOnly;
  // The password page, then back to this same campaign, editable.
  const loginToEdit = useMemo(() => {
    const base = import.meta.env.BASE_URL.replace(/\/$/, '');
    const back = `${base}/designer.html?c=${encodeURIComponent(sessionId)}&bank=${encodeURIComponent(tenant.tenantId)}`;
    return `${base}/login?next=${encodeURIComponent(back)}`;
  }, [sessionId, tenant.tenantId]);
  const viewExpiry = useMemo(() => {
    const exp = Number((new URLSearchParams(location.search).get('view') ?? '').split('.')[0]);
    return exp ? new Date(exp * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';
  }, []);

  useEffect(() => {
    if (!turns.length || viewOnly) return; // nothing to keep until the chat has started; a view never writes
    saveChat({ sessionId, tenantId: tenant.tenantId, turns, state, changed, changeFocus, lastBuilt, repairKey });
  }, [sessionId, tenant.tenantId, turns, state, changed, changeFocus, lastBuilt, repairKey]);

  const shown = viewing ? { campaign: viewing.campaign, context: stores.context } : (liveStores ?? stores);
  const plan = shown.campaign;
  const changedSet = useMemo(() => (viewing ? classifyChanges(viewing.changed, null) : classifyChanges(changed, changeFocus)), [viewing, changed, changeFocus]);
  const model = useMemo(() => buildCanvasModel(plan, shown.context, changedSet), [plan, shown.context, changedSet]);
  const sends = model.nodes.filter((n) => n.data.kind === 'send').length;
  const buckets = plan?.buckets.length ?? 0;

  const send = (text: string, opts: { answers?: Record<string, string>; skipped?: string[]; answerSet?: AnswerItem[]; focus?: Focus; focusLabel?: string; repair?: boolean } = {}) => {
    if (busy || !text.trim() || viewing || locked) return;
    const before = stores.campaign;
    const next: V2Turn[] = [
      ...turns,
      {
        role: 'user',
        content: text,
        ...(opts.answerSet ? { answerSet: opts.answerSet } : {}),
        ...(opts.focus ? { focus: opts.focus, focusLabel: opts.focusLabel } : {}),
        ...(opts.repair ? { auto: true } : {}),
      },
    ];
    setTurns(next);
    setLive([]);
    setLiveStores(null);
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
        focus: opts.focus ?? null,
        repair: opts.repair ?? false,
      },
      {
        onEvent: (e) => {
          if (e.type === 'state.updated') {
            const d = e.data as Partial<Stores> | undefined;
            if (d?.campaign || d?.context) setLiveStores({ campaign: d.campaign ?? null, context: d.context ?? null });
            return;
          }
          events = mergeEvent(events, e);
          setLive(events);
        },
        onResult: (r) => {
          const diff = diffChangedSteps(before, r.state.campaign);
          setStores({ campaign: r.state.campaign, context: r.state.context });
          setState(withoutCampaign(r.state));
          setLiveStores(null);
          setChanged([...diff]);
          setChangeFocus(opts.focus ?? null);
          setLastBuilt(!!r.graph);
          if (r.version) refreshVersions();
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
          setLiveStores(null);
          setBusy(false);
        },
      },
      ctrl.signal,
    );
  };

  /** After a direct edit or a restore: show the new campaign, highlight what changed, log it for the agent. */
  const applyEdit = (r: Awaited<ReturnType<typeof directEdit>>, focus: Focus | null) => {
    if (!r.ok || !r.campaign) return;
    setChanged([...diffChangedSteps(stores.campaign, r.campaign)]);
    setChangeFocus(focus);
    setStores({ campaign: r.campaign, context: r.context ?? stores.context });
    if (r.timeline) setState((s) => (s ? { ...s, timeline: [...s.timeline, r.timeline!] } : s));
    setLastBuilt(true);
    refreshVersions();
  };
  const onDirect = async (op: DirectOp) => {
    const r = await directEdit(sessionId, tenant.tenantId, op);
    applyEdit(r, editing?.data.focus ?? null);
    return { ok: r.ok, error: r.error };
  };
  const restore = async (n: number) => {
    const r = await restoreVersion(sessionId, tenant.tenantId, n);
    if (r.ok) {
      setViewing(null);
      applyEdit(r, null);
      setTurns((t) => [...t, { role: 'assistant', content: `Restored version ${n}. ${r.version ? `It is now version ${r.version.n}.` : ''}` }]);
    }
  };
  const view = async (n: number) => {
    const latest = versions[versions.length - 1]?.n;
    if (n === latest) return setViewing(null);
    const [v, prev] = await Promise.all([getVersion(sessionId, n), n > 1 ? getVersion(sessionId, n - 1) : Promise.resolve(null)]);
    if (!v) return;
    setEditing(null);
    setDrawerId(null);
    setViewing({ v, campaign: v.campaign, changed: diffChangedSteps(prev?.campaign ?? null, v.campaign) });
    setFocus({ id: '__fit__', n: Date.now() });
  };
  const undo = versions.length >= 2 ? () => restore(versions[versions.length - 2].n) : undefined;

  const editApi: EditApi = {
    editingId: editing?.nodeId ?? null,
    locked: busy || !!viewing,
    onEdit: (nodeId, data) => {
      setDrawerId(null);
      setEditing({ nodeId, data });
    },
    renderPopover: (_id, data) => (
      <EditPopover
        data={data}
        campaign={stores.campaign}
        busy={busy}
        onClose={() => setEditing(null)}
        onDirect={onDirect}
        onSend={(text) => {
          send(text, { focus: data.focus, focusLabel: breadcrumb(data, stores.campaign) });
        }}
      />
    ),
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setEditing(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // An opened campaign with hard problems (a retired link, a broken split, …)
  // gets one automatic-fix turn per problem set. The message is the app's,
  // shown as "Automatic fix", never as the manager's.
  useEffect(() => {
    if (busy || viewing || viewOnly || submission || !stores.campaign || !turns.length) return;
    let live = true;
    fetchProblems(sessionId, tenant.tenantId).then((problems) => {
      const key = problems.join('|');
      if (!live || !problems.length || key === repairKey) return;
      setRepairKey(key);
      send(
        `AUTOMATIC FIX: the app found ${problems.length === 1 ? 'a problem' : `${problems.length} problems`} in the saved campaign:\n${problems.map((p) => `- ${p}`).join('\n')}\nFix each one with the least change that works, rebuild, and say what you changed. If nothing suitable exists, ask the manager.`,
        { repair: true },
      );
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stores.campaign, links]);

  /** From a chat tag back to the box it was about. */
  const showFocus = (f: Focus) => {
    const n = model.nodes.find((x) => JSON.stringify(x.data.focus) === JSON.stringify(f));
    if (n) setFocus({ id: n.id, n: Date.now() });
  };

  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant');
  const openIds = new Set((state?.questions ?? []).filter((q) => !q.answer?.trim()).map((q) => q.id));
  const formQuestions = busy || submission || new URLSearchParams(location.search).has('view') ? [] : (lastAssistant?.questions ?? []).filter((q) => openIds.has(q.id));
  const built = !!state?.flags.campaignBuilt;

  const showMe = () => {
    const first = model.nodes.find((n) => n.data.changed);
    if (first) setFocus({ id: first.id, n: Date.now() });
  };
  const viewAll = () => setFocus({ id: '__fit__', n: Date.now() });

  let cue: Cue | null = null;
  if (busy) {
    // The one status indicator while the agent works: what it is doing right now.
    const running = [...live].reverse().find((e) => e.type === 'model.tool_call.started' || (e.type.startsWith('model.tool_call') && e.status === 'running'));
    const now = running?.title ?? (live.some((e) => e.type === 'model.text.delta') ? 'Writing its reply' : 'Thinking');
    cue = {
      icon: 'busy',
      title: `${now}…`,
      text: buckets ? `${buckets} bucket${buckets === 1 ? '' : 's'} on the canvas so far. Watch them fill in.` : 'The canvas fills in as the campaign takes shape.',
    };
  } else if (formQuestions.length) {
    cue = {
      icon: 'question',
      title: `${formQuestions.length} question${formQuestions.length === 1 ? '' : 's'} waiting`,
      text: "They're on the canvas. Answer what you know, or skip and I'll assume.",
      action: { label: 'Go to questions', run: () => setPulse((p) => p + 1) },
    };
  } else if (lastBuilt && changed.length) {
    const kinds = [...classifyChanges(changed, changeFocus).values()];
    const knock = kinds.filter((k) => k === 'knock').length;
    cue = {
      icon: 'changed',
      title: 'Change applied and rebuilt',
      text: `${kinds.length - knock} step${kinds.length - knock === 1 ? '' : 's'} you asked about${knock ? `, and ${knock} more changed as a result (in amber)` : ''}. ${versions.length ? `Saved as version ${versions[versions.length - 1].n}.` : ''}`,
      action: { label: 'Show me', run: showMe },
      ...(undo ? { secondary: { label: 'Undo this change', run: undo } } : {}),
    };
  } else if (lastBuilt && built) {
    cue = {
      icon: 'ready',
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
      {viewOnly && (
        <div className="cv-viewbar" role="note">
          <Eye size={16} />
          <b>View only</b>
          <span>You can look at this campaign but not change it.{viewExpiry ? ` This link works until ${viewExpiry}.` : ''}</span>
          <a className="cv-viewbar-login" href={loginToEdit}>
            Log in to edit
          </a>
        </div>
      )}
      <header className="cv-top">
        {!viewOnly && (
          <button className="cv-back" onClick={onBack} title="All campaigns">
            <ArrowLeft size={16} />
          </button>
        )}
        <div className="cv-title">
          <b>{plan?.name || 'New campaign'}</b>
          <span className="cv-sub">
            {opening ? `“${opening.length > 80 ? `${opening.slice(0, 80)}…` : opening}” · ` : ''}
            {tenant.displayName}
          </span>
        </div>
        {!submission && (
          <span className={`cv-state st-${state?.flags.campaignBuilt || lastBuilt ? 'ready' : 'draft'}`} title={state?.flags.campaignBuilt || lastBuilt ? 'Designed, not submitted yet' : 'Being designed'}>
            {state?.flags.campaignBuilt || lastBuilt ? 'Ready' : 'Draft'}
          </span>
        )}
        {submission && (
          <span className={`cv-submitted st-${submittedStage(submission)}`} title={`Submitted by ${submission.by} on ${new Date(submission.at).toLocaleString()}`}>
            {STAGE_LABEL[submittedStage(submission)]}{submittedStage(submission) === 'submitted' ? ' for execution' : ''}
            {submission.startDate && submission.endDate ? ` · runs ${fmtShortDay(submission.startDate)} → ${fmtShortDay(submission.endDate)}` : ''} · {submission.by}
          </span>
        )}
        {!submission && lastWithdrawal && (
          <span className="cv-withdrawn" title="Stopped: it can be changed and submitted again">
            Stopped · {new Date(lastWithdrawal.at).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} · {lastWithdrawal.by}
          </span>
        )}
        <span
          className={`cv-wh${tenant.warehouseAccess ? ' on' : ''}`}
          title={tenant.warehouseAccess ? "Live bank data access is ON: buckets are explored and sized from this bank's data" : "Live bank data access is OFF for this bank: buckets are hypotheses from your answers and the agent's knowledge"}
        >
          Live bank data access: {tenant.warehouseAccess ? 'ON' : 'OFF'}
        </span>
        <span className="cv-top-gap" />
        {versions.length > 0 && !viewOnly && <VersionMenu versions={versions} viewing={viewing?.v.n ?? null} onView={view} />}
        {!viewOnly && stores.campaign && (
          <button
            className="cv-btn"
            disabled={busy}
            title="Make an editable copy to adapt: a new season, audience or channel mix. The original stays as it is."
            onClick={async () => {
              const r = await copyCampaign(sessionId, tenant.tenantId);
              if (r.ok && r.sessionId) window.location.href = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/designer.html?c=${encodeURIComponent(r.sessionId)}&bank=${encodeURIComponent(tenant.tenantId)}`;
            }}
          >
            <Copy size={14} /> Duplicate
          </button>
        )}
        <button className="cv-btn" onClick={() => setActivity((v) => !v)}>
          <MoreHorizontal size={14} /> Activity
        </button>
        {!viewOnly && (
        <span className="cv-del-wrap">
          <button className="cv-btn cv-btn-del" disabled={busy || locked} title={busy ? 'Wait for the agent to finish' : 'Delete this campaign'} onClick={() => setConfirmDelete((v) => (v ? null : 'ask'))}>
            <Trash2 size={14} /> Delete
          </button>
          {confirmDelete && (
            <div className="cv-del-pop" role="dialog" aria-label="Delete campaign">
              <b>{plan?.name ? `Delete “${plan.name}”?` : 'Delete this campaign?'}</b>
              <p>It is removed from your campaigns, with its chat and versions.</p>
              {confirmDelete !== 'ask' && confirmDelete !== 'deleting' && <p className="cv-del-err">{confirmDelete}</p>}
              <div className="cv-del-btns">
                <button className="cv-btn" onClick={() => setConfirmDelete(null)}>
                  Cancel
                </button>
                <button className="cv-btn danger" disabled={confirmDelete === 'deleting'} onClick={deleteCampaign}>
                  {confirmDelete === 'deleting' ? 'Deleting…' : 'Delete campaign'}
                </button>
              </div>
            </div>
          )}
        </span>
        )}
        {/* The main action sits last, on the right: Submit for a ready campaign, Stop for a live one. */}
        {cost && cost.mode === 'totals' && (
          <button className="cv-est" onClick={() => setCostOpen({})} title="Potential spend on offers, as expected. Tap for the working.">
            Est. offers ₹{Math.round(cost.total.expected).toLocaleString('en-IN')}
          </button>
        )}
        {submission && !viewOnly && submittedStage(submission) !== 'ended' && (
          <span className="cv-del-wrap">
            <button className="cv-btn" onClick={() => setWithdrawing((v) => (v ? null : 'ask'))} title="Stop it: back to Ready, editable; you can submit it again">
              {pauseLabel}
            </button>
            {withdrawing && (
              <div className="cv-del-pop" role="dialog" aria-label={pauseLabel}>
                <b>{pauseLabel}?</b>
                <p>It goes back to Ready: editable, and you can submit it again with new dates. Customers' progress is not kept, so it starts fresh next time.</p>
                {withdrawing !== 'ask' && withdrawing !== 'busy' && <p className="cv-del-err">{withdrawing}</p>}
                <div className="cv-del-btns">
                  <button className="cv-btn" onClick={() => setWithdrawing(null)}>
                    Cancel
                  </button>
                  <button
                    className="cv-btn primary"
                    disabled={withdrawing === 'busy'}
                    onClick={async () => {
                      setWithdrawing('busy');
                      const r = await withdrawCampaign(sessionId, tenant.tenantId);
                      if (!r.ok) return setWithdrawing(r.error ?? 'Could not stop it.');
                      setSubmission(null);
                      setLastWithdrawal(r.withdrawal ?? null);
                      setWithdrawing(null);
                    }}
                  >
                    {withdrawing === 'busy' ? 'Working…' : pauseLabel}
                  </button>
                </div>
              </div>
            )}
          </span>
        )}
        {!submission && !viewOnly && !viewing && (state?.flags.campaignBuilt || lastBuilt) && (
          <span className="cv-del-wrap">
            <button
              className="cv-btn primary"
              disabled={busy}
              onClick={() => {
                setSubStart(stores.campaign?.schedule?.startDate ?? '');
                setSubEnd(stores.campaign?.schedule?.endDate ?? '');
                setSubmitting((v) => (v ? null : 'ask'));
              }}
            >
              Submit for execution
            </button>
            {submitting && (
              <div className="cv-del-pop" role="dialog" aria-label="Submit for execution">
                <b>Submit for execution</b>
                <p>Confirm when it runs. Once submitted it is locked; stop it to change it.</p>
                <div className="cv-pop-dates" style={{ marginTop: 8 }}>
                  <label>
                    <span>Starts</span>
                    <input type="date" value={subStart} min={new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })} onChange={(e) => setSubStart(e.target.value)} />
                  </label>
                  <label>
                    <span>Ends</span>
                    <input type="date" value={subEnd} min={subStart || undefined} onChange={(e) => setSubEnd(e.target.value)} />
                  </label>
                </div>
                {submitting !== 'ask' && submitting !== 'busy' && <p className="cv-del-err" style={{ whiteSpace: 'pre-wrap' }}>{submitting}</p>}
                <div className="cv-del-btns">
                  <button className="cv-btn" onClick={() => setSubmitting(null)}>
                    Cancel
                  </button>
                  <button
                    className="cv-btn primary"
                    disabled={submitting === 'busy' || !subStart || !subEnd}
                    onClick={async () => {
                      setSubmitting('busy');
                      const r = await submitCampaignApi(sessionId, tenant.tenantId, subStart, subEnd);
                      if (!r.ok || !r.submission) return setSubmitting(r.error ?? 'Could not submit.');
                      setSubmission(r.submission);
                      setSubmitting(null);
                      fetchStores(sessionId).then(({ campaign, context }) => setStores({ campaign, context }));
                    }}
                  >
                    {submitting === 'busy' ? 'Submitting…' : 'Submit'}
                  </button>
                </div>
              </div>
            )}
          </span>
        )}
      </header>

      <div className="cv-main">
        <section className="cv-stage">
          {hasCanvas ? (
            <CampaignCanvas
              campaign={plan}
              context={shown.context}
              changed={changedSet}
              focus={focus}
              onOpenNode={setDrawerId}
              edit={locked ? undefined : editApi}
              runSizing={viewOnly ? undefined : (bucketId) => runBucketSizing(sessionId, tenant.tenantId, bucketId)}
              onPaneClick={() => setEditing(null)}
              bankName={(tenant.issuer || tenant.displayName).replace(/\s*\(.*?\)\s*/g, '').trim()}
              links={links}
              offers={offers}
              cost={cost}
              onOpenCost={(bucketId) => { setDrawerId(null); setCostOpen({ bucketId }); }}
              smsFallback={smsFallback}
            />
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
              onSubmit={(message, answers, skipped) =>
                send(message, {
                  answers,
                  skipped,
                  answerSet: formQuestions.map((q) => ({ aspect: q.aspect, question: plainText(q.text), ...(q.why ? { why: q.why } : {}), ...(answers[q.id] ? { answer: answers[q.id] } : { skipped: true }) })),
                })
              }
            />
          )}

          {viewing && (
            <div className="cv-viewing">
              <div>
                <b>
                  Viewing version {viewing.v.n} · {new Date(viewing.v.at).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </b>
                <span>{viewing.v.summary}</span>
              </div>
              <button className="cv-btn primary" onClick={() => restore(viewing.v.n)}>
                Restore this version
              </button>
              <button className="cv-btn" onClick={() => setViewing(null)}>
                Back to current
              </button>
            </div>
          )}

          {costOpen && cost && cost.mode !== 'none' && <CostPanel report={cost} focusBucket={costOpen.bucketId} locked={locked || busy || !!viewing} onDirect={onDirect} onClose={() => setCostOpen(null)} />}
          {drawerNode?.data.step && <NodeDrawer step={drawerNode.data.step as CStep} path={drawerNode.data.path} bucketName={drawerBucket} links={links} smsFallback={smsFallback} onClose={() => setDrawerId(null)} />}

          {activity && <ActivityDrawer state={state} onClose={() => setActivity(false)} />}
        </section>

        <ChatPanel
          turns={turns}
          live={live}
          busy={busy}
          cue={locked ? null : cue}
          placeholder={viewOnly ? 'View-only link. Open the app with the password to make changes.' : submission ? 'Submitted for execution. This campaign is locked.' : viewing ? 'Viewing an old version. Go back to current to make changes.' : formQuestions.length ? 'Or reply in your own words…' : built ? 'Ask for a change, or point at any box on the canvas…' : 'Message the agent…'}
          onSend={(t) => send(t)}
          locked={!!viewing || locked}
          onShowFocus={showFocus}
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
