// Native multi-select chip picker for Setup's Program(s) field. The
// original's equivalent (chipGroup/chipToggle/getScopeDraft) is
// explicitly NOT ported — it's already hardcoded with a Drip-specific
// branch, a two-way coupling with the plain-JS file, not a clean shared
// utility. This is a small, self-contained replacement.
export function ChipPicker({ options, selected, onToggle }: { options: string[]; selected: string[]; onToggle: (value: string) => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
      {options.map((o) => {
        const active = selected.includes(o);
        return (
          <div
            key={o}
            onClick={() => onToggle(o)}
            style={{
              padding: '5px 12px',
              borderRadius: 20,
              fontSize: 12.5,
              fontWeight: 600,
              cursor: 'pointer',
              border: `1.5px solid ${active ? 'var(--blue-cta)' : 'var(--gray-200)'}`,
              background: active ? 'var(--info-bg)' : '#fff',
              color: active ? 'var(--blue-cta)' : 'var(--neutral-800)',
            }}
          >
            {o}
          </div>
        );
      })}
    </div>
  );
}
