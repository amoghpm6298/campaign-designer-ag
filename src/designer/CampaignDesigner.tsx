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
import { appendRunLog, loadSession, saveSession, clearSession } from './storage';
import { campaignStages, friendlyConstraint } from './status';
import type { ChatTurn, DesignerResponse, KnowledgeBase, Phase, RunEvent, Tenant } from './types';
import './designer.css';

interface Props {
  knowledge: KnowledgeBase;
  onLogsChanged: () => void;
  /** Selected in the application header. Resolved server-side by id. */
  tenant: Tenant;
}

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

export function CampaignDesigner({ knowledge, onLogsChanged, tenant }: Props) {
  const restored = useRef(loadSession()).current;
  const [sessionId, setSessionId] = useState(restored?.sessionId ?? `s-${Date.now()}`);
  const [messages, setMessages] = useState<ChatTurn[]>(restored?.messages ?? []);
  const [rounds, setRounds] = useState(restored?.discoveryRounds ?? 0);
  const [campaign, setCampaign] = useState<DripCampaign | null>(restored?.campaign ?? null);
  const [last, setLast] = useState<DesignerResponse | null>((restored?.lastResponse as DesignerResponse) ?? null);
  const [graph, setGraph] = useState<DripGraph | null>(((restored?.lastResponse as DesignerResponse) ?? null)?.graph ?? null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
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
  const [phase, setPhase] = useState<Phase>('understanding');
  const [liveEvents, setLiveEvents] = useState<RunEvent[]>([]);
  const [liveText, setLiveText] = useState('');
  const [pendingBlueprint, setPendingBlueprint] = useState<unknown>(null);
  const [pendingStrategy, setPendingStrategy] = useState<unknown>(null);
  // The server owns discovery state; the client just carries it forward.
  const [brief, setBrief] = useState<unknown>(null);
  const [session, setSession] = useState<unknown>(null);
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
              events: res.events,
              validationOutcome: res.validation?.outcome,
              knowledgeVersion: knowledge.version,
              usage: res.usage,
              campaignSnapshot: res.campaign,
            });
            onLogsChanged();
            if (res.phase === 'error') {
              setErr(res.reply);
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
        setErr('The run ended unexpectedly.');
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
        status: 'draft — agent-written, not reviewed or approved by the bank, not a registered template',
      })),
      importReadiness: last?.importReadiness ?? null,
      claim:
        'PROPOSED CAMPAIGN DESIGN from the agent prototype. IMPORT READINESS IS UNVERIFIED, not false and not true: the Drip Campaign application has no JSON import path, so no import contract exists to check this against. Nothing here has been imported, saved or activated, schema validity does not guarantee import acceptance, and any suggested message copy is an unapproved draft.',
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

  const reset = () => {
    clearSession();
    setSessionId(`s-${Date.now()}`);
    setMessages([]);
    setRounds(0);
    setCampaign(null);
    setGraph(null);
    setLast(null);
    setErr(null);
    setResolvedSends({});
    setPhase('understanding');
    setLiveEvents([]);
    setLiveText('');
    setPendingBlueprint(null);
    setPendingStrategy(null);
    setBrief(null);
    setSession(null);
  };

  if (health && !health.ok) {
    return (
      <div className="cd-wrap">
        <div className="cd-top">
          <h1>Campaign Designer</h1>
        </div>
        <div className="cd-configerr">
          <b>Configuration error — the agent cannot run.</b>
          <p style={{ margin: '8px 0 0' }}>
            {health.modelError ??
              'ANTHROPIC_API_KEY is not set on the server. The prototype will not fall back to a mock agent or another provider.'}
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
            {tenant.templateLibraryAccess === 'unavailable' && ' · you supply message template IDs'}
          </div>
        </div>
        <div className="cd-tabs">
          <button className="cd-tab" onClick={reset} disabled={busy || !messages.length}>
            Start over
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
                    <b>Design ready to export.</b> Not import-ready. The campaign builder has no JSON import, so there
                    is no import contract to check this against. Prepare the remaining details and upload it yourself.
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

          {busy && !graph && (
            <div className="cd-state">
              <div className="cd-spinner" />
              <div className="cd-state-title">Designing the campaign</div>
              <div className="cd-state-sub">
                Retrieving context, reasoning about the objective, then building the journey with the
                application&rsquo;s own graph logic.
              </div>
            </div>
          )}

          {!busy && !graph && !err && (
            <div className="cd-state">
              <svg width="54" height="54" viewBox="0 0 48 48" fill="none" aria-hidden="true">
                <rect x="4" y="7" width="13" height="9" rx="2.5" stroke="var(--gray-300)" strokeWidth="1.6" />
                <rect x="31" y="7" width="13" height="9" rx="2.5" stroke="var(--gray-300)" strokeWidth="1.6" />
                <rect x="17.5" y="32" width="13" height="9" rx="2.5" stroke="var(--gray-300)" strokeWidth="1.6" />
                <path d="M10.5 16v8.5h27V16" stroke="var(--gray-300)" strokeWidth="1.6" />
                <path d="M24 24.5V32" stroke="var(--gray-300)" strokeWidth="1.6" />
              </svg>
              <div className="cd-state-title">Your campaign journey appears here</div>
              <div className="cd-state-sub">
                Describe the outcome you want in the panel on the right. The agent asks what it needs, proposes a
                strategy, then builds the journey on this canvas for you to review and refine.
              </div>
            </div>
          )}

          {!busy && !graph && err && (
            <div className="cd-state">
              <div className="cd-state-title" style={{ color: '#991b1b' }}>
                The run did not produce a campaign
              </div>
              <div className="cd-state-sub">{err}</div>
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
              const qs = (m as { questions?: string[] }).questions ?? [];
              // The shortcut belongs only on the questions still waiting for
              // an answer, which is the last message if nothing follows it.
              const awaiting = qs.length > 0 && i === messages.length - 1 && !busy;
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
                {last.evidenceRequests.map((e, i) => (
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
                  <RichText text={stripJson(liveText)} />
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
                <p>Nothing has been built yet. Confirm to create the journey, or tell the agent what to change.</p>
                <div className="cd-confirm-actions">
                  <button
                    className="cd-btn pri"
                    onClick={() => send('Confirmed — build this campaign.', { intent: 'confirm' })}
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
              in the journey; the user supplies the real ids. */}
          {last?.sendProposals.length ? (
            <div className="cd-sends">
              <div className="cd-sends-h">
                Needs your input — {last.sendProposals.length} message step
                {last.sendProposals.length > 1 ? 's' : ''}
              </div>
              {last.sendProposals.map((p) => {
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
                      <div className="cd-send-lbl">Proposed message — not a bank-registered template</div>
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
                onClick={() => send('I have supplied the account and template ids. Rebuild and revalidate the campaign.')}
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
                graph ? 'Ask for a change — e.g. "add a WhatsApp reminder after 3 days"' : 'Describe your campaign objective…'
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
              {last?.questions.length ? (
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

  const tools = events.filter((e) => e.type.startsWith('model.tool_call')).length;
  const failed = events.some((e) => e.status === 'failed');
  const total = events.reduce((n, e) => n + (e.durationMs ?? 0), 0);

  return (
    <div className="cd-activity">
      <button className="cd-act-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="cd-act-icon">{live ? <span className="cd-spinner tiny" /> : failed ? '✕' : '✓'}</span>
        <span className="cd-act-title">
          {live ? 'Working…' : `${events.length} step${events.length === 1 ? '' : 's'}`}
          {tools > 0 && !live ? `, ${tools} lookup${tools === 1 ? '' : 's'}` : ''}
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
      {open && event.data != null && <pre className="cd-act-pre">{JSON.stringify(event.data, null, 1)}</pre>}
    </div>
  );
}

/**
 * The model answers with a JSON object. While it streams we show only the
 * prose it has written so far, never a half-finished brace — the formatted
 * strategy replaces this the moment the run resolves.
 */
function stripJson(text: string): string {
  const brace = text.indexOf('{');
  const prose = (brace === -1 ? text : text.slice(0, brace)).trim();
  if (prose) return prose;
  // Pull readable sentences out of the partial JSON so something meaningful
  // appears while a long blueprint is still arriving.
  const summary = /"summary"\s*:\s*"([^"]*)/.exec(text)?.[1];
  const rationale = /"rationale"\s*:\s*"([^"]*)/.exec(text)?.[1];
  return summary ?? rationale ?? 'Working on the campaign strategy…';
}
