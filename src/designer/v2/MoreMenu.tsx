// "More options" (⋯) in the campaign header: the less frequent actions
// (versions, duplicate, activity, delete) in one dropdown, so the header keeps
// only what a manager needs every time. Esc or a click outside closes it.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';

export interface MoreItem {
  key: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
}

export function MoreMenu({ items, children }: { items: MoreItem[]; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  const btn = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btn.current?.focus();
      }
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus();
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  return (
    <span className="cv-del-wrap cv-more" ref={ref}>
      <button ref={btn} className="cv-btn" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} aria-label="More options" title="More options">
        <MoreHorizontal size={16} />
      </button>
      {open && (
        <div className="cv-more-list" role="menu" aria-label="More options">
          {items.map((it) => (
            <button
              key={it.key}
              role="menuitem"
              className={`cv-more-item${it.danger ? ' danger' : ''}`}
              disabled={it.disabled}
              title={it.title}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      )}
      {children}
    </span>
  );
}
