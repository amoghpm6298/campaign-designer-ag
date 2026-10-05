// Generic right-side drawer — ported from the original's openSideDrawer/
// closeSideDrawer (#sideDrawer/#sideDrawerOverlay), the same component
// used throughout the real app for Communication Configure, Goal
// definition, and the add/edit-node form here.
import type { ReactNode } from 'react';
import './sideDrawer.css';

export function SideDrawer({ open, widthPx, onClose, children }: { open: boolean; widthPx?: number; onClose: () => void; children: ReactNode }) {
  return (
    <>
      <div className={`sd-overlay${open ? ' open' : ''}`} onClick={onClose} />
      <div className={`sd-drawer${open ? ' open' : ''}`} style={{ width: (widthPx || 620) + 'px' }}>
        {children}
      </div>
    </>
  );
}

export function SideDrawerHead({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="sd-head">
      <div className="sd-title">{title}</div>
      <button className="drawer-close" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

export function SideDrawerFoot({
  onCancel,
  onPrimary,
  primaryLabel,
  primaryDisabled,
}: {
  onCancel: () => void;
  onPrimary: () => void;
  primaryLabel: string;
  primaryDisabled?: boolean;
}) {
  return (
    <div className="sd-foot">
      <button className="btn secondary" onClick={onCancel}>
        Cancel
      </button>
      <button className="btn primary" disabled={primaryDisabled} style={primaryDisabled ? { opacity: 0.5 } : undefined} onClick={onPrimary}>
        {primaryLabel}
      </button>
    </div>
  );
}
