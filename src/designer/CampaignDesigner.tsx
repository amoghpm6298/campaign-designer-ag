// The Campaign Designer: the existing Drip Campaign canvas on the left, the
// agent conversation on the right.
//
// The canvas is the real one — DripCanvas from src/canvas, the same component
// the builder and the read-only campaign view use, fed the same DripGraph the
// application's own reducer produced on the server. Node cards, icons,
// badges, edges, branch labels, layout and the node-detail drawer are
// whatever that component already does; nothing is re-created here.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DripCanvas } from '../canvas/DripCanvas';
import { AddEditDrawer } from '../wizard/AddEditDrawer';
import { dcSeedIdCountersFrom } from '../reducer/idGen';
import { dcConfirmEditNode, dcRenameEdge } from '../reducer/campaignReducer';
import type { DripCampaign, DripGraph } from '../data/graphTypes';
import { getHealth, type HealthResult } from './api';
import { runDesignerStream } from './stream';
import { appendRunLog, loadSession, loadSessionById, saveSession, type DesignerSession } from './storage';
import { campaignStages, detailsText, friendlyConstraint } from './status';
import { previewFromBlueprint, templateSegments, type JourneyPreview, type PreviewRow } from './preview';
import { buildExportPayload, exportFileName } from './exportPayload';
import { PaneBoundary } from './States';
import { RichText } from './RichText';
import type { ChatTurn, DesignerResponse, KnowledgeBase, Phase, RunEvent, Tenant } from './types';
import { AlertCircle, AlertTriangle, ArrowUp, Check, ChevronDown, ChevronRight, Loader2, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import './designer.css';

interface Props {
  knowledge: KnowledgeBase;
  onLogsChanged: () => void;
  /** Selected in the application header. Resolved server-side by id. */
  tenant: Tenant;
  /**
   * Which stored chat to open. Omitted means "the one you were last in".
   *
   * This is how the Chats list resumes a conversation: one designer surface,
   * two ways into it. A second chat UI rendered inside the list page would
   * drift from this one within a release.
   */
  sessionId?: string;
  /** Raised when a new chat is started here, so the shell can follow it. */
  onSessionChange?: (id: string) => void;
}

/**
 * The whole of a stored chat, as the component's state.
 *
 * ONE PATH FOR MOUNT AND RESUME, so the two cannot restore different amounts
 * of a conversation.
 *
 * `lastResponse` carries `phase`, `brief`, `session`, `pendingBlueprint` and
 * `pendingStrategy` and always has. Only `messages`, `rounds`, `campaign` and
 * `graph` were ever read back, so a plain reload mid-conversation dropped the
 * brief and the confirm gate while the data sat in storage, untouched. That
 * was invisible because the agent re-derives most of it from the transcript —
 * but the gate state and the proposed blueprint it cannot.
 */
const stateFrom = (s: DesignerSession | null) => {
  const r = (s?.lastResponse ?? null) as DesignerResponse | null;
  return {
    sessionId: s?.sessionId ?? `s-${Date.now()}`,
    messages: s?.messages ?? [],
    rounds: s?.discoveryRounds ?? 0,
    campaign: s?.campaign ?? null,
    last: r,
    graph: r?.graph ?? null,
    phase: (r?.phase ?? 'understanding') as Phase,
    brief: r?.brief ?? null,
    session: r?.session ?? null,
    pendingBlueprint: r?.pendingBlueprint ?? null,
    pendingStrategy: r?.strategy ?? null,
  };
};

const EXAMPLES = [
  {
    title: 'EMI conversion',
    text: 'Customers authorised for an EMI-eligible purchase are not converting. Get more of them to convert before the request expires.',
  },
  {
    title: 'Card activation',
    text: 'New cardholders are not completing activation. Get them activated in their first two weeks.',
  },
  {
    title: 'Dormant reactivation',
    text: 'Reactivate cards that have had no transaction in the last 90 days.',
  },
];

/**
 * The tenant the platform would pass in. In production the user picks a
 * tenant before the conversation starts and it arrives with the request;
 * there is no platform integration here, so the prototype uses a clearly
 * SYNTHETIC one. It is surfaced in the header rather than hidden, because a
 * campaign's issuer is not something to quietly assume.
 */

/**
 * The message as the customer would see it.
 *
 * PORTED from agent360's `EngagementFlowDiagram.MessageMock`, and it is the
 * fix for the worst thing on the proposal screen: every send card read
 * "A message", because `preview.ts` never carried `copy` at all. Nobody
 * approves copy from a `describe` field, and five identical grey cards is
 * what a manager was being asked to sign off.
 *
 * A fake device rather than a styled quote, because the channel changes how
 * the words land — a hundred characters is a glance on WhatsApp and a wall
 * on SMS, and that is a judgement the manager should be able to make by
 * looking.
 */
function MessageMock({ channel, copy, cta }: { channel: string; copy: string; cta?: string }) {
  const c = channel.toLowerCase();
  return (
    <div className={`cd-mock ${c}`}>
      <div className="cd-mock-bubble">
        {renderTemplate(copy)}
        {cta && <span className="cd-mock-cta">{cta}</span>}
        <span className="cd-mock-meta">{c === 'email' ? 'Inbox' : '9:41 AM'}</span>
      </div>
    </div>
  );
}

/** `{placeholders}` as chips, so copy reads as a template rather than as
 *  something literally addressed to "customerFirstName". The split itself
 *  lives in `preview.ts` and is tested there. */
function renderTemplate(text: string) {
  return templateSegments(text).map((seg, i) =>
    seg.token ? (
      <span className="cd-mock-token" key={i}>
        {seg.text}
      </span>
    ) : (
      <span key={i}>{seg.text}</span>
    ),
  );
}

export function CampaignDesigner({ knowledge, onLogsChanged, tenant, sessionId: openId, onSessionChange }: Props) {
  const initial = useRef(stateFrom(openId ? loadSessionById(openId) : loadSession())).current;
  const [sessionId, setSessionId] = useState(initial.sessionId);
  const [messages, setMessages] = useState<ChatTurn[]>(initial.messages);
  const [rounds, setRounds] = useState(initial.rounds);
  const [campaign, setCampaign] = useState<DripCampaign | null>(initial.campaign);
  const [last, setLast] = useState<DesignerResponse | null>(initial.last);
  const [graph, setGraph] = useState<DripGraph | null>(initial.graph as DripGraph | null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The provider's untouched text, shown under the readable sentence.
  const [errDetail, setErrDetail] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [copied, setCopied] = useState(false);
  // Node-edit drawer state. The drawer is a controlled component in the real
  // builder, so the same state it expects is held here rather than
  // re-implementing the forms.
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
  }, [draft]);

  /** Whether the conversation column is showing. Persisted, like the rail. */
  const [chatOpen, setChatOpen] = useState(() => localStorage.getItem('cd-chat') !== 'collapsed');
  useEffect(() => {
    localStorage.setItem('cd-chat', chatOpen ? 'open' : 'collapsed');
  }, [chatOpen]);
  const [editing, setEditing] = useState<string | null>(null);
  /** Real account/template ids the user types in, keyed by step name. */
  /** Was typed into the retired template panel. The drawer writes template
   *  ids onto the node itself now, so this is always empty — kept so the
   *  request shape the server reads does not change with a UI removal. */
  const [resolvedSends] = useState<Record<string, { account?: string; templateId?: string }>>({});
  // Live run state. `phase` comes from the server — never inferred from
  // whether a graph happens to exist.
  const [phase, setPhase] = useState<Phase>(initial.phase);
  const [liveEvents, setLiveEvents] = useState<RunEvent[]>([]);
  const [liveText, setLiveText] = useState('');

  /** What the agent is doing right now, for the pinned header badge. */
  const liveStep = useMemo(() => {
    const running = [...liveEvents].reverse().find((e) => e.status === 'running' && e.title);
    return running?.title ?? 'Working…';
  }, [liveEvents]);

  const [pendingBlueprint, setPendingBlueprint] = useState<unknown>(initial.pendingBlueprint);
  const [pendingStrategy, setPendingStrategy] = useState<unknown>(initial.pendingStrategy);
  // The server owns discovery state; the client just carries it forward.
  // Held as `unknown` because the brief is the SERVER's record and the client
  // only ever passes it back untouched. `briefView` is a narrow read-only lens
  // over the handful of fields the work surface displays — deliberately not an
  // import of the server's WorkingBrief, so the browser bundle stays
  // independent of server internals and this file documents exactly what the
  // UI depends on.
  const [brief, setBrief] = useState<unknown>(initial.brief);
  const briefView = brief as BriefView | null;
  // THE PROPOSED PATH, DRAWN BEFORE THE MANAGER APPROVES IT.
  //
  // `pendingBlueprint` has always been on the response and was used only as
  // the Confirm payload — so the turn where the manager has to decide was the
  // turn with the least to look at, and the picture arrived only after they
  // had already said yes. `graph` stays null and `DripCanvas` stays unmounted:
  // this is a proposal, not a campaign.
  // A PLAN IS ON SCREEN. Two phases mean that now: `awaiting-confirmation`,
  // where it can be approved, and `revising`, where the brief is closed and
  // the journey needs a change. Both hide the numbered question list and the
  // bank-template panel, because neither is a discovery turn.
  //
  // CONFIRM IS STILL ONLY `awaiting-confirmation`. Revise draws the path and
  // offers no button: a drawing is not a decision, and a plan that needs a
  // change is not approvable.
  const planOnScreen = phase === 'awaiting-confirmation' || phase === 'revising';
  // TIED TO THE PATH, NOT TO THE PHASE, since 2026-10-26.
  //
  // MEASURED, `eval/runs/ui-s-1792843757296` turn 3. A real journey had been
  // filed — ticket-size branch, experiment, an outcome fork on READ against
  // DELIVERED/DELETED — and the turn was held for an unrelated reason, so the
  // response came back `phase: 'discovery'` and this drew nothing. The
  // manager read a page about a journey they could not see. The server now
  // returns the filed path on a held turn too, and the only honest reading of
  // "there is a path" is: draw it.
  //
  // CONFIRM IS STILL THE APPROVAL, and it is still gated on the phase
  // (`phase === 'awaiting-confirmation'`, below) — a drawing is not a
  // decision. `graph` stays null and `DripCanvas` stays unmounted while this
  // is a proposal.
  const preview = useMemo(() => previewFromBlueprint(pendingBlueprint), [pendingBlueprint]);
  const [session, setSession] = useState<unknown>(initial.session);
  const abortRef = useRef<AbortController | null>(null);
  const [editCfg, setEditCfg] = useState<Record<string, unknown>>({});
  const msgsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch((e) => setErr(`Could not reach the local API: ${(e as Error).message}`));
  }, []);

  // Session survives navigating to Knowledge Base / Run Logs and back.
  useEffect(() => {
    saveSession({ sessionId, tenantId: tenant.tenantId, messages, discoveryRounds: rounds, campaign, lastResponse: last });
  }, [sessionId, tenant, messages, rounds, campaign, last]);

  useEffect(() => {
    msgsRef.current?.scrollTo({ top: msgsRef.current.scrollHeight });
  }, [messages, busy]);

  // Keep the id counters ahead of a server-built graph, so any node the user
  // adds on the canvas afterwards cannot collide with a generated id.
  useEffect(() => {
    if (graph) dcSeedIdCountersFrom(graph);
  }, [graph]);

  const send = useCallback(
    async (
      text: string,
      opts?: {
        intent?: 'converse' | 'confirm';
        silent?: boolean;
        attempt?: number;
        /**
         * The exact history to resend on a retry.
         *
         * Needed because a failed turn appends its error to the transcript AS
         * AN ASSISTANT MESSAGE. Retrying from live state therefore sent a
         * conversation ending in an assistant turn, which the API rejects
         * outright: "This model does not support assistant message prefill.
         * The conversation must end with a user message." The retry added to
         * recover from failures was guaranteed to fail. This carries the
         * history as it stood when the user actually spoke.
         */
        replay?: ChatTurn[];
      },
    ) => {
      // ONE automatic retry when the agent's answer will not parse.
      //
      // THE ASYMMETRY THIS CLOSES, and it is the reason this failure was never
      // caught in testing: the evaluation harness retries a turn SIX times
      // ("HARNESS patience rather than product behaviour", eval/showOne.ts),
      // and the UI retried zero times. Every recorded run therefore had six
      // chances to produce a parseable answer while a real conversation had
      // one, so a failure that ends a user's session was invisible in every
      // measurement taken of it.
      //
      // Reproduced directly: the same turn failed to parse on attempts 1 and
      // 2 and succeeded on attempt 3, producing a good answer. One retry is
      // not six, deliberately — it covers the common case without hiding a
      // persistent fault behind a long silence.
      const attempt = opts?.attempt ?? 1;
      const next: ChatTurn[] = opts?.replay ?? (opts?.silent ? messages : [...messages, { role: 'user', content: text }]);
      if (!opts?.silent) setMessages(next);
      setDraft('');
      setBusy(true);
      setErr(null);
      setLiveEvents([]);
      setLiveText('');
      const controller = new AbortController();
      abortRef.current = controller;

      let settled = false;
      // Set when the turn failed in a way a second attempt plausibly fixes.
      let retryable = false;
      await runDesignerStream(
        {
          sessionId,
          messages: next,
          knowledge,
          discoveryRounds: rounds,
          tenantId: tenant.tenantId,
          currentCampaign: campaign,
          resolvedSends,
          intent: opts?.intent ?? 'converse',
          confirmedBlueprint: opts?.intent === 'confirm' ? pendingBlueprint : null,
          confirmedStrategy: opts?.intent === 'confirm' ? pendingStrategy : null,
          brief,
          session,
        },
        {
          onEvent: (e) => {
            // Text deltas drive the streaming bubble; everything else is a
            // timeline item. Deltas are not kept in the timeline — 400 of
            // them would bury the meaningful events.
            if (e.type === 'model.text.delta') {
              setLiveText((t) => t + String((e.data as { text?: string })?.text ?? ''));
            } else {
              setLiveEvents((prev) => {
                // Tool lifecycle collapses onto one row per correlationId.
                if (e.correlationId) {
                  const i = prev.findIndex((p) => p.correlationId === e.correlationId);
                  if (i !== -1) {
                    const copy = [...prev];
                    copy[i] = { ...e, data: e.data ?? copy[i].data };
                    return copy;
                  }
                }
                return [...prev, e];
              });
            }
            if (e.stage === 'generating' || e.stage === 'validating') setPhase('generating');
          },
          onResult: (res) => {
            settled = true;
            setLast(res);
            setPhase(res.phase);
            setRounds(res.discoveryRounds);
            // A failed turn must not destroy discovery progress. The brief and
            // session are applied whenever the server sends them and are never
            // overwritten with a null, so a failure leaves the conversation
            // exactly where it was and the offered retry has something to
            // resume from. The proposal is held too: clearing it on an error
            // would strip the strategy the user is part-way through agreeing.
            // Note a build failure legitimately reports phase 'error' WITH a
            // brief and session, which is why these are not skipped wholesale.
            if (res.brief) setBrief(res.brief);
            if (res.session) setSession(res.session);
            if (res.phase !== 'error') {
              setPendingBlueprint(res.pendingBlueprint ?? null);
              setPendingStrategy(res.strategy ?? null);
            }
            if (res.graph) setGraph(res.graph);
            if (res.campaign) setCampaign(res.campaign);
            // Questions are stored ON the turn that asked them.
            //
            // They used to be rendered from `last.questions`, which is only
            // ever the most recent turn, so answering a round erased its
            // questions from the transcript. You could no longer see what you
            // had been asked, only what you had replied to it — which makes a
            // conversation impossible to read back or hand to anyone else.
            setMessages((m) => [
              ...m,
              { role: 'assistant', content: res.reply || '(no reply)', questions: res.questions ?? [] },
            ]);
            setLiveText('');

            appendRunLog({
              runId: res.runId,
              sessionId: res.sessionId,
              tenantId: tenant.tenantId,
              startedAt: new Date().toISOString(),
              status: res.stage,
              title: opts?.silent ? 'Confirmed the strategy' : text.slice(0, 90),
              userText: opts?.silent ? 'Confirmed the strategy' : text,
              reply: res.reply ?? '',
              questions: res.questions ?? [],
              model: res.model,
              // TEXT DELTAS ARE NOT HISTORY. They are how the reply arrived,
              // already reassembled into `reply` above, and on a measured turn
              // they were 132 of 158 events and half the stored bytes. Dropping
              // them is what pays for the brief and the strategy below.
              events: (res.events ?? []).filter((e) => e.type !== 'model.text.delta'),
              validationOutcome: res.validation?.outcome,
              knowledgeVersion: knowledge.version,
              usage: res.usage,
              campaignSnapshot: res.campaign,
              // What the agent WORKED OUT, so the log is end to end rather
              // than a transcript with an event stream beside it.
              brief: res.brief,
              strategy: res.strategy,
              blueprint: res.pendingBlueprint ?? res.blueprint,
              phase: res.phase,
              discoveryRounds: res.discoveryRounds,
              discoveryReason: (res as { discoveryReason?: string }).discoveryReason,
              errorDetail: (res as { errorDetail?: string }).errorDetail,
            });
            onLogsChanged();
            if (res.phase === 'error') {
              setErr(res.reply);
              setErrDetail((res as { errorDetail?: string }).errorDetail ?? null);
              // "did not return parseable JSON" is the one that is worth
              // trying again: the same turn has been observed to fail twice
              // and succeed on the third attempt with a good answer.
              retryable = /parseable|parse|no text/i.test(res.reply ?? '');
            }
          },
          onError: (message) => {
            settled = true;
            setErr(message);
            setPhase('error');
            setLiveText('');
            setMessages((m) => [...m, { role: 'assistant', content: message }]);
          },
        },
        controller.signal,
      );

      // A stream that ends without result or error must not leave the UI
      // looking busy for ever.
      if (!settled) {
        setErr('The design stopped before it finished.');
        setPhase('error');
      }
      setBusy(false);
      abortRef.current = null;

      // Retry silently, once, on an unparseable answer. `silent: true` so the
      // user's message is not appended a second time.
      if (retryable && attempt === 1) {
        // Drop the error bubble before retrying, so a recovered turn does not
        // leave a stale failure sitting above its own successful answer.
        setMessages((m) => (m[m.length - 1]?.role === 'assistant' ? m.slice(0, -1) : m));
        setErr(null);
        // NOT `silent`. That flag means "this was a confirmation, do not add a
        // user bubble", and the run log titles silent turns "Confirmed the
        // strategy". Reusing it to avoid duplicating the message therefore
        // recorded every retry as the user confirming a campaign they had
        // never been shown. `replay` already supplies the history, so the
        // retry needs nothing from `silent`.
        await send(text, { ...opts, attempt: 2, replay: next });
      }
    },
    [messages, sessionId, knowledge, rounds, campaign, tenant, resolvedSends, pendingBlueprint, pendingStrategy, brief, session, onLogsChanged],
  );

  // Derived the way the real builder derives them: an ENTRY_EVENT node's
  // label IS its eventType and its meta carries the category.
  const entryEvent = useMemo(() => {
    const root = graph?.rootId ? graph.nodes[graph.rootId] : null;
    if (!root || root.type !== 'ENTRY_EVENT') return { category: null, type: null };
    return { category: root.meta || null, type: root.label || null };
  }, [graph]);

  const exportPayload = useMemo(
    () =>
      buildExportPayload({
        campaign,
        graph,
        last,
        tenantId: tenant.tenantId,
        knowledgeVersion: knowledge.version,
      }),
    [campaign, graph, last, knowledge.version, tenant.tenantId],
  );

  const exportable = Boolean(last?.exportable && exportPayload);

  const doCopy = async () => {
    if (!exportPayload) return;
    await navigator.clipboard.writeText(JSON.stringify(exportPayload, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
    appendRunLog({
      runId: `run-${new Date().toISOString().replace(/[:.]/g, '-')}-copy`,
      sessionId,
      startedAt: new Date().toISOString(),
      status: 'export',
      title: 'Copy JSON',
      model: last?.model ?? 'n/a',
      events: [
        {
          runId: `export-${Date.now()}`,
          seq: 1,
          at: new Date().toISOString(),
          type: 'export',
          stage: 'review' as const,
          status: 'ok' as const,
          title: 'Copied the campaign configuration',
          data: { validationOutcome: last?.validation?.outcome, bytes: JSON.stringify(exportPayload).length },
        },
      ],
      validationOutcome: last?.validation?.outcome,
      campaignSnapshot: campaign,
    });
    onLogsChanged();
  };

  const doDownload = () => {
    if (!exportPayload) return;
    const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    // THE NAME, NOT THE ID — see `exportFileName`. This read `id ?? name`,
    // and a campaign-less Confirm synthesises `id: 'draft'`, so Download
    // produced `draft.json`.
    a.download = exportFileName(exportPayload);
    a.click();
    URL.revokeObjectURL(a.href);
    appendRunLog({
      runId: `run-${new Date().toISOString().replace(/[:.]/g, '-')}-dl`,
      sessionId,
      startedAt: new Date().toISOString(),
      status: 'export',
      title: 'Download JSON',
      model: last?.model ?? 'n/a',
      events: [
        {
          runId: `export-${Date.now()}`,
          seq: 1,
          at: new Date().toISOString(),
          type: 'export',
          stage: 'review' as const,
          status: 'ok' as const,
          title: `Downloaded ${a.download}`,
          data: { validationOutcome: last?.validation?.outcome },
        },
      ],
      validationOutcome: last?.validation?.outcome,
      campaignSnapshot: campaign,
    });
    onLogsChanged();
  };

  /** Load a stored chat into the surface. The one path resume goes through. */
  const open = useCallback(
    (s: DesignerSession | null) => {
      const next = stateFrom(s);
      setSessionId(next.sessionId);
      setMessages(next.messages);
      setRounds(next.rounds);
      setCampaign(next.campaign);
      setGraph(next.graph as DripGraph | null);
      setLast(next.last);
      setPhase(next.phase);
      setBrief(next.brief);
      setSession(next.session);
      setPendingBlueprint(next.pendingBlueprint);
      setPendingStrategy(next.pendingStrategy);
      setErr(null);
      setErrDetail(null);
      setLiveEvents([]);
      setLiveText('');
      setEditing(null);
    },
    [],
  );

  // Resuming a chat from the list, and switching between them.
  useEffect(() => {
    if (!openId || openId === sessionId) return;
    open(loadSessionById(openId));
    // `sessionId` is deliberately not a dependency: this reacts to the chat
    // the SHELL asked for, and including the current one would re-open the
    // chat every time a turn advanced it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId, open]);

  /**
   * START A NEW CHAT. Nothing is destroyed.
   *
   * This used to be `reset`, and it called `clearSession()` — one unconfirmed
   * click in the top-right wiped the conversation with no history and no
   * undo. The answer was never a confirmation dialog: starting a new chat
   * should not have been destructive in the first place. The current chat is
   * already saved on every turn, so this only has to mint a new id; the old
   * one stays on the Chats list, resumable.
   */
  const startNew = () => {
    const id = `s-${Date.now()}`;
    open(null);
    setSessionId(id);
    onSessionChange?.(id);
  };

  if (health && !health.ok) {
    return (
      <div className="cd-wrap">
        <div className="cd-top">
          <h1>Campaign Designer</h1>
        </div>
        <div className="cd-configerr">
          <b>The agent cannot run.</b>
          <p style={{ margin: '8px 0 0' }}>
            {health.modelError ??
              'ANTHROPIC_API_KEY is not set on the server.'}
          </p>
          <p style={{ margin: '8px 0 0' }}>
            Copy <code>.env.example</code> to <code>.env</code>, set <code>ANTHROPIC_API_KEY</code> and{' '}
            <code>ANTHROPIC_MODEL</code>, then restart <code>npm run dev</code>.
          </p>
          <p style={{ margin: '8px 0 0', fontSize: 12 }}>
            Model configured: <code>{health.model}</code>
          </p>
        </div>
      </div>
    );
  }

  const v = last?.validation;
  const stages = campaignStages(last);
  // The first stage that stops progress is the only one worth explaining in
  // full — the rest would just be noise next to it.
  const blocking = stages.find((st) => st.state === 'blocked') ?? stages.find((st) => st.state === 'partial');

  return (
    <div className="cd-wrap">
      <div className="cd-top">
        <div>
          <h1>{campaign?.name ?? 'New campaign'}</h1>
          <div className="cd-sub">
            {tenant.displayName}
          </div>
        </div>
        {/* WHAT IT IS DOING, WHERE IT CANNOT SCROLL AWAY.
            The in-thread timeline already says this, and it scrolls — a
            105-second tool call leaves the last thing on screen looking
            frozen. agent360 pins the live step in the pane header for
            exactly that, and deliberately puts no Stop on it: interrupting
            is the composer's job, and this is status. */}
        {busy && (
          <span className="cd-runbadge">
            <span className="cd-runbadge-dot" aria-hidden="true" />
            <span className="cd-runbadge-text">{liveStep}</span>
          </span>
        )}
        <div className="cd-tabs">
          <button className="cd-tab" onClick={startNew} disabled={busy || !messages.length}>
            New chat
          </button>
        </div>
      </div>

      <div className={`cd-body ${graph ? 'cd-has-journey' : 'cd-no-journey'}${!messages.length && !busy ? ' cd-empty' : ''}`}>
        <div className="cd-canvas">
          {/* The seam control. Rendered here rather than in the chat column
              so it survives the chat collapsing to zero width, and placed
              before the pane's content so it comes first in tab order. */}
          <button
            className="cd-chattoggle"
            onClick={() => setChatOpen((v) => !v)}
            aria-expanded={chatOpen}
            aria-label={chatOpen ? 'Collapse the conversation' : 'Show the conversation'}
            title={chatOpen ? 'Collapse the conversation' : 'Show the conversation'}
          >
            {chatOpen ? <PanelLeftClose size={14} /> : <PanelLeftOpen size={14} />}
          </button>
          {v && (
            <div className="cd-status" role="status">
              {/* ONE PILL, NOT FIVE DOTS.
                  A row of five coloured dots — three green, one amber, one
                  red — reads as a CI pipeline, and it put five verdicts in
                  front of the manager when only the first one that stops
                  progress is worth acting on. That one is already spelled
                  out in full underneath; the dots were a second, worse copy
                  of it.

                  The detail is not lost: every stage and its reason is on
                  the pill's `title`, which is where a reader who wants the
                  whole list can find it. */}
              <span className={`cd-statepill ${blocking ? blocking.state : 'ok'}`} title={stages.map((st) => `${st.label}: ${st.detail}`).join('\n')}>
                {blocking ? blocking.label : 'Ready to export'}
              </span>
              <div className="cd-status-detail">
                {blocking ? (
                  <>
                    <b>{blocking.label}:</b> {blocking.detail}{' '}
                    {blocking.nextAction && <span className="cd-status-next">{blocking.nextAction}</span>}
                  </>
                ) : (
                  <>
                    <b>Design ready.</b> Prepare the remaining details, then export it.
                    {last?.importReadiness?.outstanding.length ? (
                      <span className="cd-status-next">
                        {' '}
                        Still to prepare: {last.importReadiness.outstanding.length} item
                        {last.importReadiness.outstanding.length === 1 ? '' : 's'}.
                      </span>
                    ) : null}
                  </>
                )}
              </div>
            </div>
          )}

          {/* THE WORK SURFACE DURING DISCOVERY.
              The canvas used to be hidden entirely until a journey existed,
              because an empty panel holding the centre of the screen through
              the longest phase of the session reads as a broken promise. But
              hiding it moved every finding into chat scrollback, where the
              manager had to scroll back through their own conversation to see
              what the agent had actually understood.
              So the centre always shows the WORK PRODUCT, and what that is
              changes by phase: the brief while discovering, the journey once
              it is built. The skeleton underneath is the propensity agent's
              pattern — a greyed wireframe of the real output rather than a
              spinner, so the shape of what is coming is legible before it
              arrives. */}
          {!graph && !err && (
            <div className="cd-work hf-scroll">
              <div className="cd-work-head">
                <h2>
                  {preview
                    ? 'Proposed journey'
                    : messages.length
                      ? 'What I have so far'
                      : 'Your campaign takes shape here'}
                </h2>
                <p>
                  {preview
                    ? 'Not built yet. Confirm on the left, or say what to change.'
                    : messages.length
                      ? 'This fills in as you talk. Everything here came from your answers, and you can correct any of it.'
                      : 'Describe the outcome you want on the left. What the agent learns appears here, and becomes the journey once you approve a plan.'}
                </p>
              </div>

              {/* A STRIP, NOT THE FOUR CARDS, once there is a journey to look
                  at. The cards are the work product while discovering; on the
                  propose turn the schematic is, and four large cards plus the
                  lines of enquiry push it below the fold. Three facts on one
                  line is enough to check the proposal is answering the right
                  question. */}
              {briefView && preview && (
                <div className="cd-briefstrip">
                  <span>
                    <b>Objective</b>
                    {briefView.objective || 'Not set'}
                  </span>
                  <span>
                    <b>Who converts</b>
                    {briefView.converters?.shape || 'Not established'}{' '}
                    {briefView.converters?.shape && <Basis basis={briefView.converters.basis} />}
                  </span>
                  <span>
                    <b>What is stopping them</b>
                    {briefView.barriers?.length
                      ? briefView.barriers.map((b, i) => (
                          <span key={i}>
                            {i > 0 ? ' ' : ''}
                            {b.statement} <Basis basis={b.basis} quote={b.quote} />
                          </span>
                        ))
                      : 'Not established'}
                  </span>
                </div>
              )}

              {briefView && !preview && (
                <div className="cd-work-grid">
                  <WorkCard label="Objective" filled={Boolean(briefView.objective)}>
                    {briefView.objective || 'Not set yet'}
                  </WorkCard>
                  <WorkCard label="How success is judged" filled={Boolean(briefView.successCriteria?.length)}>
                    {briefView.successCriteria?.length ? briefView.successCriteria.join(' ') : 'Still to settle'}
                  </WorkCard>
                  <WorkCard label="Who converts today" filled={Boolean(briefView.converters?.shape)}>
                    {briefView.converters?.shape || 'Not established'}{' '}
                    {briefView.converters?.shape && <Basis basis={briefView.converters.basis} />}
                  </WorkCard>
                  <WorkCard
                    label={`What is stopping the rest${briefView.barriers?.length ? ` (${briefView.barriers.length})` : ''}`}
                    filled={Boolean(briefView.barriers?.length)}
                  >
                    {briefView.barriers?.length ? (
                      <ul className="cd-basislist">
                        {briefView.barriers.map((b, i) => (
                          <li key={i}>
                            {b.statement} <Basis basis={b.basis} quote={b.quote} />
                          </li>
                        ))}
                      </ul>
                    ) : (
                      'Not established'
                    )}
                  </WorkCard>
                </div>
              )}

              {Boolean(briefView?.dimensions?.length) && !preview && (
                <div className="cd-work-dims">
                  <div className="cd-work-cap">Lines of enquiry</div>
                  <ul>
                    {briefView!.dimensions!.map((d) => (
                      <li key={d.name} className={d.status === 'retained' ? 'on' : ''}>
                        <span className="cd-work-dot" aria-hidden="true" />
                        <span className="cd-work-dname">{d.name}</span>
                        {d.note && <span className="cd-work-dnote">{d.note}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* THE SCHEMATIC REPLACES THE SKELETON on the propose turn. The
                  skeleton is a wireframe standing in for a journey nobody has
                  yet; once there is a real proposed path, standing in for it
                  with grey boxes is the defect this fixes. */}
              {preview && <JourneySchematic preview={preview} busy={busy} />}

              {/* THE EMPTY STATE IS COMPOSED, not a wireframe pinned to the
                  bottom of a blank pane.

                  It was a skeleton at the foot of the column with one grey
                  caption, so more than half the work surface was dead white
                  on the first screen a client sees. The shape is agent360's
                  and is used everywhere in that product: a dashed frame \u2014
                  dashed means "nothing here yet" \u2014 a tinted icon chip, a
                  bold headline, and ONE sentence that says what will appear
                  and how to make it appear. */}
              {!preview && (
              <div className="cd-emptystate">
                <div className="cd-emptystate-card">
                  <div className="cd-sk-row" aria-hidden="true">
                    <span className="cd-sk-node entry" />
                    <span className="cd-sk-line" />
                    <span className="cd-sk-node" />
                    <span className="cd-sk-line" />
                    <span className="cd-sk-node" />
                  </div>
                  <div className="cd-sk-row indent" aria-hidden="true">
                    <span className="cd-sk-line v" />
                    <span className="cd-sk-node small" />
                    <span className="cd-sk-line" />
                    <span className="cd-sk-node small" />
                  </div>
                  <h3>{busy ? 'Working on it' : 'The journey builds here'}</h3>
                  <p>
                    {busy
                      ? 'The agent is reading your brief and working out what the campaign should be.'
                      : messages.length
                        ? 'Every message, wait and branch appears here once you approve a plan.'
                        : 'Describe an outcome on the left. The messages, waits and branches appear here once you approve a plan.'}
                  </p>
                </div>
              </div>
              )}
            </div>
          )}

          {/* THE ERROR MOVED TO THE CHAT COLUMN, above the composer.
              It was rendered here and gated on `!graph`, so a turn that
              failed while a campaign was already on the canvas reported
              nothing at all — the one case where the manager most needs to
              know the change did not land. See `.cd-turnerror`. */}

          {graph && (
            <div style={{ position: 'absolute', inset: 0, paddingTop: v ? 84 : 0, boxSizing: 'border-box' }}>
              {/* The real canvas. Editable so the existing interactions that
                  it supports (open a node, rename a path, remove an edge)
                  keep working on a generated campaign. */}
              <PaneBoundary label="the journey">
              <DripCanvas
                graph={graph}
                editable
                goal={campaign?.goal ?? null}
                onEditNode={(id) => {
                  setEditing(id);
                  setEditCfg({ ...((graph.nodes[id]?._config ?? {}) as Record<string, unknown>) });
                }}
                onRenameEdge={(edgeId, label) => setGraph((g) => (g ? dcRenameEdge(g, edgeId, label) : g))}
              />
              </PaneBoundary>
            </div>
          )}
        </div>

        <div className={`cd-chatwrap${chatOpen ? '' : ' collapsed'}`}>
        <div className="cd-chat">
          <div className="cd-msgs" ref={msgsRef}>
            {!messages.length && (
              <div>
                <div className="cd-msg-role">Start here</div>
                <div className="cd-msg-bubble">
                  Describe the business outcome you want. You do not need to know the platform details. The agent
                  looks those up itself and only asks about things it genuinely cannot.
                </div>
                <div className="cd-examples">
                  <div className="cd-examples-h">Or start from an example</div>
                  {EXAMPLES.map((ex) => (
                    <button key={ex.title} className="cd-example" onClick={() => setDraft(ex.text)}>
                      <span className="cd-example-t">{ex.title}</span>
                      <span className="cd-example-s">{ex.text}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((m, i) => {
              const stored = (m as { questions?: string[] }).questions ?? [];
              // NO NUMBERED QUESTIONS ON A PLAN AWAITING APPROVAL.
              //
              // A proposal returns `questions: []` now, so this mostly guards
              // the transcript: a turn that asked questions BEFORE the plan
              // keeps them, and nothing re-reads as a form once the plan is
              // on screen. Measured on a live EMI run — the strategy arrived
              // with Confirm and one numbered question, and answering the
              // question is what took the manager off Confirm. Clicking
              // Confirm instead built the campaign straight away.
              //
              // The points are not lost: they are in the agent's own message,
              // under "Worth settling before this is built".
              const latest = i === messages.length - 1;
              const qs = latest && planOnScreen ? [] : stored;
              return (
                <div key={i} className={`cd-msg ${m.role}`}>
                  <div className="cd-msg-role">{m.role === 'user' ? 'You' : 'Agent'}</div>
                  <div className="cd-msg-bubble">
                    <RichText text={m.content} />
                  </div>
                  {qs.length > 0 && (
                    <div className="cd-qs">
                      {qs.map((q, n) => (
                        <div className="cd-q" key={n}>
                          <span className="cd-q-n">{n + 1}</span>
                          {q}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}

            {/* A request for data. Structured so it is easy to act on, and
                explicitly optional — declining is a first-class answer. */}
            {!busy && last?.evidenceRequests?.length ? (
              <div className="cd-evidence">
                <div className="cd-evidence-h">Data request — optional</div>
                {(last.evidenceRequests ?? []).map((e, i) => (
                  <div className="cd-ev" key={i}>
                    <div className="cd-ev-q">{e.question}</div>
                    <dl className="cd-ev-fields">
                      <dt>Needed</dt>
                      <dd>{e.fields.join(', ')}</dd>
                      {e.grouping && (
                        <>
                          <dt>Grouped by</dt>
                          <dd>{e.grouping}</dd>
                        </>
                      )}
                      {e.period && (
                        <>
                          <dt>Period</dt>
                          <dd>{e.period}</dd>
                        </>
                      )}
                      <dt>Why</dt>
                      <dd>{e.wouldInform}</dd>
                    </dl>
                  </div>
                ))}
                <div className="cd-ev-actions">
                  <span className="cd-hint">
                    Paste a summary table in the chat, or say you do not have it — the agent will proceed and note the
                    limitation.
                  </span>
                  <button
                    className="cd-btn"
                    disabled={busy}
                    onClick={() => send('We do not have that data. Please proceed without it.')}
                  >
                    We don&rsquo;t have this
                  </button>
                </div>
              </div>
            ) : null}

            {/* What the agent did, above its answer, because that is the order
                it happened in: it works, then it replies, then it asks. It
                used to sit under the questions, which read as a footnote to a
                conversation it had actually come before.

                Expanded while running and collapsed once finished, so it is
                legible when you are watching and quiet when you are reading. */}
            {liveEvents.length > 0 && <ActivityTimeline events={liveEvents} live={busy} />}

            {/* Questions are rendered with the message that asked them, in the
                loop above. They used to be rendered here instead, from the
                latest turn only, which is why answering one erased it from
                the transcript. */}

            {/* The model's own text, as it arrives. */}
            {liveText && (
              <div className="cd-msg">
                <div className="cd-msg-role">
                  Agent <span className="cd-streaming">writing…</span>
                </div>
                <div className="cd-msg-bubble">
                  <RichText text={streamingText(liveText, phase === 'generating' || planOnScreen ? 'Drafting the plan…' : 'Writing a reply…')} />
                  <span className="cd-caret" aria-hidden="true" />
                </div>
              </div>
            )}

            {busy && !liveText && !liveEvents.length && (
              <div className="cd-msg">
                <div className="cd-msg-role">Agent</div>
                <div className="cd-msg-bubble" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <div className="cd-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                  Starting&hellip;
                </div>
              </div>
            )}

          </div>

          {/* Communication steps the agent designed but cannot complete:
              templates live in the bank's ecosystem, not here. The step stays
              in the journey; the user supplies the real ids.

              NOT ON THE PROPOSE TURN. Template ids are a post-build task, and
              asking for them beside a plan nobody has approved reads as
              though the campaign already exists — and wastes the one decision
              this turn is for. */}
          {/* THE TEMPLATE PANEL IS GONE, and nothing can be done here that
              could not be done better one click away.

              It listed every send as an amber card with two free-text boxes
              and the SAME paragraph of explanation repeated verbatim on each
              one, so a five-message campaign filled the conversation column
              with a wall of identical warnings. Meanwhile `NodeForms`'
              `AccountTemplateFields` has always offered the same two fields
              on the Send node's own drawer — as real dropdowns over
              `COMMS_TEMPLATES`, filtered by the send's channel, rather than
              as free text.

              So this was a second, worse way to do one thing: the failure
              mode this repo named when Condition's "Goal" source and the
              Goal Check node both answered one question and built different
              graphs. Click the step, fill it in the drawer. What is missing
              is marked on the step itself. */}

          {/* ONE FIELD, agent360's composer. The send control lives inside
              the box rather than under it, the whole box takes the focus
              ring, and the line underneath doubles as the status line.

              "Question round 3 of 8" used to sit beside the button. It is a
              budget of ours, not a fact about their campaign, and putting a
              meter next to the thing they are trying to do says the
              conversation is rationed. The budget still exists and still
              releases the plan; it is simply not theirs to watch. */}
          {/* A FAILED TURN SAYS SO, AND KEEPS SAYING IT.
              Appending this to the transcript does not work: every render
              site gates on `busy`, which flips false in the same tick the
              error arrives, so the message was unmounted before it painted.
              It is its own row with its own state, dismissible, and it
              survives the stream ending.

              Not gated on `graph`: a refinement that fails over an existing
              campaign is exactly when this matters. */}
          {err && (
            <div className="cd-turnerror" role="alert">
              <AlertTriangle size={14} className="cd-turnerror-i" aria-hidden="true" />
              <div className="cd-turnerror-body">
                <p>{err}</p>
                {errDetail && (
                  <details className="cd-errdetail">
                    <summary>Technical detail</summary>
                    <pre>{errDetail}</pre>
                  </details>
                )}
              </div>
              <button
                className="cd-turnerror-x"
                onClick={() => {
                  setErr(null);
                  setErrDetail(null);
                }}
                aria-label="Dismiss"
              >
                <X size={14} />
              </button>
            </div>
          )}

          {/* THE DECISION DOES NOT SCROLL AWAY.
              This sat inside `.cd-msgs`, so on a long turn the one thing the
              manager is here to do was below a telemetry list and had to be
              scrolled to. It is a sibling of the transcript now, pinned above
              the composer — which is also where "Request a change" sends
              them, so the two moves a propose turn offers are together.

              Still gated on the phase and nothing else: a drawing is not a
              decision, and a held plan must show no button. */}
{/* The gate: nothing is built until this is confirmed. */}
          {!busy && phase === 'awaiting-confirmation' && (
            <div className="cd-confirm">
              <div className="cd-confirm-t">Generate this campaign?</div>
              <p>
                Nothing has been built yet. Confirm to create the journey, or say what you would change.
                {preview ? ' The proposed path is on the right.' : ''}
              </p>
              <div className="cd-confirm-actions">
                <button
                  className="cd-btn pri"
                  onClick={() => send('Confirmed. Build this campaign.', { intent: 'confirm' })}
                >
                  Confirm and generate
                </button>
                <button className="cd-btn" onClick={() => document.querySelector<HTMLTextAreaElement>('.cd-compose textarea')?.focus()}>
                  Request a change
                </button>
              </div>
            </div>
          )}

          <div className="cd-compose">
            <div className={`cd-field${busy ? ' locked' : ''}`}>
              <textarea
                ref={composerRef}
                rows={1}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={
                  busy
                    ? 'The agent is working…'
                    : graph
                      ? 'Ask for a change. For example, "add a WhatsApp reminder after 3 days".'
                      : 'Describe the outcome you want…'
                }
                onKeyDown={(e) => {
                  // Enter sends. The modifier form stays, because it is what
                  // this app taught people and muscle memory is not free.
                  if (e.key === 'Enter' && !e.shiftKey && draft.trim() && !busy) {
                    e.preventDefault();
                    send(draft.trim());
                  }
                }}
                disabled={busy}
              />
              <button
                className="cd-composesend"
                disabled={busy || !draft.trim()}
                onClick={() => send(draft.trim())}
                title={graph ? 'Apply change' : 'Design campaign'}
                aria-label={graph ? 'Apply change' : 'Design campaign'}
              >
                <ArrowUp size={16} strokeWidth={2.5} />
              </button>
            </div>
            <p className="cd-composehint">
              {busy ? (
                <span className="txt-shimmer">The agent is working. The box unlocks when it finishes.</span>
              ) : (
                'Enter to send · Shift+Enter for a new line'
              )}
            </p>
            {graph && (
            <div className="cd-actions">
              <button
                className="cd-btn"
                disabled={!exportPayload}
                onClick={doCopy}
                title={exportPayload ? undefined : last?.exportBlockedReason}
              >
                {copied ? 'Copied' : 'Copy JSON'}
              </button>
              <button
                className="cd-btn"
                disabled={!exportPayload}
                onClick={doDownload}
                title={exportPayload ? undefined : last?.exportBlockedReason}
              >
                Download JSON
              </button>
              {!exportable && blocking ? (
                <span className="cd-hint">{blocking.nextAction ?? blocking.detail}</span>
              ) : exportable && v?.unverifiedHardConstraints.length ? (
                <span className="cd-hint">
                  Still to confirm before launch: {v.unverifiedHardConstraints.map(friendlyConstraint).join(', ')}.
                </span>
              ) : (
                <span className="cd-hint">Exports the complete campaign configuration.</span>
              )}
            </div>
            )}
          </div>
        </div>
        </div>
      </div>

      {/* The application's own node drawer, so a generated node is inspected
          and edited with the same forms as a hand-built one. */}
      {editing && graph?.nodes[editing] && (
        <AddEditDrawer
          open
          isEditing
          isEntry={editing === graph.rootId}
          isMidEdge={false}
          types={[graph.nodes[editing].type]}
          selectedType={graph.nodes[editing].type}
          pendingConfig={editCfg}
          onConfigChange={(patch) => setEditCfg((c) => ({ ...c, ...(patch as Record<string, unknown>) }))}
          onPickType={() => {}}
          onCancel={() => setEditing(null)}
          onConfirm={() => {
            const node = graph.nodes[editing];
            setGraph((g) => (g ? dcConfirmEditNode(g, editing, node.type, editCfg, campaign?.goal ?? null) : g));
            setEditing(null);
          }}
          goal={campaign?.goal ?? null}
          entryEventCategory={entryEvent.category}
          entryEventType={entryEvent.type}
          previousStepChannel={null}
        />
      )}

    </div>
  );
}

/**
 * The run's activity. Expanded while the agent works, so you can watch it;
 * collapsed to a single summary line once it finishes, so the agent's actual
 * answer is what you see rather than a wall of machinery.
 */
function ActivityTimeline({ events, live }: { events: RunEvent[]; live: boolean }) {
  const [open, setOpen] = useState(true);
  const wasLive = useRef(live);
  useEffect(() => {
    // Collapse exactly once, on the transition from running to finished.
    if (wasLive.current && !live) setOpen(false);
    if (live) setOpen(true);
    wasLive.current = live;
  }, [live]);

  // REAL LOOKUPS ONLY, and the count is the fix rather than the wording.
  //
  // This was every `model.tool_call*` event, so the PIN-activation discovery
  // turn reported "6 lookups" having looked nothing up: `ask_questions`,
  // `record_findings` and `record_dimensions` all WRITE to the record, and
  // discovery has no lookup tools available at all. A manager reading that
  // was told the agent went and checked six things before it asked them
  // anything.
  //
  // `data.kind` is stamped at every emit for exactly this. Counting
  // correlation ids rather than events, because one tool call emits
  // requested + started + completed and three events is not three lookups.
  const lookups = new Set(
    events
      .filter((e) => e.type.startsWith('model.tool_call') && (e.data as { kind?: string } | undefined)?.kind === 'lookup')
      .map((e) => e.correlationId ?? `${e.seq}`),
  ).size;
  const failed = events.some((e) => e.status === 'failed');
  const total = events.reduce((n, e) => n + (e.durationMs ?? 0), 0);

  return (
    <div className="cd-steps">
      <button className="cd-act-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="cd-act-icon">
          {live ? <Loader2 size={13} className="spin-slow" /> : failed ? <AlertCircle size={13} /> : <Check size={13} strokeWidth={2.5} />}
        </span>
        <span className={`cd-act-title${live ? ' txt-shimmer' : ''}`}>
          {live ? 'Working…' : `${events.length} step${events.length === 1 ? '' : 's'} in this run`}
          {lookups > 0 && !live ? `, ${lookups} lookup${lookups === 1 ? '' : 's'}` : ''}
        </span>
        {!live && total > 0 && <span className="cd-act-ms">{(total / 1000).toFixed(1)}s</span>}
        <span className="cd-act-chev">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
      </button>
      {open &&
        events.map((e, i) => (
          <ActivityRow key={e.correlationId ?? `${e.seq}`} event={e} first={i === 0} live={live} />
        ))}
    </div>
  );
}

/**
 * One activity row. Shows what the agent is doing, with the real result
 * behind a toggle — the detail matters when you want it and is noise when
 * you don't.
 */
function ActivityRow({ event, first, live }: { event: RunEvent; first: boolean; live: boolean }) {
  const [open, setOpen] = useState(false);
  // See the note on the timeline: a step the stream never closed is not
  // still running once the run is over.
  const running = event.status === 'running' && live;
  const failed = event.status === 'failed';
  // ONLY A ROW WITH SOMETHING BEHIND IT IS CLICKABLE. A disclosure arrow on
  // a row that opens into nothing is a promise the row cannot keep, and the
  // old layout put one on every row regardless.
  const hasDetail = event.data != null;
  return (
    <div className={`cd-step${running ? ' running' : failed ? ' failed' : ''}`}>
      {/* The connector. A 1.5px tick between one step and the next is the
          whole "these happened in order" affordance — no library, no SVG. */}
      {!first && <span className="cd-step-tick" aria-hidden="true" />}
      <button
        className="cd-step-head"
        onClick={() => hasDetail && setOpen((v) => !v)}
        aria-expanded={hasDetail ? open : undefined}
        disabled={!hasDetail}
      >
        {/* Status is a tinted disc, not a glyph in the text flow: three
            states readable at a glance without reading the words. */}
        <span className="cd-step-dot" aria-hidden="true">
          {running ? <Loader2 size={12} className="spin-slow" /> : failed ? <AlertCircle size={12} /> : <Check size={12} strokeWidth={2.5} />}
        </span>
        <span className="cd-step-label">{event.title}</span>
        {event.detail && <span className="cd-step-sum">· {event.detail}</span>}
        {event.durationMs !== undefined && <span className="cd-act-ms">{(event.durationMs / 1000).toFixed(1)}s</span>}
        {hasDetail && <span className="cd-step-chev">{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>}
      </button>
      {/* A SENTENCE, THEN THE PAYLOAD. This was the payload alone, so
          expanding a row traded the one human line for raw state. The JSON is
          kept deliberately — it is the reason Details exists, and it is the
          auditability this product is sold on — but a panel that opens into
          nothing but a data dump cannot be read by the person the run is for.
          `detailsText` is shared with the Logs tab so the two cannot describe
          the same event differently. */}
      {open && hasDetail && (
        <div className="cd-step-body">
          <p className="cd-act-lead">{detailsText(event)}</p>
          <pre className="cd-act-pre">{JSON.stringify(event.data, null, 1)}</pre>
        </div>
      )}
    </div>
  );
}

/**
 * The text as it streams, or a word about what is coming.
 *
 * THE JSON ERA IS OVER, and this function was still living in it. The model
 * used to answer with one JSON object, so this sliced the text at the first
 * `{` and, failing that, dug `"summary"` and `"rationale"` out of the partial
 * payload with regexes, falling back to "Working on the campaign strategy…".
 *
 * The model now writes its message as ordinary prose and puts structure in
 * tool calls, so there is no JSON in the text stream to strip or scavenge.
 * All three mechanisms were dead, and two of them were actively wrong: the
 * brace slice truncated any sentence containing one, and the regexes could
 * put a half-written internal field on screen as though it were the reply.
 *
 * `fallback` names the turn rather than the machinery — the caller knows
 * whether a plan or a reply is coming.
 */
function streamingText(text: string, fallback = 'Writing a reply…'): string {
  return text.trim() || fallback;
}

/**
 * The proposed path, drawn. Read-only by construction.
 *
 * NOT `DripCanvas`, and the distinction is the point. That component renders a
 * BUILT campaign: real nodes, real edges, a node drawer, live validation,
 * dagre layout. None of it exists on a proposal, and mounting it would say
 * the journey had been created when the manager has not approved anything.
 * This maps a pure row list — no click handlers, no drawer, no graph state.
 *
 * Vertical and capped at a reading width rather than a pannable canvas,
 * because the job here is to be scannable in ten seconds, not navigable.
 */
export function JourneySchematic({ preview, busy }: { preview: JourneyPreview; busy: boolean }) {
  return (
    <div className="cd-preview">
      <div className="cd-preview-banner">{busy ? 'Building the journey…' : 'Proposed — not built yet.'}</div>
      <div className="cd-preview-flow">
        <div className="cd-pv-node entry">
          <span className="cd-pv-kind">Who comes in</span>
          <span className="cd-pv-text">{preview.entry}</span>
          {preview.entryNote && <span className="cd-pv-note">{preview.entryNote}</span>}
        </div>
        <PreviewRows rows={preview.rows} />
        {preview.stops && <div className="cd-pv-stop">{preview.stops}</div>}
      </div>
    </div>
  );
}

/**
 * Rows, recursing into forks.
 *
 * EVERY PATH IS DRAWN, including one with nothing on it — `previewFromBlueprint`
 * gives an empty path a note rather than omitting it. A schematic that shows
 * the treated arm and quietly drops the rest path tells the manager the
 * campaign reaches everyone when it does not, which would make this preview
 * worse than no preview.
 */
function PreviewRows({ rows }: { rows: PreviewRow[] }) {
  return (
    <>
      {rows.map((row, i) => (
        <div className="cd-pv-row" key={i}>
          <span className="cd-pv-link" aria-hidden="true" />
          {row.kind === 'wait' || row.kind === 'await' ? (
            // A wait is a chip, not a card. Giving it the weight of a send
            // makes a three-message journey look like six steps.
            <span className="cd-pv-wait">{row.text}</span>
          ) : row.kind === 'fork' ? (
            <div className="cd-pv-fork">
              <div className="cd-pv-forkq">{row.text}</div>
              <div className="cd-pv-paths">
                {row.paths.map((p, j) => (
                  <div className="cd-pv-path" key={j}>
                    <div className="cd-pv-plabel">{p.label}</div>
                    {p.note && <div className="cd-pv-note">{p.note}</div>}
                    <PreviewRows rows={p.rows} />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className={`cd-pv-node ${row.kind}${row.kind === 'send' ? ` ch-${row.channel.toLowerCase().replace(/[^a-z]/g, '')}` : ''}`}>
              <span className="cd-pv-kind">
                {row.kind === 'send'
                  ? `${row.channel}${row.fallback ? ` · ${row.fallback} if it fails` : ''}`
                  : row.kind === 'exit'
                    ? 'Ends'
                    : 'Step'}
              </span>
              {row.text && <span className="cd-pv-text">{row.text}</span>}
              {row.kind === 'send' && row.copy && <MessageMock channel={row.channel} copy={row.copy} cta={row.cta} />}
            </div>
          )}
        </div>
      ))}
    </>
  );
}

/**
 * One settled-or-not fact on the work surface.
 *
 * The filled/empty distinction is the whole point: a manager glancing at the
 * centre should see what the agent has actually got, and what it is still
 * missing, without reading the conversation. An unfilled card is not an error
 * state, so it is muted rather than warned.
 */
function WorkCard({ label, filled, children }: { label: string; filled: boolean; children: React.ReactNode }) {
  return (
    <div className={`cd-workcard ${filled ? 'filled' : ''}`}>
      <div className="cd-work-cap">{label}</div>
      <div className="cd-workcard-body">{children}</div>
    </div>
  );
}

/**
 * What the work surface reads off the brief, and nothing more.
 *
 * Narrow on purpose. The brief is the server's record and grows as the agent
 * does; mirroring the whole of it here would mean this file breaking every
 * time a server-side field changed, for fields it never renders.
 */
interface BriefView {
  objective?: string;
  successCriteria?: string[];
  converters?: { shape?: string; basis?: string } | null;
  /**
   * `basis` and `quote` are on every barrier the server records and had
   * never been read here. They are the whole provenance story — whether a
   * finding is the manager's or the agent's — and the screen showed the
   * statements with no way to tell them apart.
   */
  barriers?: { statement: string; basis?: string; quote?: string }[];
  dimensions?: { name: string; status?: string; note?: string }[];
}

/**
 * Where a finding came from.
 *
 * THE DATA WAS ALREADY THERE. `server/findings.ts` has recorded
 * `basis: 'user' | 'user-belief' | 'assumption'` since it was written, and
 * `recordBarriers` VERIFIES the quote against what the manager actually
 * typed, downgrading one that does not check out. None of that reached the
 * screen, so a theory the agent invented and a sentence the manager said
 * looked identical.
 *
 * That distinction is what this product is sold on. It is a chip, not a
 * footnote.
 */
function Basis({ basis, quote }: { basis?: string; quote?: string }) {
  if (!basis) return null;
  const theirs = basis === 'user' || basis === 'user-belief';
  return (
    <span className={`cd-basis ${theirs ? 'theirs' : 'ours'}`} title={quote ? `"${quote}"` : undefined}>
      {basis === 'user' ? 'You said this' : basis === 'user-belief' ? 'Your read on it' : 'Our assumption, untested'}
    </span>
  );
}
