// The chat on the right: the conversation, what the agent did on each turn
// (as compact chips you can open), and a cue card that points at the canvas.
import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, ArrowUp, Check, ChevronRight, Highlighter, LayoutDashboard, Loader2, MessageCircleQuestion, Pencil, X } from 'lucide-react';
import { RichText } from '../RichText';
import { buildTrace } from './logic';
import type { AnswerItem, Focus, V2Event, V2Turn } from './types';

export interface Cue {
  icon: 'question' | 'busy' | 'ready' | 'changed';
  title: string;
  text: string;
  action?: { label: string; run: () => void };
  secondary?: { label: string; run: () => void };
}

const STARTERS = ['Get new cardholders to activate their card', 'I want to drive spends during Diwali', 'Convert big-ticket purchases to EMI'];

export function ChatPanel({
  turns,
  live,
  busy,
  cue,
  placeholder,
  onSend,
  locked,
  onShowFocus,
}: {
  turns: V2Turn[];
  live: V2Event[];
  busy: boolean;
  cue: Cue | null;
  placeholder: string;
  onSend: (text: string) => void;
  locked?: boolean;
  onShowFocus?: (f: Focus) => void;
}) {
  const [draft, setDraft] = useState('');
  const [openAnswers, setOpenAnswers] = useState<AnswerItem[] | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, live.length, cue?.title]);
  const submit = () => {
    if (busy || !draft.trim()) return;
    onSend(draft.trim());
    setDraft('');
  };

  return (
    <section className="cv-chat">
      <header className="cv-chat-head">
        <b>Chat</b>
        <span className={`cv-status${busy ? ' busy' : ''}`}>{busy ? 'Working' : 'Ready'}</span>
      </header>
      <div className="cv-msgs">
        {!turns.length && (
          <div className="cv-empty">
            <h2>What should this campaign achieve?</h2>
            <p>Say it in a sentence. The agent asks a few questions, splits your customers into behavioural buckets, and builds one campaign with a journey for each. Change anything afterwards by asking here.</p>
            {STARTERS.map((s) => (
              <button key={s} className="v2-chip" onClick={() => onSend(s)}>
                {s}
              </button>
            ))}
          </div>
        )}
        {turns.map((t, i) =>
          t.role === 'user' ? (
            <div className="cv-msg user" key={i}>
              {t.answerSet ? (
                <AnswersBubble items={t.answerSet} onOpen={() => setOpenAnswers(t.answerSet!)} />
              ) : (
                <div className="cv-bubble user">
                  {t.focus && (
                    <button className="cv-focus-tag" onClick={() => onShowFocus?.(t.focus!)} title="Show this box on the canvas">
                      <Pencil size={11} /> {t.focusLabel ?? 'A box on the canvas'}
                    </button>
                  )}
                  <RichText text={t.content} />
                </div>
              )}
            </div>
          ) : (
            <div className="cv-msg agent" key={i}>
              <ToolChips events={t.events ?? []} live={false} finalText={t.content} />
              {t.content && (
                <div className="cv-bubble agent">
                  <RichText text={t.content} />
                </div>
              )}
              {t.error && (
                <div className="v2-error">
                  <AlertCircle size={14} /> {t.error}
                </div>
              )}
            </div>
          ),
        )}
        {busy && (
          <div className="cv-msg agent">
            <ToolChips events={live} live finalText="" />
          </div>
        )}
        {cue && (
          <div className={`cv-cue ${cue.icon}`}>
            <div className="cv-cue-top">
              <span className="cv-cue-icon">
                {cue.icon === 'busy' ? (
                  <Loader2 size={15} className="v2-spin" />
                ) : cue.icon === 'question' ? (
                  <MessageCircleQuestion size={15} />
                ) : cue.icon === 'changed' ? (
                  <Highlighter size={15} />
                ) : (
                  <LayoutDashboard size={15} />
                )}
              </span>
              <b>{cue.title}</b>
            </div>
            <p className="cv-cue-text">{cue.text}</p>
            {cue.action && (
              <button className="cv-cue-btn" onClick={cue.action.run}>
                {cue.action.label}
                <ArrowRight size={14} />
              </button>
            )}
            {cue.secondary && (
              <button className="cv-cue-link" onClick={cue.secondary.run}>
                {cue.secondary.label}
              </button>
            )}
          </div>
        )}
        <div ref={endRef} />
      </div>
      {openAnswers && <AnswersModal items={openAnswers} onClose={() => setOpenAnswers(null)} />}
      <div className="cv-compose">
        <textarea
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          rows={1}
          disabled={busy || locked}
        />
        <button className="cv-send" onClick={submit} disabled={busy || !draft.trim()} aria-label="Send">
          {busy ? <Loader2 size={16} className="v2-spin" /> : <ArrowUp size={16} />}
        </button>
      </div>
    </section>
  );
}

/** What the agent did on a turn: its tool calls as chips, and while live, its running text. */
function ToolChips({ events, live, finalText }: { events: V2Event[]; live: boolean; finalText: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const items = buildTrace(events);
  const tools = items.filter((it) => it.kind === 'tool');
  // While live the agent's words stream in here; once done they move to the bubble.
  const liveText = live ? items.filter((it) => it.kind === 'text').slice(-1)[0] : null;
  if (!tools.length && !live) return null;
  const opened = tools.find((t) => t.id === open);
  return (
    <div className="cv-chips-wrap">
      {tools.length > 0 && (
        <div className="cv-chips">
          {tools.map((it) => {
            if (it.kind !== 'tool') return null;
            const e = it.event;
            const running = e.status === 'running' && live;
            return (
              <button key={it.id} className={`cv-chip ${e.status}${open === it.id ? ' on' : ''}`} onClick={() => setOpen(open === it.id ? null : it.id)} title={e.detail ?? e.title}>
                {running ? <Loader2 size={11} className="v2-spin" /> : e.status === 'failed' ? <AlertCircle size={11} /> : <Check size={11} />}
                {e.title}
              </button>
            );
          })}
        </div>
      )}
      {opened && opened.kind === 'tool' && <ToolDetail e={opened.event} />}
      {liveText && liveText.kind === 'text' && !finalText && (
        <div className="cv-bubble agent live">
          <RichText text={liveText.text} />
        </div>
      )}
    </div>
  );
}

function ToolDetail({ e }: { e: V2Event }) {
  const [raw, setRaw] = useState(false);
  return (
    <div className="cv-tool-detail">
      {e.detail && <div className="v2-muted">{e.detail}</div>}
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

/** Your answers in the chat: just what you picked. Tap for every question. */
function AnswersBubble({ items, onOpen }: { items: AnswerItem[]; onOpen: () => void }) {
  const answered = items.filter((x) => !x.skipped);
  const skipped = items.length - answered.length;
  return (
    <button className="cv-bubble user cv-answers" onClick={onOpen} title="See every question and your answer">
      <span className="cv-answers-head">
        {answered.length ? `Answered ${answered.length}` : 'Skipped the questions'}
        {answered.length && skipped ? ` · skipped ${skipped}` : !answered.length ? ` (${skipped})` : ''}
        <ChevronRight size={14} />
      </span>
      {answered.length > 0 && (
        <span className="cv-answers-pills">
          {answered.map((x, i) => (
            <span key={i} className="cv-answer-pill">
              {x.answer}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

function AnswersModal({ items, onClose }: { items: AnswerItem[]; onClose: () => void }) {
  const groups: { aspect: string; items: AnswerItem[] }[] = [];
  for (const it of items) {
    const g = groups.find((x) => x.aspect === it.aspect);
    if (g) g.items.push(it);
    else groups.push({ aspect: it.aspect, items: [it] });
  }
  return (
    <div className="cv-modal-scrim" onClick={onClose}>
      <div className="cv-modal" role="dialog" aria-label="Your answers" onClick={(e) => e.stopPropagation()}>
        <header>
          <b>Your answers</b>
          <button className="cv-icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>
        <div className="cv-modal-body">
          {groups.map((g) => (
            <section key={g.aspect}>
              <div className="cv-modal-aspect">{g.aspect}</div>
              {g.items.map((x, i) => (
                <div key={i} className="cv-modal-q">
                  <div className="cv-modal-qtext">{x.question}</div>
                  {x.skipped ? <div className="cv-modal-skip">Skipped: the agent assumed this and said so</div> : <div className="cv-modal-ans">{x.answer}</div>}
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
