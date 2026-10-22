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
import { previewFromBlueprint, type JourneyPreview, type PreviewRow } from './preview';
import type { ChatTurn, DesignerResponse, KnowledgeBase, Phase, RunEvent, Tenant } from './types';
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

/** Minimal markdown: **bold** and "- " bullets. The agent writes both. */
function RichText({ text }: { text: string }) {
  const blocks = text.split('\n');
  const out: React.ReactNode[] = [];
  let list: string[] = [];
  const flush = (key: string) => {
    if (!list.length) return;
    out.push(
      <ul key={key}>
        {list.map((li, i) => (
          <li key={i}>{inline(li)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  function inline(s: string): React.ReactNode[] {
    return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>,
    );
  }
  blocks.forEach((line, i) => {
    if (line.startsWith('- ')) {
      list.push(line.slice(2));
      return;
    }
    flush(`l${i}`);
    if (line.trim()) out.push(<div key={i}>{inline(line)}</div>);
  });
  flush('lend');
  return <>{out}</>;
}

/**
 * The tenant the platform would pass in. In production the user picks a
 * tenant before the conversation starts and it arrives with the request;
 * there is no platform integration here, so the prototype uses a clearly
 * SYNTHETIC one. It is surfaced in the header rather than hidden, because a
 * campaign's issuer is not something to quietly assume.
 */

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
  const [editing, setEditing] = useState<string | null>(null);
  /** Real account/template ids the user types in, keyed by step name. */
  const [resolvedSends, setResolvedSends] = useState<Record<string, { account?: string; templateId?: string }>>({});
  // Live run state. `phase` comes from the server — never inferred from
  // whether a graph happens to exist.
  const [phase, setPhase] = useState<Phase>(initial.phase);
  const [liveEvents, setLiveEvents] = useState<RunEvent[]>([]);
  const [liveText, setLiveText] = useState('');
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
  const preview = useMemo(
    () => (phase === 'awaiting-confirmation' ? previewFromBlueprint(pendingBlueprint) : null),
    [phase, pendingBlueprint],
  );
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
        forceProposal?: boolean;
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
          forceProposal: opts?.forceProposal,
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

  const exportPayload = useMemo(() => {
    if (!campaign) return null;
    return {
      campaign: { ...campaign, root: graph ?? campaign.root },
      campaignFieldProvenance: last?.provenance ?? null,
      unresolvedCampaignFields: last?.unresolvedCampaignFields ?? [],
      validation: last?.validation ?? null,
      strategy: last?.strategy ?? null,
      templateChoices: last?.templateChoices ?? [],
      generatedBy: { model: last?.model, knowledgeVersion: knowledge.version, tenantId: tenant.tenantId },
      // Suggested messaging travels with the design: it lives on each Send's
      // _config.agentMessaging inside campaign.root, and is listed here too
      // so whoever prepares the upload does not have to walk the graph.
      suggestedMessaging: (last?.sendProposals ?? []).map((p) => ({
        step: p.stepName,
        channel: p.channel,
        objective: p.messagingDirection,
        suggestedCopy: p.sampleCopy,
        cta: p.cta,
        personalisationTokens: p.personalisationFields,
        status: 'draft copy, written by the agent and not yet reviewed or registered',
      })),
      importReadiness: last?.importReadiness ?? null,
      claim:
        // Kept, and deliberately. The on-screen disclaimers were removed
        // because they are said out loud in the room; this one travels with a
        // FILE that will be read later, by someone who was not there. Shorter
        // and in plain language, but it still says the two things that matter:
        // nothing is live, and the copy is a draft.
        'Proposed campaign design. Nothing here has been saved or activated, and the message copy is a draft for review.',
    };
  }, [campaign, graph, last, knowledge.version]);

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
    a.download = `${campaign?.id ?? 'campaign'}.json`;
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
      setResolvedSends({});
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
        <div className="cd-tabs">
          <button className="cd-tab" onClick={startNew} disabled={busy || !messages.length}>
            New chat
          </button>
        </div>
      </div>

      <div className={`cd-body ${graph ? 'cd-has-journey' : 'cd-no-journey'}${!messages.length && !busy ? ' cd-empty' : ''}`}>
        <div className="cd-canvas">
          {v && (
            <div className="cd-status" role="status">
              {stages.map((st) => (
                <div key={st.key} className={`cd-stage ${st.state}`} title={st.detail}>
                  <span className="cd-stage-dot" aria-hidden="true" />
                  <span className="cd-stage-label">{st.label}</span>
                </div>
              ))}
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
                    ? 'Not built yet. Confirm on the right, or say what to change.'
                    : messages.length
                      ? 'This fills in as you talk. Everything here came from your answers, and you can correct any of it.'
                      : 'Describe the outcome you want on the right. What the agent learns appears here, and becomes the journey once you approve a plan.'}
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
                    {briefView.converters?.shape || 'Not established'}
                  </span>
                  <span>
                    <b>What is stopping them</b>
                    {briefView.barriers?.length ? briefView.barriers.map((b) => b.statement).join(' ') : 'Not established'}
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
                    {briefView.converters?.shape || 'Not established'}
                  </WorkCard>
                  <WorkCard
                    label={`What is stopping the rest${briefView.barriers?.length ? ` (${briefView.barriers.length})` : ''}`}
                    filled={Boolean(briefView.barriers?.length)}
                  >
                    {briefView.barriers?.length
                      ? briefView.barriers.map((b) => b.statement).join(' ')
                      : 'Not established'}
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

              {/* The skeleton. Deliberately not a spinner: it shows the SHAPE
                  of a journey, so the wait is legible rather than blank. */}
              {!preview && (
              <div className="cd-skeleton" aria-hidden="true">
                <div className="cd-sk-row">
                  <span className="cd-sk-node entry" />
                  <span className="cd-sk-line" />
                  <span className="cd-sk-node" />
                  <span className="cd-sk-line" />
                  <span className="cd-sk-node" />
                </div>
                <div className="cd-sk-row indent">
                  <span className="cd-sk-line v" />
                  <span className="cd-sk-node small" />
                  <span className="cd-sk-line" />
                  <span className="cd-sk-node small" />
                </div>
                <div className="cd-sk-caption">
                  {busy ? 'Working\u2026' : 'The journey appears here once you approve a plan'}
                </div>
              </div>
              )}
            </div>
          )}

          {!busy && !graph && err && (
            <div className="cd-state">
              <div className="cd-state-title" style={{ color: 'var(--bad)' }}>
                No campaign was produced
              </div>
              <div className="cd-state-sub">{err}</div>
              {errDetail && (
                <details className="cd-errdetail">
                  <summary>Technical detail</summary>
                  <pre>{errDetail}</pre>
                </details>
              )}
            </div>
          )}

          {graph && (
            <div style={{ position: 'absolute', inset: 0, paddingTop: v ? 84 : 0, boxSizing: 'border-box' }}>
              {/* The real canvas. Editable so the existing interactions that
                  it supports (open a node, rename a path, remove an edge)
                  keep working on a generated campaign. */}
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
            </div>
          )}
        </div>

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
              const qs = latest && phase === 'awaiting-confirmation' ? [] : stored;
              // The shortcut belongs only on the questions still waiting for
              // an answer, which is the last message if nothing follows it.
              const awaiting = qs.length > 0 && latest && !busy;
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
                      {awaiting && (
                        <button
                          className="cd-quick"
                          onClick={() => send('I am not sure about that. Say what you would assume, and why.')}
                        >
                          I am not sure
                        </button>
                      )}
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
                  <RichText text={streamingText(liveText, phase === 'generating' || phase === 'awaiting-confirmation' ? 'Drafting the plan…' : 'Writing a reply…')} />
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

            {/* The gate: nothing is built until this is confirmed. */}
            {!busy && phase === 'awaiting-confirmation' && (
              <div className="cd-confirm">
                <div className="cd-confirm-t">Generate this campaign?</div>
                <p>
                  Nothing has been built yet. Confirm to create the journey, or say what you would change.
                  {preview ? ' The proposed path is on the left.' : ''}
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
          </div>

          {/* Communication steps the agent designed but cannot complete:
              templates live in the bank's ecosystem, not here. The step stays
              in the journey; the user supplies the real ids.

              NOT ON THE PROPOSE TURN. Template ids are a post-build task, and
              asking for them beside a plan nobody has approved reads as
              though the campaign already exists — and wastes the one decision
              this turn is for. */}
          {/* THE OPTIONAL CHAIN COVERS THE ARRAY TOO, not just `last`.
              The chain used to stop one step short, so a stored response without
              the field — a legacy session, or one written before the field
              existed — took the WHOLE designer down with "Cannot read
              properties of undefined". Every live response carries it, which
              is exactly why this went unnoticed: the type says required and
              the restore path reads whatever is in localStorage. Same lesson
              as the two server crashes today — a declared type is not a
              guarantee about data that crosses a boundary. */}
          {last?.sendProposals?.length && phase !== 'awaiting-confirmation' ? (
            <div className="cd-sends">
              <div className="cd-sends-h">
                Needs your input — {last.sendProposals.length} message step
                {last.sendProposals.length > 1 ? 's' : ''}
              </div>
              {(last.sendProposals ?? []).map((p) => {
                const entry = resolvedSends[p.stepName] ?? {};
                return (
                  <div className="cd-send" key={p.stepName}>
                    <div className="cd-send-t">
                      {p.stepName}
                      <span className="cd-send-meta">
                        {p.channel} · {p.timing}
                      </span>
                    </div>
                    <div className="cd-send-why">{p.explanation}</div>
                    <div className="cd-send-copy">
                      <div className="cd-send-lbl">Proposed message. Not a registered template yet.</div>
                      <div>{p.sampleCopy}</div>
                      <div className="cd-send-cta">
                        CTA: {p.cta}
                        {p.personalisationFields.length ? ` · Tokens: ${p.personalisationFields.join(', ')}` : ''}
                      </div>
                    </div>
                    <div className="cd-send-fields">
                      <label>
                        Account
                        <input
                          value={entry.account ?? ''}
                          placeholder="from the bank's ecosystem"
                          onChange={(e) =>
                            setResolvedSends((r) => ({ ...r, [p.stepName]: { ...r[p.stepName], account: e.target.value } }))
                          }
                        />
                      </label>
                      <label>
                        Template ID
                        <input
                          value={entry.templateId ?? ''}
                          placeholder="the bank's real template id"
                          onChange={(e) =>
                            setResolvedSends((r) => ({
                              ...r,
                              [p.stepName]: { ...r[p.stepName], templateId: e.target.value },
                            }))
                          }
                        />
                      </label>
                    </div>
                  </div>
                );
              })}
              <button
                className="cd-btn"
                disabled={busy || !Object.values(resolvedSends).some((v) => v.account || v.templateId)}
                onClick={() => send('I have added the account and template IDs. Build the campaign again.')}
              >
                Apply and revalidate
              </button>
            </div>
          ) : null}

          <div className="cd-compose">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                graph ? 'Ask for a change. For example, "add a WhatsApp reminder after 3 days".' : 'Describe your campaign objective…'
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && draft.trim() && !busy) send(draft.trim());
              }}
              disabled={busy}
            />
            <div className="cd-actions">
              <button className="cd-btn pri" disabled={busy || !draft.trim()} onClick={() => send(draft.trim())}>
                {graph ? 'Apply change' : 'Design campaign'}
              </button>
              {/* NOT WHILE A PLAN IS WAITING TO BE APPROVED. "Skip & propose"
                  offers to produce the recommendation that is already on
                  screen, which reads as though the plan were provisional and
                  gives the approval turn a second, competing primary action.
                  Confirm is the only one there. "Request a change" stays, and
                  so does the ordinary message box. */}
              {last?.questions?.length && phase !== 'awaiting-confirmation' ? (
                <button
                  className="cd-btn"
                  disabled={busy}
                  onClick={() => send('Proceed with your best recommendation and list what is still unknown.', { forceProposal: true })}
                  title="Skip remaining questions and get a provisional recommendation"
                >
                  Skip &amp; propose
                </button>
              ) : null}
              {rounds > 0 && <span className="cd-rounds">Question round {rounds} of 8</span>}
            </div>
            {graph && (
            <div className="cd-actions">
              <button className="cd-btn" disabled={!exportable} onClick={doCopy} title={last?.exportBlockedReason}>
                {copied ? 'Copied' : 'Copy JSON'}
              </button>
              <button className="cd-btn" disabled={!exportable} onClick={doDownload} title={last?.exportBlockedReason}>
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
    <div className="cd-activity">
      <button className="cd-act-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="cd-act-icon">{live ? <span className="cd-spinner tiny" /> : failed ? '✕' : '✓'}</span>
        <span className="cd-act-title">
          {live ? 'Working…' : `${events.length} step${events.length === 1 ? '' : 's'} in this run`}
          {lookups > 0 && !live ? `, ${lookups} lookup${lookups === 1 ? '' : 's'}` : ''}
        </span>
        {!live && total > 0 && <span className="cd-act-ms">{(total / 1000).toFixed(1)}s</span>}
        <span className="cd-act-chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && events.map((e) => <ActivityRow key={e.correlationId ?? `${e.seq}`} event={e} />)}
    </div>
  );
}

/**
 * One activity row. Shows what the agent is doing, with the real result
 * behind a toggle — the detail matters when you want it and is noise when
 * you don't.
 */
function ActivityRow({ event }: { event: RunEvent }) {
  const [open, setOpen] = useState(false);
  const running = event.status === 'running';
  const failed = event.status === 'failed';
  return (
    <div className={`cd-act ${running ? 'running' : failed ? 'failed' : 'done'}`}>
      <span className="cd-act-icon" aria-hidden="true">
        {running ? <span className="cd-spinner tiny" /> : failed ? '✕' : '✓'}
      </span>
      <span className="cd-act-title">{event.title}</span>
      {event.detail && <span className="cd-act-detail">{event.detail}</span>}
      {event.durationMs !== undefined && <span className="cd-act-ms">{(event.durationMs / 1000).toFixed(1)}s</span>}
      {event.data != null && (
        <button className="cd-link" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide' : 'Details'}
        </button>
      )}
      {/* A SENTENCE, THEN THE PAYLOAD. This was the payload alone, so
          expanding a row traded the one human line for raw state. The JSON is
          kept deliberately — it is the reason Details exists — but a panel
          that opens into nothing but a data dump cannot be read by the person
          the run is for. `detailsText` is shared with the Logs tab so the two
          cannot describe the same event differently. */}
      {open && event.data != null && (
        <div className="cd-act-body">
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
function JourneySchematic({ preview, busy }: { preview: JourneyPreview; busy: boolean }) {
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
            <div className={`cd-pv-node ${row.kind}`}>
              <span className="cd-pv-kind">
                {row.kind === 'send'
                  ? `${row.channel}${row.fallback ? ` · ${row.fallback} if it fails` : ''}`
                  : row.kind === 'exit'
                    ? 'Ends'
                    : 'Step'}
              </span>
              <span className="cd-pv-text">{row.text}</span>
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
  converters?: { shape?: string } | null;
  barriers?: { statement: string }[];
  dimensions?: { name: string; status?: string; note?: string }[];
}
