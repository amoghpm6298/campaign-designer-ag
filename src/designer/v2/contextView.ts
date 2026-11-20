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
  /** The AI rationale: why these customers are stuck and the lever (the agent's reasoning, not a fact). */
  rationale?: string;
  evidence?: EvidenceLevel;
  evidenceNotes?: string;
  metric?: string;
  sql?: string;
  size?: number;
  sizeError?: string;
  /** Level 2: what holds this group back, as the data (or the manager) shows it. */
  whyStuck?: string;
  /** The notebook topics of the queries that show it. */
  whyStuckQueries?: string[];
  /** "data" when it cites queries; "manager" or "hypothesis" without data. */
  whyStuckBasis?: string;
  /** Level 3: what that finding changed in the design. */
  soWe?: string;
  soWeSteps?: string[];
  /** The latest independent grade of the two notes. */
  insightCheck?: { pass: boolean; reason: string; at: string };
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
      else if (topic === 'rationale' || topic === 'thesis') v.rationale = e.text; // "thesis": campaigns before the rename
      else if (topic === 'metric') v.metric = e.text;
      else if (topic === 'why stuck') {
        v.whyStuck = e.text;
        const q = e.data?.queries;
        v.whyStuckQueries = Array.isArray(q) ? q.filter((x): x is string => typeof x === 'string') : [];
        v.whyStuckBasis = typeof e.data?.basis === 'string' ? e.data.basis : v.whyStuckQueries.length ? 'data' : undefined;
      } else if (topic === 'so we') {
        v.soWe = e.text;
        const st = e.data?.steps;
        v.soWeSteps = Array.isArray(st) ? st.filter((x): x is string => typeof x === 'string') : [];
      } else if (topic === 'insight check') v.insightCheck = { pass: e.data?.pass === true, reason: e.text, at: e.at };
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
