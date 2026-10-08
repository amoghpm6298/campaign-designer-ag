// Ported verbatim from journeysnudgesemi/emi-conversions-prototype.html's
// ICONS object (lucide-style, thin-line, stroke-based) — only the subset
// actually referenced by the sidebar NAV array.
const ICONS: Record<string, string> = {
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 8h1M14 8h1M9 12h1M14 12h1M9 16h1M14 16h1"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M2 20c0-3.3 3-6 7-6s7 2.7 7 6"/><path d="M16 8a3 3 0 1 1 0 6"/><path d="M23 20c0-2.8-2.2-5-5-5.5"/>',
  chart: '<path d="M3 3v18h18"/><path d="M18 9l-4 4-3-3-4 4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h13M21 18h0"/><circle cx="15" cy="6" r="2"/><circle cx="7" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  wrench: '<path d="M21 7a4 4 0 0 1-5 5l-8 8-2-2 8-8a4 4 0 0 1 5-5l-2.5 2.5 2 2z"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-2 6-6 2 2-6 6-2z"/>',
  gift: '<rect x="3" y="9" width="18" height="4"/><rect x="5" y="13" width="14" height="8"/><path d="M12 9v12"/><path d="M12 9C10 5 6 5 6 7.5S9 9 12 9zM12 9c2-4 6-4 6-1.5S15 9 12 9z"/>',
  workflow: '<rect x="3" y="4" width="6" height="4" rx="1"/><rect x="15" y="16" width="6" height="4" rx="1"/><path d="M6 8v4a4 4 0 0 0 4 4h6"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  idcard: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="11" r="1.5"/><path d="M6 16c.5-1.5 1.7-2 2.5-2s2 .5 2.5 2M13 9h5M13 13h5"/>',
  file: '<path d="M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4M9 13h6M9 17h6"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="16.5" cy="14.5" r="1.2"/>',
  repeat: '<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
  award: '<circle cx="12" cy="8" r="6"/><path d="M9 13.5 7 22l5-3 5 3-2-8.5"/>',
  card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><path d="M6 15h4"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"/>',
  tag: '<path d="M20 12l-8 8-9-9V4h7z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  landmark: '<path d="M3 21h18"/><path d="M4 10h16"/><path d="M12 3l9 5H3z"/><path d="M6 10v8M10 10v8M14 10v8M18 10v8"/>',
  sigma: '<path d="M18 5H6l6 7-6 7h12"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  calc: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M8 6h8"/><path d="M8 11h1M11.5 11h1M15 11h1M8 15h1M11.5 15h1M15 15h1M8 19h1M11.5 19h1M15 19h5v-4"/>',

  // Canvas node-category glyphs (see nodeMeta.ts's DC_CATEGORY_ICON) —
  // same thin-line style as the sidebar set above, kept intentionally
  // small in number (one per category, Phase 2 §10: avoid icon overload).
  flag: '<path d="M6 3v18"/><path d="M6 4h12l-3 4 3 4H6"/>',
  paperplane: '<path d="m22 2-9.5 9.5"/><path d="M22 2 15 22l-3.5-8.5L3 10z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  fork: '<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M8 7l8 4M8 17l8-4"/>',
  flask: '<path d="M9.5 2.5h5"/><path d="M10.5 2.5v6.2L4.8 18a1.6 1.6 0 0 0 1.4 2.5h11.6a1.6 1.6 0 0 0 1.4-2.5L13.5 8.7V2.5"/><path d="M7 15h10"/>',
  targetCheck: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12 2.3 2.3L16 9.5"/>',
  doorExit: '<path d="M14 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><path d="M9.5 16.5 14 12l-4.5-4.5"/><path d="M14 12H3"/>',

  // Per-channel Send glyphs (nodeTypes.tsx: a Send node's icon follows
  // its configured channel, not a one-size category icon, since the
  // channel is the single most glance-relevant fact about a Send). Each
  // one varies the outer bubble shape first (what actually reads at the
  // ~13px this renders at) then a minimal inner detail — WhatsApp gets
  // its own rounder bubble + a small call-wave rather than reusing the
  // sidebar's generic 'message' glyph (which made it indistinguishable
  // from "just a chat"), SMS gets visible text lines instead of dots
  // (read as a rating/keypad, not a message), RCS spells itself out
  // since — same as the real product's own channel-config icons — there
  // is no universal RCS mark to abbreviate into a line glyph.
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/>',
  sms: '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><path d="M7 9.5h10M7 12.5h6"/>',
  rcs: '<path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 4v-4H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/><text x="12" y="13.2" font-size="6.2" font-weight="800" text-anchor="middle" fill="currentColor" stroke="none">RCS</text>',
  whatsapp: '<path d="M12 2.5C6.8 2.5 2.5 6.4 2.5 11.2c0 2.3 1 4.4 2.7 5.9L4 21.5l4.6-1.4c1 .3 2.1.5 3.4.5 5.2 0 9.5-3.9 9.5-8.7S17.2 2.5 12 2.5z"/><path d="M8.7 9.8c.3 3 2.3 5 5.2 5.4"/>',
  undo: '<path d="M3 4v6h6"/><path d="M3.5 15a9 9 0 1 0 2.1-9.4L3 10"/>',
  redo: '<path d="M21 4v6h-6"/><path d="M20.5 15a9 9 0 1 1-2.1-9.4L21 10"/>',
};

export function Icon({ name }: { name: string }) {
  return (
    <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" dangerouslySetInnerHTML={{ __html: ICONS[name] || '' }} />
  );
}

export function Chevron() {
  return (
    <svg className="ic" style={{ width: 12, height: 12 }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}
