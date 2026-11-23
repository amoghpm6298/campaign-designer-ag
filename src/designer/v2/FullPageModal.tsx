// A full-page reader over the whole designer: the campaign strategy and the
// cost of the campaign open here, so they can be read properly rather than in
// a narrow drawer. Closes with ✕, Esc or a click on the backdrop; focus moves
// in on open and back to whatever opened it on close.
import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function FullPageModal({ kicker, title, onClose, children, wide }: { kicker?: ReactNode; title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
    // Open once; onClose identity changes are irrelevant here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Rendered in place (fixed), not in a portal: the designer's colour tokens are scoped to its container.
  return (
    <div className="fpm-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={box} className={`fpm${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
        <header className="fpm-head">
          <div>
            {kicker && <div className="fpm-kicker">{kicker}</div>}
            <h2>{title}</h2>
          </div>
          <button className="fpm-x" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="fpm-body">{children}</div>
      </div>
    </div>
  );
}
