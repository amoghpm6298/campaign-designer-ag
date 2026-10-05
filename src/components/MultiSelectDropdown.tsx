// Real multi-select dropdown — closed by default showing a live summary,
// opens into a checkbox list. Ported in spirit from the original's
// multiSelectDropdownHtml (a hand-built HTML-string component); this is
// the real React equivalent, same interaction model.
import { useState } from 'react';

export function MultiSelectDropdown({
  label,
  options,
  selected,
  onToggle,
}: {
  label?: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const summary = selected.length === 0 ? 'Select…' : selected.length <= 2 ? selected.join(', ') : `${selected.length} selected`;
  return (
    <div className="f-group" style={{ marginBottom: label ? 20 : 0 }}>
      {label && <label className="f-label">{label}</label>}
      <div className="msel-trigger" onClick={() => setOpen((o) => !o)}>
        <span>{summary}</span>
        <span style={{ color: 'var(--gray-400)' }}>{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div className="msel-panel">
          {options.map((o) => (
            <label className="msel-option" key={o}>
              <input type="checkbox" checked={selected.includes(o)} onChange={() => onToggle(o)} />
              {o}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
