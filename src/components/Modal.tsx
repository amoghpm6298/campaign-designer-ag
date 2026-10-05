// Native replacement for the original's showModal()/closeModal() —
// used here only for the Kill Switch confirmation (a real, deliberately
// separate/harder action from Pause, matching the original's own
// reasoning: irreversible, only for a real incident).
import type { ReactNode } from 'react';

export function Modal({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  if (!open) return null;
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(16,24,40,.35)', zIndex: 80, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 440, maxWidth: '90vw', boxShadow: '0 10px 15px -3px rgba(16,24,40,.15)' }} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
