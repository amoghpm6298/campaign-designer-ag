// Campaign Designer: canvas first.
//
// The campaign fills the screen: the entry on top, one column per behavioural
// bucket, each bucket's journey below it. The agent's questions pop up over
// the canvas. The chat on the right carries the conversation and a cue card
// that points at the canvas. No stages, no approvals: questions, then the
// whole campaign in one go, then changes by asking in the chat.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Copy, Eye, History, ListChecks, Trash2, X } from 'lucide-react';
import type { KnowledgeBase, Tenant } from '../types';
import { apiUrl } from '../api';
import { CostPanel } from './CostPanel';
import { StrategyPanel, type StrategyNote } from './StrategyPanel';
import { currentEntries as currentNotes } from './contextView';
import { FileText, Route, ShieldCheck } from 'lucide-react';
import type { ApprovalRecordView } from '../CommApprovalsView';
import { directEdit, fetchProblems, fetchStores, getVersion, listVersions, restoreVersion, runAgentStream, withdrawCampaign, copyCampaign, convertToFlowApi, type ConversionView, submitCampaignApi, runBucketSizing, fetchOffers, fetchCost, fetchFields, type CostReportView, type FieldSampleView, type Offer, type Stores, type Submission, type Withdrawal } from './api';
import { fetchLinks, type BankLink } from '../LinksSection';
import { EditPopover, breadcrumb, type DirectOp } from './EditPopover';
import { VersionMenu } from './VersionMenu';
import { MoreMenu } from './MoreMenu';
import { intentLabel, pendingIntent, setPendingIntent, type IntentChoice } from './intent';
import type { CdNodeData, EditApi } from './canvasNodes';
import { CampaignCanvas } from './CampaignCanvas';
import { buildCanvasModel, classifyChanges, diffChangedSteps, type CStep } from './canvasModel';
import { ChatPanel, type Cue } from './ChatPanel';
import { mergeEvent, plainText } from './logic';
import { SourcesContext, sourcesFromEntries } from './Citations';
import { submittedStage } from './lifecycle';
import { KIND_LABEL, isKind, kindOf, type CampaignKind } from './kind';
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


export const newCampaignId = () => `cv-${Date.now().toString(36)}`;

/** "₹1.4L", "₹18k" (below a lakh: the nearest thousand), "₹2.3Cr": a rounded figure for the canvas button; the exact one is in its tooltip and the cost view. */
const roundInr = (n: number) => (n >= 1e7 ? `₹${Math.round(n / 1e6) / 10}Cr` : n >= 1e5 ? `₹${Math.round(n / 1e4) / 10}L` : n >= 1e3 ? `₹${Math.round(n / 1000)}k` : `₹${Math.round(n)}`);

export function DesignerV2({ knowledge, tenant, sessionId, initial, onBack }: { knowledge: KnowledgeBase; tenant: Tenant; sessionId: string; initial: Stored | null; onBack: () => void }) {
  const fresh = initial;
  const [turns, setTurns] = useState<V2Turn[]>(fresh?.turns ?? []);
  const [state, setState] = useState<AgentState | null>(withoutCampaign(fresh?.state ?? null));
  // The campaign object and its context, as saved on the server for this chat.
  const [stores, setStores] = useState<Stores>({ campaign: null, context: null });
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [lastWithdrawal, setLastWithdrawal] = useState<Withdrawal | null>(null);
  // The flows this campaign became (Convert to flow), and the Convert box: its name and the note for the designer.
  const [conversions, setConversions] = useState<ConversionView[]>([]);
  const [converting, setConverting] = useState<'ask' | 'busy' | string | null>(null);
  const [convName, setConvName] = useState('');
  const [convNote, setConvNote] = useState('');
  const [withdrawing, setWithdrawing] = useState<'ask' | 'busy' | string | null>(null);
  const [submitting, setSubmitting] = useState<'ask' | 'busy' | string | null>(null);
  // Flow (always on) or campaign (one-time): stored on the item, or chosen just now for a new one.
  const kind: CampaignKind = isKind(stores.campaign?.kind) ? stores.campaign!.kind! : isKind(pendingIntent(sessionId)?.kind) ? pendingIntent(sessionId)!.kind! : kindOf(stores.campaign);
  const noun = kind === 'flow' ? 'flow' : 'campaign';
  const pauseLabel = kind === 'flow' ? 'Stop flow' : 'Stop campaign';
  const [subStart, setSubStart] = useState('');
  const [subEnd, setSubEnd] = useState('');
  useEffect(() => {
    let live = true;
    fetchStores(sessionId)
      .then(({ submission: sub, lastWithdrawal: lw, conversions: cv, ...st }) => {
        if (!live) return;
        setSubmission(sub);
        setLastWithdrawal(lw);
        setConversions(cv);
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
  const [products, setProducts] = useState<{ product_id: string; product_name: string; product_type: string }[]>([]);
  const [fields, setFields] = useState<FieldSampleView[]>([]);
  // Potential spend on offers: worked out by the server whenever the campaign changes.
  const [cost, setCost] = useState<CostReportView | null>(null);
  const [costOpen, setCostOpen] = useState<{ bucketId?: string } | null>(null);
  const [strategyOpen, setStrategyOpen] = useState(false);
  useEffect(() => {
    if (!stores.campaign) return setCost(null);
    let live = true;
    fetchCost(sessionId, tenant.tenantId).then((r) => live && setCost(r));
    return () => {
      live = false;
    };
  }, [stores.campaign, stores.context, sessionId, tenant.tenantId]);
  // Comm approvals: every message is approved by the bank before the campaign can be submitted.
  const [approvals, setApprovals] = useState<ApprovalRecordView[] | null>(null);
  useEffect(() => {
    if (!stores.campaign || submission) return setApprovals(null);
    let live = true;
    fetch(apiUrl(`/api/approvals?tenantId=${encodeURIComponent(tenant.tenantId)}&sessionId=${encodeURIComponent(sessionId)}`))
      .then((r) => r.json())
      .then((d: { records?: ApprovalRecordView[] }) => {
        if (!live) return;
        setApprovals(d.records ?? []);
        window.dispatchEvent(new Event('cv:approvals-changed'));
      })
      .catch(() => live && setApprovals([]));
    return () => {
      live = false;
    };
  }, [stores.campaign, submission, sessionId, tenant.tenantId]);
  const notApproved = (approvals ?? []).filter((r) => r.status !== 'approved').length;
  // The bank's delivery setting: undelivered WhatsApp goes again by SMS.
  const [smsFallback, setSmsFallback] = useState(true);
  useEffect(() => {
    fetchLinks(tenant.tenantId).then(setLinks).catch(() => setLinks([]));
    fetchOffers(tenant.tenantId).then(setOffers).catch(() => setOffers([]));
    fetch(apiUrl(`/api/products?tenantId=${encodeURIComponent(tenant.tenantId)}`))
      .then((r) => r.json())
      .then((d: { products?: { product_id: string; product_name: string; product_type: string }[] }) => setProducts(d.products ?? []))
      .catch(() => setProducts([]));
    fetchFields(tenant.tenantId).then(setFields).catch(() => setFields([]));
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
  const [versionsOpen, setVersionsOpen] = useState(false);
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
  // Has this campaign run (live now, ended, or submitted once and stopped since)? Only then can it become a flow.
  const campaignHasRun = (!!submission && submittedStage(submission) !== 'scheduled') || !!lastWithdrawal;
  /** Another flow or campaign of this bank, in the same tab. */
  const itemHref = (id: string) => `${import.meta.env.BASE_URL.replace(/\/$/, '')}/designer.html?c=${encodeURIComponent(id)}&bank=${encodeURIComponent(tenant.tenantId)}`;
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
  // What the designer's [Q7] / [M] / [O] markers point at: the queries filed in the notebook, the answers.
  const managerSaid = useMemo(() => turns.filter((t) => t.role === 'user' && !t.answerSet).map((t) => t.content), [turns]);
  const sources = useMemo(() => sourcesFromEntries((shown.context?.entries ?? []) as never, managerSaid), [shown.context, managerSaid]);
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
        // A new campaign carries the intent chosen when it was created, until the server has stored it.
        ...(!(stores.campaign as { intent?: string } | null)?.intent && pendingIntent(sessionId) ? { intent: pendingIntent(sessionId) } : {}),
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

  // A brief written in the "Create new campaign" modal goes to the designer as soon as the campaign opens.
  const briefSent = useRef(false);
  useEffect(() => {
    const p = pendingIntent(sessionId);
    if (briefSent.current || !p?.brief || turns.length || busy || new URLSearchParams(location.search).has('view')) return;
    briefSent.current = true;
    setPendingIntent(sessionId, { ...p, brief: undefined });
    send(p.brief);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // Opened from Comm approvals (?step=…&b=…): zoom to that message once the canvas is drawn, then drop the parameters.
  const [deepStep] = useState(() => {
    const q = new URLSearchParams(location.search);
    return q.get('step') ? { stepId: q.get('step')!, bucketId: q.get('b') } : null;
  });
  const deepDone = useRef(false);
  useEffect(() => {
    if (!deepStep || deepDone.current || !model.nodes.length) return;
    const f = (x: { data: { focus?: unknown } }) => x.data.focus as { stepId?: string; bucketId?: string } | undefined;
    const n = model.nodes.find((x) => f(x)?.stepId === deepStep.stepId && (!deepStep.bucketId || f(x)?.bucketId === deepStep.bucketId)) ?? model.nodes.find((x) => f(x)?.stepId === deepStep.stepId);
    if (!n) return;
    deepDone.current = true;
    // After the canvas's own first fit, or it would undo the zoom.
    setTimeout(() => {
      setFocus({ id: n.id, n: Date.now() });
      // A short glow on the card, so the eye lands on it.
      const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(n.id)}"]`);
      el?.classList.add('cv-deep-pulse');
      setTimeout(() => el?.classList.remove('cv-deep-pulse'), 2600);
    }, 700);
    const url = new URL(location.href);
    url.searchParams.delete('step');
    url.searchParams.delete('b');
    history.replaceState(null, '', url);
  }, [deepStep, model.nodes]);

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
      text: buckets ? `${buckets} bucket${buckets === 1 ? '' : 's'} on the canvas so far. Watch them fill in.` : `The canvas fills in as the ${noun} takes shape.`,
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
      title: `Your ${noun} is ready`,
      text: `${buckets} bucket${buckets === 1 ? '' : 's'} · ${sends} message${sends === 1 ? '' : 's'}. Ask here to change anything.`,
      action: { label: `View ${noun}`, run: viewAll },
    };
  }

  const drawerNode = drawerId ? model.nodes.find((n) => n.id === drawerId) : null;
  const drawerBucket = drawerNode ? plan?.buckets.find((b) => b.id === drawerNode.data.lane)?.name ?? 'Everyone else' : '';
  const hasCanvas = model.nodes.length > 0;
  // The designer's campaign strategy note (its working plan); older campaigns have it as separate notes.
  const strategy: StrategyNote | null = (() => {
    const entries = stores.context?.entries ?? [];
    const note = (t: string) => currentNotes(entries, { kind: 'note', topic: t })[0];
    const main = note('campaign strategy');
    if (main) return { text: main.text, at: main.at };
    const old = ['segmentation', 'incentive strategy'].map(note).filter((e): e is NonNullable<typeof e> => !!e);
    return old.length ? { text: old.map((e) => `## ${e.topic[0].toUpperCase()}${e.topic.slice(1)}\n\n${e.text}`).join('\n\n'), at: old[old.length - 1].at, legacy: true } : null;
  })();

  return (
    <div className="cv-wrap">
      {viewOnly && (
        <div className="cv-viewbar" role="note">
          <Eye size={16} />
          <b>View only</b>
          <span>You can look at this {noun} but not change it.{viewExpiry ? ` This link works until ${viewExpiry}.` : ''}</span>
          <a className="cv-viewbar-login" href={loginToEdit}>
            Log in to edit
          </a>
        </div>
      )}
      <header className="cv-top">
        {!viewOnly && (
          <button className="cv-back" onClick={onBack} title={kind === 'flow' ? 'All flows' : 'All campaigns'}>
            <ArrowLeft size={16} />
          </button>
        )}
        <div className="cv-title">
          <span className="cv-title-tags">
          {(() => {
            const it = (stores.campaign as { intent?: string } | null)?.intent ?? pendingIntent(sessionId)?.intent;
            return (
              <span className="cv-intent" title={kind === 'flow' ? 'A flow: always on. Customers join as they become eligible; it runs until stopped.' : 'A one-time campaign: a fixed list, between two dates.'}>
                {KIND_LABEL[kind]}
                {it ? ` · ${intentLabel(it, kind)}` : ''}
              </span>
            );
          })()}
          {/* Where a flow came from, and what a campaign became: the sandbox and what graduated from it. */}
          {stores.campaign?.origin && (
            <a className="cv-lineage" href={itemHref(stores.campaign.origin.fromId)} title={stores.campaign.origin.note ? `Note: ${stores.campaign.origin.note}` : 'The campaign this flow was converted from'}>
              <Route size={12} aria-hidden="true" /> Converted from {stores.campaign.origin.fromName}
            </a>
          )}
          {conversions.map((cv) => (
            <a key={cv.toId} className="cv-lineage" href={itemHref(cv.toId)} title={cv.note ? `Note: ${cv.note}` : 'A flow made from this campaign'}>
              <Route size={12} aria-hidden="true" /> Now a flow: {cv.toName}
            </a>
          ))}
          </span>
          <b>{plan?.name || `New ${noun}`}</b>
        </div>
        {/* The campaign's status (Draft, Scheduled, Active…) shows on the Campaigns page, not here. */}
        <span className="cv-top-gap" />
        <MoreMenu
          items={[
            ...(versions.length > 0 && !viewOnly ? [{ key: 'versions', label: viewing ? `Versions (viewing v${viewing.v.n})` : 'Versions', icon: <History size={15} />, onSelect: () => setVersionsOpen(true) }] : []),
            ...(!viewOnly && stores.campaign
              ? [
                  {
                    key: 'duplicate',
                    label: 'Duplicate',
                    icon: <Copy size={15} />,
                    disabled: busy,
                    title: 'Make an editable copy to adapt: a new season, audience or channel mix. The original stays as it is.',
                    onSelect: async () => {
                      const r = await copyCampaign(sessionId, tenant.tenantId);
                      if (r.ok && r.sessionId) window.location.href = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/designer.html?c=${encodeURIComponent(r.sessionId)}&bank=${encodeURIComponent(tenant.tenantId)}`;
                    },
                  },
                ]
              : []),
            // Campaigns are the sandbox: one that has run can become an always-on flow. The campaign itself stays as it is.
            ...(!viewOnly && kind === 'campaign' && stores.campaign && campaignHasRun
              ? [
                  {
                    key: 'convert',
                    label: 'Convert to flow',
                    icon: <Route size={15} />,
                    disabled: busy,
                    title: 'Make what worked here always on: a new flow, built from this campaign by the designer. This campaign stays as it is.',
                    onSelect: () => {
                      setConvName(`${plan?.name || stores.campaign?.name || 'Campaign'}, always on`);
                      setConvNote('');
                      setConverting('ask');
                    },
                  },
                ]
              : []),
            { key: 'activity', label: activity ? 'Hide activity' : 'Activity', icon: <ListChecks size={15} />, onSelect: () => setActivity((v) => !v) },
            ...(!viewOnly
              ? [{ key: 'delete', label: 'Delete', icon: <Trash2 size={15} />, danger: true, disabled: busy || locked, title: busy ? 'Wait for the agent to finish' : 'Delete this campaign', onSelect: () => setConfirmDelete('ask') }]
              : []),
          ]}
        >
          {converting && (
            <div className="cv-del-pop cv-convert-pop" role="dialog" aria-label="Convert to flow">
              <b>Convert to an always-on flow</b>
              <p>The designer turns this campaign into a flow: people join as they become eligible, and it runs until you stop it. This campaign stays as it is.</p>
              <label className="cv-convert-field">
                <span>Name of the flow</span>
                <input value={convName} onChange={(e) => setConvName(e.target.value)} disabled={converting === 'busy'} autoFocus />
              </label>
              <label className="cv-convert-field">
                <span>
                  Note for the designer <i>(optional)</i>
                </span>
                <textarea
                  rows={3}
                  value={convNote}
                  onChange={(e) => setConvNote(e.target.value)}
                  disabled={converting === 'busy'}
                  placeholder="For example: drop the dormant bucket, it didn't work. Make the messages warmer. WhatsApp only."
                />
              </label>
              {converting !== 'ask' && converting !== 'busy' && <p className="cv-del-err">{converting}</p>}
              <div className="cv-del-btns">
                <button className="cv-btn" onClick={() => setConverting(null)}>
                  Cancel
                </button>
                <button
                  className="cv-btn primary"
                  disabled={converting === 'busy' || !convName.trim()}
                  onClick={async () => {
                    setConverting('busy');
                    const r = await convertToFlowApi(sessionId, tenant.tenantId, convName.trim(), convNote.trim());
                    if (!r.ok || !r.sessionId) return setConverting(r.error ?? 'Could not convert it.');
                    // The new flow opens and its designer starts on the conversion, in the manager's name.
                    setPendingIntent(r.sessionId, { intent: (r.intent ?? 'other') as IntentChoice['intent'], ...(r.productId ? { productId: r.productId } : {}), kind: 'flow', brief: r.brief });
                    window.location.href = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/designer.html?c=${encodeURIComponent(r.sessionId)}&bank=${encodeURIComponent(tenant.tenantId)}`;
                  }}
                >
                  {converting === 'busy' ? 'Converting…' : 'Convert to flow'}
                </button>
              </div>
            </div>
          )}
          {versionsOpen && versions.length > 0 && <VersionMenu versions={versions} viewing={viewing?.v.n ?? null} onView={view} onClose={() => setVersionsOpen(false)} />}
          {confirmDelete && (
            <div className="cv-del-pop" role="dialog" aria-label={`Delete ${noun}`}>
              <b>{plan?.name ? `Delete “${plan.name}”?` : `Delete this ${noun}?`}</b>
              <p>It is removed from your {noun}s, with its chat and versions.</p>
              {confirmDelete !== 'ask' && confirmDelete !== 'deleting' && <p className="cv-del-err">{confirmDelete}</p>}
              <div className="cv-del-btns">
                <button className="cv-btn" onClick={() => setConfirmDelete(null)}>
                  Cancel
                </button>
                <button className="cv-btn danger" disabled={confirmDelete === 'deleting'} onClick={deleteCampaign}>
                  {confirmDelete === 'deleting' ? 'Deleting…' : `Delete ${noun}`}
                </button>
              </div>
            </div>
          )}
        </MoreMenu>
        {/* The main action sits last, on the right: Submit for a ready campaign, Stop for a live one. */}
        {submission && !viewOnly && submittedStage(submission) !== 'ended' && (
          <span className="cv-del-wrap">
            <button className="cv-btn" onClick={() => setWithdrawing((v) => (v ? null : 'ask'))} title={kind === 'flow' ? 'Stop the flow: nobody new joins; it can go live again' : 'Stop it: back to Draft, editable; you can submit it again'}>
              {pauseLabel}
            </button>
            {withdrawing && (
              <div className="cv-del-pop" role="dialog" aria-label={pauseLabel}>
                <b>{pauseLabel}?</b>
                <p>
                  {kind === 'flow'
                    ? 'No new customers join and nobody gets further messages. It shows as Stopped, stays editable, and can go live again. Customers\' progress is not kept.'
                    : 'It goes back to Draft: editable, and you can submit it again with new dates. Customers\' progress is not kept, so it starts fresh next time.'}
                </p>
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
        {!submission && !viewOnly && !viewing && (state?.flags.campaignBuilt || lastBuilt) && approvals !== null && (
          <span className="cv-del-wrap">
            {notApproved > 0 ? (
              <button
                className="cv-btn cv-appr-wait"
                onClick={() => window.dispatchEvent(new CustomEvent('cv:open-approvals', { detail: { sessionId } }))}
                title={kind === 'flow' ? 'Every message must be approved by the bank before the flow can go live. Open Comm approvals.' : 'Every message must be approved by the bank before the campaign can be submitted. Open Comm approvals.'}
              >
                <ShieldCheck size={14} /> Waiting for approvals ({notApproved})
              </button>
            ) : (
            <button
              className="cv-btn primary"
              disabled={busy}
              onClick={() => {
                setSubStart(stores.campaign?.schedule?.startDate ?? '');
                setSubEnd(stores.campaign?.schedule?.endDate ?? '');
                setSubmitting((v) => (v ? null : 'ask'));
              }}
            >
              {kind === 'flow' ? 'Go live' : 'Submit for execution'}
            </button>
            )}
            {submitting && (
              <div className="cv-del-pop" role="dialog" aria-label={kind === 'flow' ? 'Go live' : 'Submit for execution'}>
                <b>{kind === 'flow' ? 'Go live' : 'Submit for execution'}</b>
                <p>
                  {kind === 'flow'
                    ? 'Pick the day it goes live: today, or a later date to schedule it. It has no end date and runs until you stop it. Once live it is locked; stop it to change it.'
                    : 'Confirm when it runs. Once submitted it is locked; stop it to change it.'}
                </p>
                <div className="cv-pop-dates" style={{ marginTop: 8 }}>
                  <label>
                    <span>{kind === 'flow' ? 'Goes live on' : 'Starts'}</span>
                    <input type="date" value={subStart} min={new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })} onChange={(e) => setSubStart(e.target.value)} />
                  </label>
                  {kind === 'campaign' && (
                    <label>
                      <span>Ends</span>
                      <input type="date" value={subEnd} min={subStart || undefined} onChange={(e) => setSubEnd(e.target.value)} />
                    </label>
                  )}
                </div>
                {submitting !== 'ask' && submitting !== 'busy' && <p className="cv-del-err" style={{ whiteSpace: 'pre-wrap' }}>{submitting}</p>}
                <div className="cv-del-btns">
                  <button className="cv-btn" onClick={() => setSubmitting(null)}>
                    Cancel
                  </button>
                  <button
                    className="cv-btn primary"
                    disabled={submitting === 'busy' || !subStart || (kind === 'campaign' && !subEnd)}
                    onClick={async () => {
                      setSubmitting('busy');
                      const r = await submitCampaignApi(sessionId, tenant.tenantId, subStart, kind === 'flow' ? '' : subEnd);
                      if (!r.ok || !r.submission) return setSubmitting(r.error ?? 'Could not submit.');
                      setSubmission(r.submission);
                      setSubmitting(null);
                      fetchStores(sessionId).then(({ campaign, context }) => setStores({ campaign, context }));
                    }}
                  >
                    {submitting === 'busy' ? (kind === 'flow' ? 'Working…' : 'Submitting…') : kind === 'flow' ? 'Go live' : 'Submit'}
                  </button>
                </div>
              </div>
            )}
          </span>
        )}
      </header>

      <SourcesContext.Provider value={sources}>
      <div className="cv-main">
        <section className="cv-stage">
          {(strategy || (cost && cost.mode !== 'none')) && (
            <div className="cv-stage-ctas">
              {cost && cost.mode !== 'none' && (
                <button
                  className="cv-strategy-cta cv-cost-cta"
                  onClick={() => { setDrawerId(null); setStrategyOpen(false); setCostOpen({}); }}
                  title={`Estimated ₹${Math.round(cost.total.expected).toLocaleString('en-IN')}, max ₹${Math.round(cost.total.max).toLocaleString('en-IN')}. What the offers may cost the bank, offer by offer.`}
                >
                  Total est. cost <b>~{roundInr(cost.total.expected)}</b>
                  <span className="cv-cost-cta-max">(Max ~{roundInr(cost.total.max)})</span>
                  {cost.mode === 'perThousand' && <span className="cv-muted"> per 1,000 customers</span>}
                </button>
              )}
              {cost && cost.mode !== 'none' && (
                <span className="cv-revenue-wip" title="What the campaign may earn the bank: being worked on, for every kind of campaign at once.">
                  Est. revenue: coming soon
                </span>
              )}
              {strategy && (
                <button className="cv-strategy-cta" onClick={() => { setDrawerId(null); setCostOpen(null); setStrategyOpen(true); }} title="The designer's working plan: buckets, levers, money and budget">
                  <FileText size={14} /> {kind === 'flow' ? 'Flow strategy' : 'Campaign strategy'}
                </button>
              )}
            </div>
          )}
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
              products={products}
              approvals={approvals ? {
                byStep: Object.fromEntries(approvals.flatMap((r) => r.uses.map((u) => [u.stepId, { status: r.status, reason: r.reason }]))),
                rewrite: locked || busy ? undefined : (stepId, reason) => {
                  const r = approvals.find((x) => x.uses.some((u) => u.stepId === stepId));
                  const where = r ? `"${r.uses[0].name}" in ${r.uses[0].bucketName}${r.uses.length > 1 ? ` (used in ${r.uses.length} places; rewrite it everywhere)` : ''}` : 'this message';
                  send(`The bank's approver rejected the message ${where}. Their reason: "${reason}". Rewrite its wording to fix that, and change nothing else in the campaign.`);
                },
              } : null}
              fields={fields}
              cost={cost}
              onOpenCost={(bucketId) => { setDrawerId(null); setStrategyOpen(false); setCostOpen({ bucketId }); }}
              smsFallback={smsFallback}
            />
          ) : (
            <div className="cv-canvas-empty dc-graph-wrap">
              <div>
                <b>{busy ? 'Getting started…' : `Your ${noun} will appear here`}</b>
                <p>The entry, one column per customer bucket, and each bucket's messages, laid out as a flow.</p>
              </div>
            </div>
          )}

          {formQuestions.length > 0 && (
            <QuestionOverlay
              noun={noun}
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

          {strategyOpen && strategy && <StrategyPanel noun={noun} note={strategy} onClose={() => setStrategyOpen(false)} />}
          {costOpen && cost && cost.mode !== 'none' && <CostPanel report={cost} focusBucket={costOpen.bucketId} locked={locked || busy || !!viewing} onDirect={onDirect} onClose={() => setCostOpen(null)} />}
          {drawerNode?.data.step && <NodeDrawer step={drawerNode.data.step as CStep} path={drawerNode.data.path} bucketName={drawerBucket} links={links} smsFallback={smsFallback} onClose={() => setDrawerId(null)} />}

          {activity && <ActivityDrawer state={state} onClose={() => setActivity(false)} />}
        </section>

        <ChatPanel
          turns={turns}
          live={live}
          busy={busy}
          cue={locked ? null : cue}
          placeholder={viewOnly ? 'View-only link. Open the app with the password to make changes.' : submission ? (kind === 'flow' ? 'This flow is live and locked. Stop it to change it.' : 'Submitted for execution. This campaign is locked.') : viewing ? 'Viewing an old version. Go back to current to make changes.' : formQuestions.length ? 'Or reply in your own words…' : built ? 'Ask for a change, or point at any box on the canvas…' : 'Message the agent…'}
          onSend={(t) => send(t)}
          locked={!!viewing || locked}
          onShowFocus={showFocus}
        />
      </div>
      </SourcesContext.Provider>
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
