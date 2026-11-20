// Inline sources, Perplexity-style. The designer cites what it writes: [Q7] a
// query it ran (filed with its rows), [M] the manager's answers, [O] the offer
// menu. Each marker becomes a small chip; clicking it shows the source (the
// query's purpose, rows and SQL). A "Sources" footer lists what a text cites.
// Every cited number has been checked against these rows by the server
// (server/agent/citations.ts).
import { createContext, useContext, useState, type ReactNode, type SyntheticEvent } from 'react';
import { X } from 'lucide-react';

export interface SourceInfo {
  id: string;
  title: string;
  columns?: string[];
  rows?: Record<string, unknown>[];
  sql?: string;
  lines?: string[];
}

export type SourceLookup = (id: string) => SourceInfo | null;
export const SourcesContext = createContext<SourceLookup>(() => null);

const MARKER = /\[(Q\d+|M|O)\]/g;

type EntryLike = { kind: string; topic: string; text: string; source?: string; data?: Record<string, unknown> | null };

/** Builds the lookup from the campaign's notebook entries. */
export function sourcesFromEntries(entries: EntryLike[] | null | undefined, managerSaid: string[] = []): SourceLookup {
  const byId = new Map<string, SourceInfo>();
  const answers: string[] = [];
  for (const e of entries ?? []) {
    const d = (e.data ?? {}) as { qid?: unknown; purpose?: unknown; question?: unknown; sql?: unknown; columns?: unknown; rows?: unknown; queries?: { rows?: unknown; columns?: unknown; sql?: unknown }[] };
    if (typeof d.qid === 'string') {
      const q0 = Array.isArray(d.queries) ? d.queries[0] : undefined;
      const rows = (Array.isArray(d.rows) ? d.rows : Array.isArray(d.queries) ? d.queries.flatMap((q) => (Array.isArray(q.rows) ? q.rows : [])) : []) as Record<string, unknown>[];
      byId.set(d.qid, {
        id: d.qid,
        title: String(d.purpose ?? d.question ?? e.text ?? e.topic),
        rows,
        columns: Array.isArray(d.columns) ? (d.columns as string[]) : Array.isArray(q0?.columns) ? (q0!.columns as string[]) : rows[0] ? Object.keys(rows[0]) : [],
        sql: typeof d.sql === 'string' ? d.sql : typeof q0?.sql === 'string' ? (q0.sql as string) : undefined,
      });
    }
    if (e.kind === 'answer') answers.push(`${e.topic.replace(/^[^:]*:\s*/, '')} → ${e.text}`);
  }
  return (id) => {
    if (id === 'M') return { id, title: 'What you told the designer', lines: [...managerSaid.map((t) => t.replace(/\s+/g, ' ').trim()).filter(Boolean), ...answers] };
    if (id === 'O') return { id, title: "The bank's offer menu", lines: ['Offer terms and costs as listed in the incentive menu.'] };
    return byId.get(id) ?? null;
  };
}

const fmt = (v: unknown) => (typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-IN') : (+v.toFixed(2)).toLocaleString('en-IN')) : String(v ?? ''));

/** One chip. Unknown ids render struck through: the server will have flagged them. */
export function Cite({ id }: { id: string }) {
  const lookup = useContext(SourcesContext);
  const [open, setOpen] = useState(false);
  const src = lookup(id);
  const stop = (e: SyntheticEvent) => e.stopPropagation();
  const label = id === 'M' ? 'You' : id === 'O' ? 'Offer' : id;
  return (
    <span className="cv-cite-wrap nodrag nopan nowheel" onClick={stop}>
      <button
        type="button"
        className={`cv-cite${src ? '' : ' missing'}`}
        title={src ? src.title : 'Source not found'}
        aria-expanded={open}
        onClick={(e) => {
          stop(e);
          if (src) setOpen((v) => !v);
        }}
      >
        {label}
      </button>
      {open && src && (
        <span className="cv-cite-pop" role="dialog" aria-label={`Source ${label}`}>
          <span className="cv-cite-head">
            <b>{src.title}</b>
            <button type="button" className="cv-cite-x" aria-label="Close" onClick={(e) => (stop(e), setOpen(false))}>
              <X size={12} />
            </button>
          </span>
          {src.lines && (
            <span className="cv-cite-lines">
              {src.lines.length ? src.lines.map((l, i) => <span key={i}>{l}</span>) : <span>Nothing on file.</span>}
            </span>
          )}
          {src.rows && (
            <span className="cv-cite-table">
              <table>
                <thead>
                  <tr>{(src.columns ?? []).map((c) => <th key={c}>{c.replace(/_/g, ' ')}</th>)}</tr>
                </thead>
                <tbody>
                  {src.rows.slice(0, 20).map((r, i) => (
                    <tr key={i}>{(src.columns ?? []).map((c) => <td key={c}>{fmt(r[c])}</td>)}</tr>
                  ))}
                </tbody>
              </table>
              {src.rows.length > 20 && <span className="cv-cite-more">and {src.rows.length - 20} more rows</span>}
            </span>
          )}
          {src.sql && (
            <details className="cv-cite-sql">
              <summary>How it was counted</summary>
              <code>{src.sql}</code>
            </details>
          )}
        </span>
      )}
    </span>
  );
}

/** A string with its markers turned into chips (other text untouched). */
export function withCites(text: string, key = 'c'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(MARKER)) {
    if ((m.index ?? 0) > last) out.push(text.slice(last, m.index));
    out.push(<Cite key={`${key}-${n++}`} id={m[1]} />);
    last = (m.index ?? 0) + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** The ids a text cites, in order of first use. */
export const citedIds = (text: string) => [...new Set([...(text ?? '').matchAll(MARKER)].map((m) => m[1]))];

/** "Sources" under a text: each cited source by name. Built from the markers, so it can't drift. */
export function SourcesFooter({ text }: { text: string }) {
  const lookup = useContext(SourcesContext);
  const ids = citedIds(text);
  if (!ids.length) return null;
  return (
    <div className="cv-sources">
      <span className="cv-sources-label">Sources</span>
      {ids.map((id) => (
        <span key={id} className="cv-sources-item">
          <Cite id={id} /> {lookup(id)?.title ?? 'Not found'}
        </span>
      ))}
    </div>
  );
}
