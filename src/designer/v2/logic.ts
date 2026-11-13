// Pure helpers for the v2 UI: event merging, the ordered turn trace, and
// turning a filled-in question form into a reply. No React, unit-tested.

import type { AgentQuestion, V2Event } from './types';

/**
 * Adds a streamed event to the list. Events for the same correlation id
 * update one row; their `data` is MERGED, so the tool input sent when the
 * call started survives the completion event.
 */
export function mergeEvent(list: V2Event[], e: V2Event): V2Event[] {
  if (!e.correlationId) return [...list, e];
  const i = list.findIndex((p) => p.correlationId === e.correlationId);
  if (i === -1) return [...list, e];
  const prev = list[i];
  const merged: V2Event = {
    ...prev,
    ...e,
    seq: prev.seq,
    data:
      e.type === 'model.text.delta'
        ? { ...prev.data, ...e.data, text: `${prev.data?.text ?? ''}${e.data?.text ?? ''}` }
        : { ...(prev.data ?? {}), ...(e.data ?? {}) },
  };
  const copy = list.slice();
  copy[i] = merged;
  return copy;
}

export type TraceItem =
  | { kind: 'text'; id: string; text: string }
  | { kind: 'tool'; id: string; event: V2Event };

/** One ordered list: the agent's text and its tool calls, in the order they happened. */
export function buildTrace(events: V2Event[]): TraceItem[] {
  return events
    .filter((e) => e.type === 'model.text.delta' || e.type.startsWith('model.tool_call'))
    .slice()
    .sort((a, b) => a.seq - b.seq)
    .map((e): TraceItem | null =>
      e.type === 'model.text.delta'
        ? (e.data?.text ?? '').trim()
          ? { kind: 'text', id: e.correlationId ?? String(e.seq), text: String(e.data?.text).trim() }
          : null
        : { kind: 'tool', id: e.correlationId ?? String(e.seq), event: e },
    )
    .filter((x): x is TraceItem => x !== null);
}

export const toolCount = (events: V2Event[] | undefined) =>
  (events ?? []).filter((e) => e.type.startsWith('model.tool_call')).length;

export const totalMs = (events: V2Event[] | undefined) =>
  (events ?? []).filter((e) => e.type.startsWith('model.tool_call')).reduce((n, e) => n + (e.durationMs ?? 0), 0);

// --- the question form --------------------------------------------------------

export interface FieldState {
  /** Picked options (yesno/single: at most one). */
  picked: string[];
  /** Other is selected. */
  other: boolean;
  /** The Other text. */
  text: string;
  /** Skipped on its own: struck out, no answer, the agent assumes it. */
  skipped?: boolean;
}

export const emptyField = (): FieldState => ({ picked: [], other: false, text: '', skipped: false });

/** The question text without its **bold** markers, for transcripts and the chat history. */
export const plainText = (s: string) => s.replace(/\*\*/g, '');

/**
 * The question as the form shows it. Chats saved before every question had
 * answers to tap may hold an "open" question: it becomes multi with its
 * example replies as options, or yes/no if it had none.
 */
export function toFormQuestion(q: AgentQuestion): AgentQuestion {
  if (q.answerType === 'yesno') return { ...q, options: ['Yes', 'No'] };
  if (q.answerType !== 'open' && q.options?.length) return q;
  const options = [...(q.options ?? []), ...(q.suggestions ?? [])].slice(0, 4);
  return options.length ? { ...q, answerType: 'multi', options } : { ...q, answerType: 'yesno', options: ['Yes', 'No'] };
}

export function answerOf(q: AgentQuestion, f: FieldState | undefined): string {
  if (!f || f.skipped) return '';
  const other = f.other && f.text.trim() ? `Other: ${f.text.trim()}` : '';
  if (q.answerType === 'multi') return [...f.picked, other].filter(Boolean).join(', ');
  return f.picked[0] ?? other;
}

export function isAnswered(q: AgentQuestion, f: FieldState | undefined): boolean {
  return answerOf(q, f).length > 0;
}

/**
 * The reply the form sends: one readable message for the transcript, plus a
 * per-question map so the backend knows exactly which questions were answered.
 * Blank questions are left out and stay open.
 */
export function composeReply(questions: AgentQuestion[], fields: Record<string, FieldState>): { message: string; answers: Record<string, string> } {
  const answers: Record<string, string> = {};
  const lines: string[] = [];
  let aspect = '';
  for (const q of questions) {
    const a = answerOf(q, fields[q.id]);
    const skipped = !!fields[q.id]?.skipped;
    if (!a && !skipped) continue;
    if (a) answers[q.id] = a;
    if (q.aspect !== aspect) {
      aspect = q.aspect;
      lines.push(`${lines.length ? '\n' : ''}**${aspect}**`);
    }
    lines.push(a ? `- ${plainText(q.text)} → ${a}` : `- Skipped: ${plainText(q.text)}`);
  }
  return { message: lines.join('\n'), answers };
}

/** Questions grouped by aspect, keeping first-seen order. */
export function groupByAspect(questions: AgentQuestion[]): { aspect: string; questions: AgentQuestion[] }[] {
  const out: { aspect: string; questions: AgentQuestion[] }[] = [];
  for (const q of questions) {
    const g = out.find((x) => x.aspect === q.aspect);
    if (g) g.questions.push(q);
    else out.push({ aspect: q.aspect, questions: [q] });
  }
  return out;
}
