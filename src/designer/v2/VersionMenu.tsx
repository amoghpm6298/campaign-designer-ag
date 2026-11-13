// The version dropdown in the top bar: every saved version of the campaign
// object, newest first, with what changed. Pick one to view it read-only; the
// banner on the canvas offers to restore it.
import { useEffect, useRef, useState } from 'react';
import { ChevronDown, History, MessageSquare, RotateCcw, SlidersHorizontal } from 'lucide-react';
import type { VersionEntry } from './types';

const ago = (iso: string) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short' });
};

const SOURCE: Record<VersionEntry['source'], { icon: React.ReactNode; label: string }> = {
  chat: { icon: <MessageSquare size={12} />, label: 'From chat' },
  direct: { icon: <SlidersHorizontal size={12} />, label: 'Edited directly' },
  rollback: { icon: <RotateCcw size={12} />, label: 'Restored' },
  migration: { icon: <History size={12} />, label: 'Starting point' },
};

export function VersionMenu({ versions, viewing, onView }: { versions: VersionEntry[]; viewing: number | null; onView: (n: number) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const latest = versions[versions.length - 1];
  const shown = viewing ?? latest?.n;
  return (
    <div className="cv-ver" ref={ref}>
      <button className={`cv-btn${viewing ? ' cv-ver-old' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <History size={14} /> v{shown}
        <span className="cv-ver-when">· {viewing ? 'viewing' : ago(latest.at)}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="cv-ver-list" role="menu">
          <div className="cv-ver-head">Versions of this campaign</div>
          {[...versions].reverse().map((v) => (
            <button
              key={v.n}
              role="menuitem"
              className={`cv-ver-item${v.n === shown ? ' on' : ''}`}
              onClick={() => {
                setOpen(false);
                onView(v.n);
              }}
            >
              <span className="cv-ver-top">
                <b>v{v.n}</b>
                {v.n === latest.n && <span className="cv-ver-cur">Current</span>}
                <span className="cv-ver-src" title={SOURCE[v.source].label}>
                  {SOURCE[v.source].icon} {SOURCE[v.source].label}
                </span>
                <span className="cv-ver-at">{ago(v.at)}</span>
              </span>
              <span className="cv-ver-sum">{v.summary}</span>
              {(v.counts.added || v.counts.changed || v.counts.removed) && v.source !== 'migration' ? (
                <span className="cv-ver-counts">
                  {v.counts.added ? <span className="add">+{v.counts.added}</span> : null}
                  {v.counts.changed ? <span className="chg">~{v.counts.changed}</span> : null}
                  {v.counts.removed ? <span className="rem">−{v.counts.removed}</span> : null}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
