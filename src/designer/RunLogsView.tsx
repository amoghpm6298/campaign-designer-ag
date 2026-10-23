// Run Logs — what the agent actually did.
//
// Every event here is recorded by the orchestrator during a real run. Nothing
// is fabricated, and no API key or model reasoning is stored — only structured
// decisions and the evidence behind them.
import { fmtDay, fmtTime, fmtStamp } from './time';
import { useMemo, useState } from 'react';
import { clearRunLogs, deleteSession, listSessions } from './storage';
import { DripCanvas } from '../canvas/DripCanvas';
import { computeDagreLayout } from '../canvas/layoutGraph';
import { detailsText, friendlyEvent } from './status';
import type { RunLog } from './types';
import './designer.css';

interface Props {
  logs: RunLog[];
  onCleared: () => void;
  onStartDesigning?: () => void;
  /** Continue this chat in the designer. The whole point of the page. */
  onResume?: (sessionId: string) => void;
}

const OUTCOME: Record<string, { label: string; cls: string }> = {
  proposed: { label: 'Campaign designed', cls: 'ok' },
  discovery: { label: 'Questions asked', cls: 'info' },
  blocked: { label: 'Needs input', cls: 'warn' },
  error: { label: 'Failed', cls: 'bad' },
  export: { label: 'Exported', cls: 'info' },
};

/** A value worth printing, or nothing. Never a bare label over a blank. */
const Fact = ({ label, children }: { label: string; children: React.ReactNode }) =>
  children ? (
    <div className="cd-fact">
      <div className="cd-work-cap">{label}</div>
      <div className="cd-fact-body">{children}</div>
    </div>
  ) : null;

/** The shapes this panel reads. Narrow on purpose, same rule as BriefView. */
interface SummaryBrief {
  objective?: string;
  successCriteria?: string[];
  converters?: { shape?: string; knowledge?: string; candidates?: { segment?: string; restsOn?: string }[] } | null;
  barriers?: { statement?: string; basis?: string; lever?: string }[];
  dimensions?: { name?: string; status?: string; note?: string }[];
}
interface SummaryStrategy {
  summary?: string;
  architectures?: { name?: string; chosen?: boolean; barrier?: string; whyChosen?: string }[];
  architectureComparison?: { status?: string; why?: string } | null;
  strategyOptions?: { option?: string; verdict?: string; why?: string }[];
}

/**
 * What the agent found and what it decided, for one turn.
 *
 * WHY THIS EXISTS. "Is everything printed in logs? Seems like some info is
 * incomplete." It was: the log carried the conversation and the machine
 * events, and dropped the brief and the strategy — so you could see that a
 * proposal happened and never what was proposed, or what evidence it rested
 * on. Both are stored now, and this is where they are read.
 */
function RunSummary({ turn }: { turn: RunLog }) {
  const brief = (turn.brief ?? null) as SummaryBrief | null;
  const strategy = (turn.strategy ?? null) as SummaryStrategy | null;
  const tools = (turn.events ?? []).filter((e) => e.type === 'model.tool_call.completed');
  if (!brief && !strategy && !tools.length) return null;
  return (
    <div className="cd-runsum">
      <div className="cd-transcript-h">What the agent worked out</div>

      <Fact label="Objective">{brief?.objective}</Fact>
      <Fact label="How success is judged">{brief?.successCriteria?.join(' ')}</Fact>
      <Fact label="Who converts today">
        {brief?.converters?.shape && (
          <>
            {brief.converters.shape}
            {brief.converters.candidates?.length ? (
              <ul className="cd-sumlist">
                {brief.converters.candidates.map((c, i) => (
                  <li key={i}>
                    {c.segment}
                    {c.restsOn ? <span className="cd-work-dnote"> rests on {c.restsOn}</span> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </Fact>
      <Fact label={`What is stopping the rest${brief?.barriers?.length ? ` (${brief.barriers.length})` : ''}`}>
        {brief?.barriers?.length ? (
          <ul className="cd-sumlist">
            {brief.barriers.map((b, i) => (
              <li key={i}>
                {b.statement}
                {b.basis ? <span className="cd-work-dnote"> {b.basis === 'assumption' ? 'the agent’s own reading' : 'from what you said'}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Fact>
      <Fact label={`Lines of enquiry${brief?.dimensions?.length ? ` (${brief.dimensions.length})` : ''}`}>
        {brief?.dimensions?.length ? (
          <ul className="cd-sumlist">
            {brief.dimensions.map((d, i) => (
              <li key={i}>
                {d.name}
                {d.status && d.status !== 'retained' ? <span className="cd-work-dnote"> {d.status}</span> : null}
                {d.note ? <span className="cd-work-dnote"> {d.note}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Fact>

      <Fact label="The plan">{strategy?.summary}</Fact>
      <Fact label="Approaches weighed">
        {strategy?.architectures?.length ? (
          <ul className="cd-sumlist">
            {strategy.architectures.map((a, i) => (
              <li key={i}>
                {a.chosen ? <b>{a.name} — chosen</b> : a.name}
                {a.barrier ? <span className="cd-work-dnote"> attacks {a.barrier}</span> : null}
                {a.chosen && a.whyChosen ? <span className="cd-work-dnote"> {a.whyChosen}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Fact>
      <Fact label="Were they really different?">{strategy?.architectureComparison?.why}</Fact>
      <Fact label="Options considered">
        {strategy?.strategyOptions?.length ? (
          <ul className="cd-sumlist">
            {strategy.strategyOptions.map((o, i) => (
              <li key={i}>
                {o.option}: {o.verdict}
                {o.why ? <span className="cd-work-dnote"> {o.why}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Fact>

      <Fact label="What it checked">
        {tools.length ? (
          <ul className="cd-sumlist">
            {tools.map((t, i) => (
              <li key={i}>
                {t.title}
                {t.detail ? <span className="cd-work-dnote"> {t.detail}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Fact>
      <Fact label="Why discovery continued">{turn.discoveryReason}</Fact>
      <Fact label="Error detail">{turn.errorDetail ? <pre>{turn.errorDetail}</pre> : null}</Fact>
    </div>
  );
}

const when = (iso: string) => {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return fmtDay(d);
};

export function RunLogsView({ logs, onCleared, onStartDesigning, onResume }: Props) {
  const [sel, setSel] = useState<string | null>(null);
  const [rawFor, setRawFor] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  /**
   * Which half of a chat you are looking at.
   *
   * The conversation and the machine record were stacked on one scrolling
   * page, so reading what was said meant scrolling past the events and back.
   * They answer different questions — "what did we agree" and "what did it
   * actually do" — and a tab each lets you hold one while checking the
   * other.
   */
  const [tab, setTab] = useState<'resume' | 'logs' | 'journey'>('resume');
  /**
   * Which TURN's log you are reading.
   *
   * The Logs tab rendered `current` — the newest turn — and nothing else, so
   * a five-turn conversation had four turns of events that no screen could
   * reach. The Conversation tab has always listed every turn; this is the
   * same record on the other side of the same chat. Null means the newest.
   */
  const [turnSel, setTurnSel] = useState<string | null>(null);
  /** Chats that exist in storage, so one that never logged a run still lists. */
  const [stored, setStored] = useState(() => listSessions());

  // Grouped by SESSION, not by turn.
  //
  // Every turn appended its own entry and the list selected one at a time, so
  // a five-turn conversation appeared as five unrelated rows and there was no
  // way to read a run end to end. A design conversation only makes sense as a
  // whole: the objective, what was asked, what came back, and what finally
  // got built. The published run-log artefact has always shown it that way
  // and this is the same shape.
  const sessions = useMemo(() => {
    const by = new Map<string, RunLog[]>();
    for (const l of logs) by.set(l.sessionId, [...(by.get(l.sessionId) ?? []), l]);
    // BOTH SOURCES, because they can disagree in either direction. A chat
    // whose first turn errored has a session and no run log; a run log can
    // outlive its session once the store hits its cap. Either way the row
    // belongs on the list, and only one of the two can be resumed.
    for (const s of stored) if (!by.has(s.sessionId)) by.set(s.sessionId, []);
    const resumable = new Set(stored.filter((s) => s.messages?.length).map((s) => s.sessionId));
    const titles = new Map(stored.map((s) => [s.sessionId, s.messages?.[0]?.content ?? '']));
    // THE CONVERSATION'S OWN MESSAGES, carried so the transcript does not
    // depend on the logs surviving. They are two different stores with two
    // different lifetimes, and the chat is the one worth keeping.
    const said = new Map(stored.map((s) => [s.sessionId, s.messages ?? []]));
    const times = new Map(stored.map((s) => [s.sessionId, s.updatedAt ?? '']));
    return [...by.entries()]
      .map(([sessionId, turns]) => ({
        sessionId,
        // Oldest turn first within a session, so it reads as a conversation.
        turns: [...turns].sort((x, y) => x.startedAt.localeCompare(y.startedAt)),
        canResume: resumable.has(sessionId),
        title: turns[0]?.title || titles.get(sessionId) || 'Untitled campaign',
        at: turns[turns.length - 1]?.startedAt || times.get(sessionId) || '',
        messages: said.get(sessionId) ?? [],
      }))
      .sort((a, b) => b.at.localeCompare(a.at));
  }, [logs, stored]);

  // Null until a row is clicked. It used to fall back to the first chat, so
  // the page always opened mid-conversation in something you had not asked
  // for; with a table the list IS the landing state.
  const session = sel ? sessions.find((g) => g.sessionId === sel) ?? null : null;
  const newest = session?.turns[session.turns.length - 1] ?? null;
  /** The turn being read: the one picked, else the newest. */
  const current = (turnSel ? session?.turns.find((t) => t.runId === turnSel) : null) ?? newest;

  /**
   * THE JOURNEY THIS CHAT BUILT, if it built one.
   *
   * `campaignSnapshot` is the campaign as it stood at the end of a turn and
   * `DripCampaign.root` is the graph, so the canvas needs nothing that is not
   * already stored. Read from the newest turn that HAS one rather than from
   * the newest turn: a chat often continues after the build, and those later
   * turns carry no snapshot.
   *
   * Showing it is not a nicety. A chat whose whole point was to produce a
   * journey could be opened and read and never show the journey — the one
   * artefact the conversation existed to create.
   */
  const built = useMemo(() => {
    for (const t of [...(session?.turns ?? [])].reverse()) {
      if (t.campaignSnapshot?.root?.rootId) return t.campaignSnapshot;
    }
    return null;
  }, [session]);

  /**
   * The journey's own proportions, so the panel is the shape of the graph.
   *
   * A FIXED BOX WASTES ONE AXIS OR THE OTHER. At 78vh a wide, shallow journey
   * — four parallel checkpoints, say — sat in the middle of 300px of empty
   * dotted background above and below it, while `fitView` shrank the text to
   * fit a width it could not use. The complaint was "so much space wasted"
   * and it was two different wastes: a reading-measure cap on the left, and
   * this.
   *
   * `computeDagreLayout` is the same pure layout the canvas itself runs, so
   * this is the real shape rather than a guess — called with no measured
   * heights, which is the fallback the first paint uses anyway. The ratio
   * goes to CSS `aspect-ratio`; min/max-height still bound it, so a very tall
   * journey is capped and pans rather than growing without limit.
   */
  const aspect = useMemo(() => {
    const root = built?.root;
    if (!root?.rootId) return null;
    const boxes = Object.values(computeDagreLayout(root, {}).positions);
    if (!boxes.length) return null;
    const w = Math.max(...boxes.map((b) => b.x + b.width)) - Math.min(...boxes.map((b) => b.x));
    const h = Math.max(...boxes.map((b) => b.y + b.height)) - Math.min(...boxes.map((b) => b.y));
    return w > 0 && h > 0 ? `${Math.round(w)} / ${Math.round(h)}` : null;
  }, [built]);


  // STORED CHATS COUNT TOO. This was `!logs.length`, so clearing the logs —
  // or any chat that exists in storage with no completed run — showed "No
  // chats yet" over a list that was about to render rows.
  if (!sessions.length) {
    return (
      <div className="cd-page">
        <h1>Chats</h1>
        <p className="cd-lede">
          Every conversation you have had with the agent. Open one to pick it up where you left off, or to read what
          the agent did on each turn.
        </p>
        <div className="cd-empty-panel">
          <div className="cd-empty-title">No chats yet</div>
          <p>Design a campaign and it appears here, ready to continue whenever you come back.</p>
          {onStartDesigning && (
            <button className="cd-btn pri" onClick={onStartDesigning}>
              Start designing a campaign
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="cd-page">
      <div className="cd-page-head">
        <div>
          {/* A BACK LINK, NOT A PERMANENT LIST.
              The chat list used to sit in a narrow column beside the content,
              which is the shape Run Logs had when a "row" was one turn. At
              thirteen chats it was a wall of cards with every title truncated,
              and it took a third of the width from the thing you opened it to
              read. A table that opens full width is the same pattern as the
              campaign list, and the list is one click away rather than always
              present. */}
          {session && (
            <button className="cd-link cd-back" onClick={() => setSel(null)}>
              ← All chats
            </button>
          )}
          <h1>{session ? session.title : 'Chats'}</h1>
          <p className="cd-lede">
            {session
              ? `${session.turns.length} turn${session.turns.length === 1 ? '' : 's'}${session.at ? ` · ${fmtStamp(session.at)}` : ''}`
              : `${sessions.length} chat${sessions.length === 1 ? '' : 's'}, newest first. Stored in this browser.`}
          </p>
        </div>
        <div className="cd-logs-actions">
          {/* THE WHOLE SESSION, not the selected turn.
              A run only makes sense end to end — the objective, every
              question, every reply, the events and the campaign that came out
              — and a log that cannot leave the browser it was made in is a
              log nobody else can read. */}
          {session && (
            <button
              className="cd-btn"
              onClick={async () => {
                await navigator.clipboard.writeText(JSON.stringify(session, null, 2));
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? 'Copied' : 'Copy this chat'}
            </button>
          )}
          {/* Clears the LOGS, not the chats. A chat you can still continue
              must not disappear because you tidied up the event history. */}
          {!session && (
            <button className="cd-btn" onClick={() => { clearRunLogs(); setSel(null); onCleared(); }}>
              Clear logs
            </button>
          )}
        </div>
      </div>

      {!session && (
        <table className="cd-table">
          <thead>
            <tr>
              <th>Campaign</th>
              <th>Outcome</th>
              <th>Turns</th>
              <th>Last activity</th>
              <th>Issuer</th>
            </tr>
          </thead>
          <tbody>
            {sessions.map((g) => {
              // A chat is labelled by what it set out to do, which is its
              // FIRST message, and judged by where it ended up, which is its
              // last turn's outcome.
              const first = g.turns[0];
              const last = g.turns[g.turns.length - 1];
              const o = last
                ? OUTCOME[last.status] ?? { label: last.status, cls: 'info' }
                : { label: 'Not run yet', cls: 'info' };
              return (
                <tr key={g.sessionId} className="cd-row-click" onClick={() => { setSel(g.sessionId); setTab('resume'); setTurnSel(null); }}>
                  <td className="cd-row-title">{g.title}</td>
                  <td>
                    <span className={`cd-pill ${o.cls}`}>{o.label}</span>
                  </td>
                  <td>{g.turns.length}</td>
                  <td>{g.at ? when(g.at) : '—'}</td>
                  <td>{first?.tenantId ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {/* `wide` only while the canvas is up. `.cd-page > *` caps every child
          at a 1024px reading measure, which is right for the transcript and
          the event list and wrong for a journey — it threw away 640px of a
          1900px window and clipped the graph to what was left. The measure
          stays for the two tabs that are prose. */}
      {session && (
      <div className={`cd-logs single ${tab === 'journey' && built ? 'wide' : ''}`}>
        <div className="cd-logdetail">
          {/* OPENS ON THE CHAT, NOT ON ITS LAST RUN.
              This was gated on `current` — the most recent RunLog — so a chat
              with no completed run could be listed and not opened: the row
              highlighted and the pane stayed blank. The chat whose first turn
              failed is exactly the one someone comes back to, so it is the
              worst one to have been unopenable. The run-specific facts below
              are each guarded instead. */}
          {session && (
            <>
              <div className="cd-logdetail-h">
                {/* The title is in the page head now that a chat opens full
                    width. Printing it again here was the split-pane layout
                    showing through. */}
                <dl className="cd-deflist compact">
                  <dt>When</dt>
                  <dd>{session.at ? fmtStamp(session.at) : 'Not run yet'}</dd>
                  <dt>Tenant</dt>
                  <dd>{current?.tenantId ?? 'not recorded'}</dd>
                  <dt>Outcome</dt>
                  <dd>{current ? (OUTCOME[current.status] ?? { label: current.status }).label : 'Not run yet'}</dd>
                  {current?.validationOutcome && (
                    <>
                      <dt>Validation</dt>
                      <dd>
                        {current.validationOutcome === 'failed'
                          ? 'Blocked. Information is missing'
                          : current.validationOutcome === 'incomplete'
                            ? 'Passed. Some checks still need a person to confirm'
                            : 'All checks passed'}
                      </dd>
                    </>
                  )}
                </dl>

              {/* RESUME IS THE PRIMARY ACTION on this page, which is why it
                  sits in the header rather than under the transcript. The
                  list exists so a conversation can be picked back up; reading
                  it is the secondary use. */}
              <div className="cd-chat-actions">
                <button
                  className="cd-btn pri"
                  disabled={!session?.canResume || !onResume}
                  onClick={() => session && onResume?.(session.sessionId)}
                >
                  Continue this chat
                </button>
                <button
                  className="cd-btn"
                  onClick={() => {
                    if (!session) return;
                    deleteSession(session.sessionId);
                    setStored(listSessions());
                    setSel(null);
                  }}
                >
                  Delete
                </button>
                {!session?.canResume && (
                  <span className="cd-chat-note">
                    This chat was recorded before conversations were kept, so only its log remains.
                  </span>
                )}
              </div>

              <div className="cd-subtabs" role="tablist">
                <button
                  role="tab"
                  aria-selected={tab === 'resume'}
                  className={`cd-subtab ${tab === 'resume' ? 'on' : ''}`}
                  onClick={() => setTab('resume')}
                >
                  Conversation
                </button>
                <button
                  role="tab"
                  aria-selected={tab === 'logs'}
                  className={`cd-subtab ${tab === 'logs' ? 'on' : ''}`}
                  onClick={() => setTab('logs')}
                >
                  Logs
                </button>
                {/* Only when there is one. A tab that opens onto "no journey
                    was built" is a worse answer than the tab's absence, and
                    most chats never reach a build. */}
                {built && (
                  <button
                    role="tab"
                    aria-selected={tab === 'journey'}
                    className={`cd-subtab ${tab === 'journey' ? 'on' : ''}`}
                    onClick={() => setTab('journey')}
                  >
                    Journey
                  </button>
                )}
              </div>

              {/* The conversation, in order. This is the part that was
                  missing: the log could show that a turn happened and what
                  tools it called, but never what was said. */}
              {tab === 'resume' && (
              <div className="cd-transcript">
                <div className="cd-transcript-h">Conversation</div>
                {/* NO TURNS, BUT THERE MAY STILL BE A CONVERSATION.
                    This said "no completed turn yet" for a chat whose five
                    turns had all completed and whose logs had been evicted —
                    while the messages sat in the session store, unread. The
                    transcript is the conversation, so it comes from whichever
                    store still has it. */}
                {!session.turns.length && session.messages.length > 0 && (
                  <>
                    <div className="cd-tturn-note">
                      The detailed logs for this chat have been discarded to save space. This is the conversation as it
                      was saved.
                    </div>
                    {session.messages.map((m, i) => (
                      <div className={`cd-msg ${m.role}`} key={i}>
                        <div className="cd-msg-role">{m.role === 'user' ? 'You' : 'Agent'}</div>
                        <div className="cd-msg-bubble">{m.content}</div>
                      </div>
                    ))}
                  </>
                )}
                {!session.turns.length && !session.messages.length && (
                  <div className="cd-tturn-missing">
                    This chat has no completed turn yet. Continue it to pick up where you left off.
                  </div>
                )}
                {session.turns.map((t, n) => (
                  <div className="cd-tturn" key={t.runId}>
                    <div className="cd-tturn-n">Turn {n + 1}</div>
                    {t.userText && (
                      <div className="cd-msg user">
                        <div className="cd-msg-role">You</div>
                        <div className="cd-msg-bubble">{t.userText}</div>
                      </div>
                    )}
                    {t.reply && (
                      <div className="cd-msg assistant">
                        <div className="cd-msg-role">Agent</div>
                        <div className="cd-msg-bubble">{t.reply}</div>
                      </div>
                    )}
                    {!!t.questions?.length && (
                      <div className="cd-qs">
                        {t.questions.map((q, k) => (
                          <div className="cd-q" key={k}>
                            <span className="cd-q-n">{k + 1}</span>
                            {q}
                          </div>
                        ))}
                      </div>
                    )}
                    {!t.userText && !t.reply && (
                      <div className="cd-tturn-missing">
                        This was recorded before transcripts were kept. Only the events below are available.
                      </div>
                    )}
                  </div>
                ))}
              </div>
              )}
              </div>

              {/* END TO END, NOT JUST THE EVENT STREAM.
                  The Logs tab showed what happened and never what the agent
                  worked out. These are the two artefacts the whole agent
                  exists to produce — what it found about the customers, and
                  the plan it chose — read straight off the turn that produced
                  them, newest turn first. The raw timeline follows, and the
                  JSON is still behind every row. */}
              {/* THE BUILT JOURNEY, on the real canvas.
                  `DripCanvas` is the same component the builder and the
                  read-only campaign view use, fed the graph the application's
                  own reducer produced. READ-ONLY here, deliberately: this is
                  a record of what was built, and editing a past chat's canvas
                  from a log page would change a campaign with no conversation
                  around it. Continue the chat to change it.
                  This is NOT the propose-time preview, which is a schematic
                  precisely because no journey exists yet. Here one does. */}
              {tab === 'journey' && built && (
                <div className="cd-chat-journey">
                  <div className="cd-transcript-h">{built.name || 'The journey this chat built'}</div>
                  <div className="cd-chat-canvas" style={aspect ? { aspectRatio: aspect } : undefined}>
                    {/* `minZoom` 0.15: this is a journey being read back, not
                        one being edited, so fitting the whole thing beats
                        keeping every label legible at rest. The controls zoom
                        in. React Flow's 0.5 default clamped the fit and the
                        graph ran off all four edges. */}
                    <DripCanvas graph={built.root!} editable={false} goal={built.goal ?? null} minZoom={0.15} />
                  </div>
                </div>
              )}

              {/* EVERY TURN'S LOG, not just the last one. */}
              {tab === 'logs' && session.turns.length > 1 && (
                <div className="cd-turnpicker" role="tablist" aria-label="Turn">
                  {session.turns.map((t, n) => (
                    <button
                      key={t.runId}
                      role="tab"
                      aria-selected={t.runId === current?.runId}
                      className={`cd-turnpick ${t.runId === current?.runId ? 'on' : ''}`}
                      onClick={() => setTurnSel(t.runId)}
                    >
                      Turn {n + 1}
                    </button>
                  ))}
                </div>
              )}
              {tab === 'logs' && current && <RunSummary turn={current} />}
              {/* TWO DIFFERENT STATES, and saying the wrong one is how a
                  working chat came to look broken. A chat with messages and
                  no logs HAS run; its detail was evicted. A chat with
                  neither genuinely has not run yet. */}
              {tab === 'logs' && !current && (
                <div className="cd-tturn-missing">
                  {session.messages.length
                    ? 'The detailed logs for this chat have been discarded to save space. The conversation is still on the Conversation tab, and continuing the chat records new turns again.'
                    : 'No run has completed in this chat yet, so there is nothing to show.'}
                </div>
              )}
              {tab === 'logs' && current && (
              <div className="cd-timeline">
                {/* Text deltas are the streaming transport, not history —
                    hundreds of them would bury the meaningful events. The
                    assistant's finished message is already in the campaign
                    record. */}
                {current.events
                  .filter((e) => e.type !== 'model.text.delta')
                  .map((e) => {
                  const isError = e.status === 'failed';
                  return (
                    <div className={`cd-event ${isError ? 'bad' : ''}`} key={e.seq}>
                      {/* The event's own title wins; `friendlyEvent` is the
                          fallback for events that carry none. Two maps kept
                          in step by hand is how this tab and the Design
                          panel came to name the same run differently. */}
                      <div className="cd-event-k">{e.title?.trim() || friendlyEvent(e.type)}</div>
                      <div className="cd-event-s">
                        {e.detail?.trim() || friendlyEvent(e.type)}
                      </div>
                      <div className="cd-event-foot">
                        <span className="cd-event-t">
                          {fmtTime(e.at)}
                          {e.durationMs !== undefined ? ` · ${(e.durationMs / 1000).toFixed(1)}s` : ''}
                        </span>
                        {e.data != null && (
                          <button className="cd-link" onClick={() => setRawFor(rawFor === e.seq ? null : e.seq)}>
                            {rawFor === e.seq ? 'Hide details' : 'Details'}
                          </button>
                        )}
                      </div>
                      {/* A sentence, then the payload. The JSON stays —
                          it is why Details exists — but it is never the only
                          thing in the panel. */}
                      {rawFor === e.seq && e.data != null && (
                        <>
                          <p className="cd-event-lead">{detailsText(e)}</p>
                          <pre>{JSON.stringify(e.data, null, 1)}</pre>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
              )}
            </>
          )}
        </div>
      </div>
      )}
    </div>
  );
}