// Personal words in messages: one message, filled in per customer. The AI
// writes a field, never a value: {{top_category | "everyday spends"}}. The
// engine puts in each customer's own value when it sends (the fallback when
// it has none), formatted by code. Shared by the server's checks and the
// canvas preview, so both read a field the same way.

export interface FieldRef {
  /** The whole placeholder as written, e.g. {{top_category | "everyday spends"}}. */
  raw: string;
  key: string;
  /** Null when no fallback was given (the checks refuse that). */
  fallback: string | null;
  index: number;
}

const FIELD = /\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|\s*(?:"([^"]*)"|'([^']*)'|([^}]*?)))?\s*\}\}/g;

/** Every {{field}} in a text. */
export function parseFields(text: string): FieldRef[] {
  const out: FieldRef[] = [];
  for (const m of (text ?? '').matchAll(FIELD)) {
    const fb = m[2] ?? m[3] ?? (m[4] !== undefined ? m[4].trim() : undefined);
    out.push({ raw: m[0], key: m[1], fallback: fb === undefined || fb === '' ? null : fb, index: m.index ?? 0 });
  }
  return out;
}

/** Braces that look like a field but aren't one (e.g. "{top_category}" or "{{ }}"). */
export function malformedFields(text: string): string[] {
  const t = (text ?? '').replace(FIELD, '');
  return [...t.matchAll(/\{+[^{}]*\}+/g)].map((m) => m[0]);
}

export type FieldType = 'number' | 'money' | 'days' | 'category' | 'bool';

/** How a value reads in a message. Code formats; the AI never writes values. */
export function formatValue(key: string, type: FieldType, value: unknown): string {
  if (value === null || value === undefined || value === '') return '';
  if (type === 'money') return `₹${Math.round(Number(value)).toLocaleString('en-IN')}`;
  if (type === 'days') return `${Math.round(Number(value))} days`;
  if (key === 'tenure_months') {
    const m = Math.max(0, Math.round(Number(value)));
    if (m < 12) return `${m} month${m === 1 ? '' : 's'}`;
    const y = Math.floor(m / 12);
    return `${y} year${y === 1 ? '' : 's'}`;
  }
  if (type === 'number') return Math.round(Number(value)).toLocaleString('en-IN');
  // Categories: words, not codes ("online_shopping" → "online shopping").
  return String(value).replace(/_/g, ' ').trim();
}

/** The text as one customer would read it, given a value per field (fallbacks otherwise). */
export function fillFields(text: string, valueOf: (ref: FieldRef) => string | null | undefined): string {
  return (text ?? '').replace(FIELD, (...args) => {
    const raw = args[0] as string;
    const ref = parseFields(raw)[0];
    const v = ref ? valueOf(ref) : null;
    return v || ref?.fallback || '';
  });
}
