// Reading the campaign context: an append-only list of dated entries, where
// the current value of anything is its latest entry. Pure, shared by the
// server (agent tools, status block) and the browser (the canvas cards).

export interface ContextEntryLike {
  id: string;
  at: string;
  kind: string;
  topic: string;
  bucketId?: string;
  text: string;
  source: string;
  data?: Record<string, unknown>;
}

export interface ContextFilter {
  kind?: string;
  bucketId?: string;
  topic?: string;
}

export const contextKey = (e: Pick<ContextEntryLike, 'kind' | 'bucketId' | 'topic'>) => `${e.kind}|${e.bucketId ?? ''}|${e.topic.trim().toLowerCase()}`;

const matches = (e: ContextEntryLike, f: ContextFilter) =>
  (!f.kind || e.kind === f.kind) && (!f.bucketId || e.bucketId === f.bucketId) && (!f.topic || e.topic.trim().toLowerCase() === f.topic.trim().toLowerCase());

/** The current entries: the latest for each (kind, bucket, topic), in the order they were first written. */
export function currentEntries<E extends ContextEntryLike>(entries: E[], filter: ContextFilter = {}): E[] {
  const latest = new Map<string, E>();
  const order: string[] = [];
  for (const e of entries) {
    const k = contextKey(e);
    if (!latest.has(k)) order.push(k);
    latest.set(k, e);
  }
  return order.map((k) => latest.get(k)!).filter((e) => matches(e, filter));
}

/** Every version of the matching entries, oldest first. */
export function entryHistory<E extends ContextEntryLike>(entries: E[], filter: ContextFilter = {}): E[] {
  return entries.filter((e) => matches(e, filter));
}

export type EvidenceLevel = 'measured' | 'manager' | 'hypothesis';

export interface BucketView {
  behaviour?: string;
  thesis?: string;
  evidence?: EvidenceLevel;
  evidenceNotes?: string;
  metric?: string;
  sql?: string;
  size?: number;
  sizeError?: string;
}

/** Each bucket's reasoning and sizing, as the cards and the status block show it. */
export function bucketContext(entries: ContextEntryLike[]): Record<string, BucketView> {
  const out: Record<string, BucketView> = {};
  for (const e of currentEntries(entries)) {
    if (!e.bucketId) continue;
    const v = (out[e.bucketId] ??= {});
    const topic = e.topic.trim().toLowerCase();
    if (e.kind === 'bucket') {
      if (topic === 'behaviour' || topic === 'behavior') v.behaviour = e.text;
      else if (topic === 'thesis') v.thesis = e.text;
      else if (topic === 'metric') v.metric = e.text;
      else if (topic === 'evidence') {
        const level = e.data?.level;
        if (level === 'measured' || level === 'manager' || level === 'hypothesis') v.evidence = level;
        v.evidenceNotes = e.text;
      }
    } else if (e.kind === 'sizing') {
      const d = e.data ?? {};
      if (typeof d.sql === 'string') v.sql = d.sql;
      if (typeof d.size === 'number') {
        v.size = d.size;
        delete v.sizeError;
      } else if (typeof d.error === 'string') {
        v.sizeError = d.error;
        delete v.size;
      }
    }
  }
  return out;
}

/** The current campaign-level note for a topic (e.g. "everyone_else", "segmentation"). */
export function noteText(entries: ContextEntryLike[], topic: string): string | undefined {
  return currentEntries(entries, { kind: 'note', topic })[0]?.text;
}
