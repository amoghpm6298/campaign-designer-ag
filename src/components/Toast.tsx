// Native replacement for the original's showToast() — same role (a
// transient confirmation after save/approve/pause/kill), real React
// state instead of a global DOM singleton.
import { useEffect } from 'react';

export interface ToastState {
  message: string;
  type?: 'success' | 'error';
}

export function Toast({ toast, onDismiss }: { toast: ToastState | null; onDismiss: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(onDismiss, 3500);
    return () => clearTimeout(t);
  }, [toast, onDismiss]);

  if (!toast) return null;
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        background: toast.type === 'error' ? 'var(--error-text)' : 'var(--neutral-900)',
        color: '#fff',
        padding: '10px 18px',
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 600,
        boxShadow: '0 10px 15px -3px rgba(16,24,40,.15)',
        zIndex: 100,
        maxWidth: 420,
      }}
    >
      {toast.message}
    </div>
  );
}
