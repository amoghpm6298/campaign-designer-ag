// Campaign Designer v2: one agent that sees every phase, the plan file and
// progress flags kept by the backend, an aspect-grouped question form, and the
// agent's real tool calls shown inline.
//
// Phase 1 UI: deliberately plain. The left pane is a debug-grade view of the
// backend state (flags, plan file, timeline); the full dashboard is Phase 2.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowUp, Check, ChevronDown, ChevronRight, Circle, Loader2, RotateCcw } from 'lucide-react';
import { DripCanvas } from '../../canvas/DripCanvas';
import type { DripGraph } from '../../data/graphTypes';
import { JourneySchematic } from '../CampaignDesigner';
import { previewFromBlueprint } from '../preview';
import { RichText } from '../RichText';
import type { KnowledgeBase, Tenant } from '../types';
import { runAgentStream } from './api';
import {
  answerOf,
  buildTrace,
  composeReply,
  emptyField,
  groupByAspect,
  isAnswered,
  mergeEvent,
  toolCount,
  totalMs,
  type FieldState,
} from './logic';
import { FLAG_LABELS, FLAG_ORDER, type AgentQuestion, type AgentState, type V2Action, type V2Event, type V2Turn } from './types';
import '../designer.css';
import './v2.css';

const STORE_KEY = 'cd-v2-session';

interface StoredV2 {
  sessionId: string;
  tenantId: string;
  turns: V2Turn[];
  state: AgentState | null;
  graph: unknown | null;
  campaign: unknown | null;
}

function loadStored(): StoredV2 | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as StoredV2) : null;
  } catch {
    return null;
  }
}

function saveStored(s: StoredV2) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* storage full or blocked: the chat still works for this page load */
  }
}

const newId = () => `v2-${Date.now().toString(36)}`;

export function DesignerV2({ knowledge, tenant }: { knowledge: KnowledgeBase; tenant: Tenant }) {
  const stored = useMemo(loadStored, []);
  const [sessionId, setSessionId] = useState(stored?.sessionId ?? newId());
  const [turns, setTurns] = useState<V2Turn[]>(stored?.turns ?? []);
  const [state, setState] = useState<AgentState | null>(stored?.state ?? null);
  const [graph, setGraph] = useState<unknown | null>(stored?.graph ?? null);
  const [campaign, setCampaign] = useState<unknown | null>(stored?.campaign ?? null);
  const [live, setLive] = useState<V2Event[]>([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const [leftTab, setLeftTab] = useState<'plan' | 'timeline'>('plan');
  const abortRef = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    saveStored({ sessionId, tenantId: tenant.tenantId, turns, state, graph, campaign });
  }, [sessionId, tenant.tenantId, turns, state, graph, campaign]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, live.length]);

  const send = (text: string, opts: { answers?: Record<string, string>; action?: V2Action } = {}) => {
    if (busy || !text.trim()) return;
    const next: V2Turn[] = [...turns, { role: 'user', content: text }];
    setTurns(next);
    setDraft('');
    setLive([]);
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
        action: opts.action ?? null,
      },
      {
        onEvent: (e) => {
          events = mergeEvent(events, e);
          setLive(events);
        },
        onResult: (r) => {
          setState(r.state);
          if (r.graph) {
            setGraph(r.graph);
            setCampaign(r.campaign);
          }
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
    setGraph(null);
    setCampaign(null);
    setLive([]);
    setBusy(false);
  };

  const lastAssistant = [...turns].reverse().find((t) => t.role === 'assistant');
  const openQuestions = (state?.questions ?? []).filter((q) => !q.answer?.trim());
  const formQuestions = lastAssistant?.questions?.filter((q) => openQuestions.some((o) => o.id === q.id)) ?? [];

  return (
    <div className="v2-wrap">
      <section className="v2-left">
        <FlagStrip state={state} />
        <div className="v2-tabs">
          <button className={leftTab === 'plan' ? 'on' : ''} onClick={() => setLeftTab('plan')}>
            Plan file
          </button>
          <button className={leftTab === 'timeline' ? 'on' : ''} onClick={() => setLeftTab('timeline')}>
            Timeline {state?.timeline.length ? `(${state.timeline.length})` : ''}
          </button>
        </div>
        <div className="v2-left-body">
          {leftTab === 'plan' ? <PlanFileView state={state} graph={graph} campaign={campaign} busy={busy} /> : <TimelineView state={state} />}
        </div>
      </section>

      <section className="v2-chat">
        <header className="v2-chat-head">
          <div>
            <b>Campaign Designer</b> <span className="v2-badge">Agent v2</span>
          </div>
          <button className="v2-ghost" onClick={reset} title="Start a new chat">
            <RotateCcw size={14} /> New chat
          </button>
        </header>
        <div className="v2-msgs">
          {!turns.length && (
            <div className="v2-empty">
              <h2>What should this campaign achieve?</h2>
              <p>Describe the goal in a sentence. The agent will ask what it needs, write a brief for you to sign off, then a plan, then build it.</p>
              {['I want to drive spends during Diwali', 'Get new cardholders to activate their card', 'Convert big-ticket purchases to EMI'].map((s) => (
                <button key={s} className="v2-chip" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          )}
          {turns.map((t, i) => {
            const isLatest = i === turns.length - 1;
            return t.role === 'user' ? (
              <div className="v2-msg user" key={i}>
                <div className="v2-bubble user">
                  <RichText text={t.content} />
                </div>
              </div>
            ) : (
              <div className="v2-msg agent" key={i}>
                {!!t.events?.length && <TurnTrace events={t.events} live={false} collapsedByDefault={!isLatest} finalText={t.content} />}
                {t.content && (
                  <div className="v2-bubble agent">
                    <RichText text={t.content} />
                  </div>
                )}
                {t.error && (
                  <div className="v2-error">
                    <AlertCircle size={14} /> {t.error}
                  </div>
                )}
                {isLatest && !busy && formQuestions.length > 0 && (
                  <QuestionForm
                    key={formQuestions.map((q) => q.id).join(',')}
                    questions={formQuestions}
                    onSubmit={(message, answers) => send(message, { answers })}
                  />
                )}
                {isLatest && !busy && state?.pendingSignoff && (
                  <SignoffBar
                    section={state.pendingSignoff}
                    onSignoff={() => send(`Signed off the ${state.pendingSignoff}.`, { action: { type: 'signoff', section: state.pendingSignoff! } })}
                    onChanges={(note) => send(`Changes to the ${state.pendingSignoff}: ${note}`, { action: { type: 'request_changes', section: state.pendingSignoff!, note } })}
                  />
                )}
              </div>
            );
          })}
          {busy && (
            <div className="v2-msg agent">
              <TurnTrace events={live} live finalText="" />
            </div>
          )}
          <div ref={endRef} />
        </div>
        <div className="v2-compose">
          <textarea
            value={draft}
            placeholder={formQuestions.length ? 'Or reply in your own words…' : 'Message the agent…'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(draft.trim());
              }
            }}
            rows={2}
            disabled={busy}
          />
          <button className="v2-send" onClick={() => send(draft.trim())} disabled={busy || !draft.trim()} aria-label="Send">
            {busy ? <Loader2 size={16} className="v2-spin" /> : <ArrowUp size={16} />}
          </button>
        </div>
      </section>
    </div>
  );
}

// --- the ordered trace of one turn -------------------------------------------

function TurnTrace({ events, live, collapsedByDefault = false, finalText }: { events: V2Event[]; live: boolean; collapsedByDefault?: boolean; finalText: string }) {
  const [open, setOpen] = useState(!collapsedByDefault);
  const items = buildTrace(events);
  const tools = toolCount(events);
  // Once the turn is over, the final text is shown in the bubble below, so the
  // trace keeps only the text that came BETWEEN tool calls.
  const shown = live ? items : items.filter((it) => it.kind === 'tool' || !finalText.includes(it.text.slice(0, 60)));
  if (!live && !tools) return null;
  return (
    <div className={`v2-trace${live ? ' live' : ''}`}>
      <button className="v2-trace-head" onClick={() => setOpen((v) => !v)}>
        {live ? <Loader2 size={13} className="v2-spin" /> : open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{live ? (items.length ? 'Working' : 'Thinking…') : `Used ${tools} tool${tools === 1 ? '' : 's'}`}</span>
        {!live && totalMs(events) > 0 && <span className="v2-muted">· {(totalMs(events) / 1000).toFixed(1)}s</span>}
      </button>
      {open && (
        <div className="v2-trace-body">
          {shown.map((it) =>
            it.kind === 'text' ? (
              <div className="v2-trace-text" key={it.id}>
                <RichText text={it.text} />
              </div>
            ) : (
              <ToolRow key={it.id} e={it.event} live={live} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

function ToolRow({ e, live }: { e: V2Event; live: boolean }) {
  const [open, setOpen] = useState(false);
  const [raw, setRaw] = useState(false);
  const running = e.status === 'running' && live;
  return (
    <div className={`v2-tool ${e.status}`}>
      <button className="v2-tool-head" onClick={() => setOpen((v) => !v)}>
        <span className="v2-tool-icon">
          {running ? <Loader2 size={12} className="v2-spin" /> : e.status === 'failed' ? <AlertCircle size={12} /> : <Check size={12} />}
        </span>
        <span className="v2-tool-title">{e.title}</span>
        {e.detail && <span className="v2-tool-detail">{e.detail}</span>}
        {e.durationMs !== undefined && e.durationMs > 0 && <span className="v2-muted">{(e.durationMs / 1000).toFixed(1)}s</span>}
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      </button>
      {open && (
        <div className="v2-tool-body">
          <div className="v2-tool-sec">What it sent</div>
          <Readable value={e.data?.input} />
          {e.data?.result !== undefined && (
            <>
              <div className="v2-tool-sec">What came back</div>
              <Readable value={e.data?.result} />
            </>
          )}
          <button className="v2-link" onClick={() => setRaw((v) => !v)}>
            {raw ? 'Hide raw' : 'Show raw'}
          </button>
          {raw && <pre className="v2-raw">{JSON.stringify(e.data, null, 2)}</pre>}
        </div>
      )}
    </div>
  );
}

/** Renders a tool payload as nested readable lists instead of JSON. */
function Readable({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === undefined || value === null || value === '') return <div className="v2-muted">—</div>;
  if (typeof value !== 'object') return <span>{String(value)}</span>;
  if (depth > 3) return <span className="v2-muted">…</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <div className="v2-muted">none</div>;
    if (value.every((v) => typeof v !== 'object')) return <span>{value.map(String).join(', ')}</span>;
    return (
      <ol className="v2-read">
        {value.slice(0, 30).map((v, i) => (
          <li key={i}>
            <Readable value={v} depth={depth + 1} />
          </li>
        ))}
        {value.length > 30 && <li className="v2-muted">+{value.length - 30} more</li>}
      </ol>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return (
    <dl className="v2-read">
      {entries.slice(0, 30).map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>
            <Readable value={v} depth={depth + 1} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

// --- the question form --------------------------------------------------------

function QuestionForm({ questions, onSubmit }: { questions: AgentQuestion[]; onSubmit: (message: string, answers: Record<string, string>) => void }) {
  const [fields, setFields] = useState<Record<string, FieldState>>({});
  const set = (id: string, patch: Partial<FieldState>) => setFields((f) => ({ ...f, [id]: { ...(f[id] ?? emptyField()), ...patch } }));
  const answered = questions.filter((q) => isAnswered(q, fields[q.id])).length;
  const groups = groupByAspect(questions);

  return (
    <form
      className="v2-form"
      onSubmit={(e) => {
        e.preventDefault();
        const { message, answers } = composeReply(questions, fields);
        if (message) onSubmit(message, answers);
      }}
    >
      {groups.map((g) => (
        <fieldset key={g.aspect} className="v2-aspect">
          <legend>{g.aspect}</legend>
          {g.questions.map((q) => {
            const f = fields[q.id] ?? emptyField();
            return (
              <div className="cd-q v2-q" key={q.id}>
                <div className="v2-q-text">
                  {q.text}
                  {q.answerType === 'multi' && <span className="v2-muted"> · pick any</span>}
                </div>
                {q.answerType !== 'open' ? (
                  <>
                    <div className="v2-opts" role={q.answerType === 'single' ? 'radiogroup' : 'group'}>
                      {(q.options ?? []).map((o) => {
                        const on = f.picked.includes(o);
                        return (
                          <button
                            type="button"
                            key={o}
                            className={`v2-opt${on ? ' on' : ''}`}
                            aria-pressed={on}
                            onClick={() =>
                              q.answerType === 'single'
                                ? set(q.id, { picked: on ? [] : [o], other: false })
                                : set(q.id, { picked: on ? f.picked.filter((p) => p !== o) : [...f.picked, o] })
                            }
                          >
                            {o}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        className={`v2-opt other${f.other ? ' on' : ''}`}
                        aria-pressed={f.other}
                        onClick={() => set(q.id, q.answerType === 'single' ? { other: !f.other, picked: [] } : { other: !f.other })}
                      >
                        Other
                      </button>
                    </div>
                    {f.other && (
                      <input className="v2-input" autoFocus placeholder="Type your answer" value={f.text} onChange={(e) => set(q.id, { text: e.target.value })} />
                    )}
                  </>
                ) : (
                  <>
                    {!!q.suggestions?.length && (
                      <div className="v2-opts">
                        {q.suggestions.map((s) => (
                          <button type="button" key={s} className="v2-opt sugg" onClick={() => set(q.id, { text: s })}>
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                    <textarea className="v2-input" rows={2} placeholder="Your answer" value={f.text} onChange={(e) => set(q.id, { text: e.target.value })} />
                  </>
                )}
                {isAnswered(q, f) && <div className="v2-q-ans">→ {answerOf(q, f)}</div>}
              </div>
            );
          })}
        </fieldset>
      ))}
      <div className="v2-form-foot">
        <span className="v2-muted">
          {answered} of {questions.length} answered{answered < questions.length ? ' · blank ones stay open' : ''}
        </span>
        <button type="submit" className="v2-primary" disabled={!answered}>
          Send answers
        </button>
      </div>
    </form>
  );
}

// --- sign-off ----------------------------------------------------------------

function SignoffBar({ section, onSignoff, onChanges }: { section: 'brief' | 'plan'; onSignoff: () => void; onChanges: (note: string) => void }) {
  const [changing, setChanging] = useState(false);
  const [note, setNote] = useState('');
  return (
    <div className="v2-signoff">
      <div>
        <b>Ready for your sign-off:</b> the {section}. {section === 'brief' ? 'Signing off moves the agent on to the plan.' : 'Signing off lets the agent build the campaign.'}
      </div>
      {changing ? (
        <div className="v2-signoff-row">
          <input className="v2-input" autoFocus placeholder="What should change?" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="v2-primary" disabled={!note.trim()} onClick={() => onChanges(note.trim())}>
            Send
          </button>
          <button className="v2-ghost" onClick={() => setChanging(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <div className="v2-signoff-row">
          <button className="v2-primary" onClick={onSignoff}>
            Sign off {section}
          </button>
          <button className="v2-ghost" onClick={() => setChanging(true)}>
            Request changes
          </button>
        </div>
      )}
    </div>
  );
}

// --- left pane: flags, plan file, timeline -----------------------------------------

function FlagStrip({ state }: { state: AgentState | null }) {
  return (
    <div className="v2-flags" aria-label="Progress flags">
      {FLAG_ORDER.map((f) => {
        const on = !!state?.flags[f];
        return (
          <span key={f} className={`v2-flag${on ? ' on' : ''}`} title={f}>
            {on ? <Check size={11} /> : <Circle size={9} />} {FLAG_LABELS[f]}
          </span>
        );
      })}
    </div>
  );
}

function PlanFileView({ state, graph, campaign, busy }: { state: AgentState | null; graph: unknown | null; campaign: unknown | null; busy: boolean }) {
  const pf = state?.planFile;
  const preview = previewFromBlueprint(pf?.journey?.blueprint);
  const g = graph as DripGraph | null;
  const goal = (campaign as { goal?: unknown } | null)?.goal ?? null;
  if (!pf || (!pf.brief.findings.length && !pf.strategy && !pf.journey && !g)) {
    return <div className="v2-placeholder">The plan file fills in here as the agent learns and decides: brief, then strategy, then journey.</div>;
  }
  return (
    <div className="v2-plan">
      <section>
        <h3>
          Brief {state?.flags.briefSignedOff ? <span className="v2-ok">signed off</span> : state?.flags.briefReady ? <span className="v2-warn">awaiting sign-off</span> : null}
        </h3>
        {pf.brief.summary && <p>{pf.brief.summary}</p>}
        {pf.brief.findings.length ? (
          <dl className="v2-findings">
            {pf.brief.findings.map((f) => (
              <div key={f.aspect}>
                <dt>{f.aspect}</dt>
                <dd>
                  {f.text}
                  {f.source === 'assumption' && <span className="v2-tag">assumption</span>}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="v2-muted">Nothing yet.</p>
        )}
      </section>
      {pf.strategy && (
        <section>
          <h3>
            Strategy {state?.flags.planSignedOff ? <span className="v2-ok">signed off</span> : state?.flags.planReady ? <span className="v2-warn">awaiting sign-off</span> : null}
          </h3>
          <dl className="v2-findings">
            {(
              [
                ['Hypothesis', pf.strategy.hypothesis],
                ['Approach', pf.strategy.approach],
                ['Alternative considered', pf.strategy.alternative],
                ['Why not that', pf.strategy.whyNotAlternative],
                ['How we measure it', pf.strategy.measurement],
                ['Risks', pf.strategy.risks?.join(' · ')],
              ] as [string, string | undefined][]
            )
              .filter(([, v]) => v)
              .map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
          </dl>
        </section>
      )}
      {g?.rootId ? (
        <section>
          <h3>
            Campaign <span className="v2-ok">built</span>
          </h3>
          <div className="v2-canvas">
            <DripCanvas graph={g} goal={goal as never} editable={false} />
          </div>
        </section>
      ) : preview ? (
        <section>
          <h3>Journey</h3>
          <JourneySchematic preview={preview} busy={busy} />
        </section>
      ) : null}
    </div>
  );
}

function TimelineView({ state }: { state: AgentState | null }) {
  if (!state?.timeline.length) return <div className="v2-placeholder">Nothing has happened yet. Every flag change, question, sign-off and build is logged here.</div>;
  return (
    <ol className="v2-timeline">
      {state.timeline.map((t, i) => (
        <li key={i} className={`${t.actor} ${t.type}`}>
          <span className="v2-tl-actor">{t.actor}</span>
          <span className="v2-tl-note">{t.note}</span>
          <span className="v2-muted">{new Date(t.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
        </li>
      ))}
    </ol>
  );
}
