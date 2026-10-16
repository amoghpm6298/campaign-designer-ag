// Run Logs — what the agent actually did.
//
// Every event here is recorded by the orchestrator during a real run. Nothing
// is fabricated, and no API key or model reasoning is stored — only structured
// decisions and the evidence behind them.
import { useMemo, useState } from 'react';
import { clearRunLogs } from './storage';
import { friendlyEvent } from './status';
import type { RunLog } from './types';
import './designer.css';

interface Props {
  logs: RunLog[];
  onCleared: () => void;
  onStartDesigning?: () => void;
}

const OUTCOME: Record<string, { label: string; cls: string }> = {
  proposed: { label: 'Campaign designed', cls: 'ok' },
  discovery: { label: 'Questions asked', cls: 'info' },
  blocked: { label: 'Needs input', cls: 'warn' },
  error: { label: 'Failed', cls: 'bad' },
  export: { label: 'Exported', cls: 'info' },
};

const when = (iso: string) => {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

export function RunLogsView({ logs, onCleared, onStartDesigning }: Props) {
  const [sel, setSel] = useState<string | null>(null);
  const [rawFor, setRawFor] = useState<number | null>(null);

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
    // Oldest turn first within a session, so it reads as a conversation.
    return [...by.entries()].map(([sessionId, turns]) => ({
      sessionId,
      turns: [...turns].sort((x, y) => x.startedAt.localeCompare(y.startedAt)),
    }));
  }, [logs]);

  const session = sessions.find((g) => g.sessionId === sel) ?? sessions[0] ?? null;
  const current = session?.turns[session.turns.length - 1] ?? null;

  if (!logs.length) {
    return (
      <div className="cd-page">
        <h1>Run Logs</h1>
        <p className="cd-lede">
          Every campaign the agent designs is recorded here — the objective you gave it, the questions it asked, the
          context it used, the journey it built and whether validation passed.
        </p>
        <div className="cd-empty-panel">
          <div className="cd-empty-title">No runs yet</div>
          <p>Design a campaign and its full history will appear here, so you can see exactly how it was produced.</p>
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
          <h1>Run Logs</h1>
          <p className="cd-lede">
            {logs.length} run{logs.length > 1 ? 's' : ''}, newest first. Stored in this browser.
          </p>
        </div>
        <button className="cd-btn" onClick={() => { clearRunLogs(); setSel(null); onCleared(); }}>
          Clear history
        </button>
      </div>

      <div className="cd-logs">
        <div className="cd-loglist">
          {sessions.map((g) => {
            // A session is labelled by what it set out to do, which is its
            // FIRST message, and judged by where it ended up, which is its
            // last turn's outcome.
            const first = g.turns[0];
            const last = g.turns[g.turns.length - 1];
            const o = OUTCOME[last.status] ?? { label: last.status, cls: 'info' };
            return (
              <button
                key={g.sessionId}
                className={`cd-logrow ${session?.sessionId === g.sessionId ? 'on' : ''}`}
                onClick={() => setSel(g.sessionId)}
              >
                <div className="cd-logrow-t">{first.title || 'Untitled campaign'}</div>
                <div className="cd-logrow-m">
                  <span className={`cd-pill ${o.cls}`}>{o.label}</span>
                  <span>{g.turns.length} turn{g.turns.length === 1 ? '' : 's'}</span>
                  <span>{when(first.startedAt)}</span>
                </div>
                {first.tenantId && <div className="cd-logrow-s">{first.tenantId}</div>}
              </button>
            );
          })}
        </div>

        <div className="cd-logdetail">
          {current && (
            <>
              <div className="cd-logdetail-h">
                <div className="cd-logdetail-t">{current.title || 'Untitled campaign'}</div>
                <dl className="cd-deflist compact">
                  <dt>When</dt>
                  <dd>{new Date(current.startedAt).toLocaleString()}</dd>
                  <dt>Tenant</dt>
                  <dd>{current.tenantId ?? 'not recorded'}</dd>
                  <dt>Outcome</dt>
                  <dd>{(OUTCOME[current.status] ?? { label: current.status }).label}</dd>
                  {current.validationOutcome && (
                    <>
                      <dt>Validation</dt>
                      <dd>
                        {current.validationOutcome === 'failed'
                          ? 'Blocked — required information missing'
                          : current.validationOutcome === 'incomplete'
                            ? 'Passed, with checks a person must confirm'
                            : 'All checks passed'}
                      </dd>
                    </>
                  )}
                </dl>

              {/* The conversation, in order. This is the part that was
                  missing: the log could show that a turn happened and what
                  tools it called, but never what was said. */}
              <div className="cd-transcript">
                <div className="cd-transcript-h">Conversation</div>
                {session?.turns.map((t, n) => (
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
                        Recorded before the transcript was kept, so only the events below survive.
                      </div>
                    )}
                  </div>
                ))}
              </div>
              </div>

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
                      <div className="cd-event-k">{friendlyEvent(e.type)}</div>
                      <div className="cd-event-s">
                        {e.title}
                        {e.detail ? <span className="cd-event-d"> — {e.detail}</span> : null}
                      </div>
                      <div className="cd-event-foot">
                        <span className="cd-event-t">
                          {new Date(e.at).toLocaleTimeString()}
                          {e.durationMs !== undefined ? ` · ${(e.durationMs / 1000).toFixed(1)}s` : ''}
                        </span>
                        {e.data != null && (
                          <button className="cd-link" onClick={() => setRawFor(rawFor === e.seq ? null : e.seq)}>
                            {rawFor === e.seq ? 'Hide details' : 'Details'}
                          </button>
                        )}
                      </div>
                      {rawFor === e.seq && e.data != null && <pre>{JSON.stringify(e.data, null, 1)}</pre>}
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
