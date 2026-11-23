// The designer's campaign strategy (its working plan: buckets, levers, money
// and budget), read-only, rendered from its markdown note, full page.
import { FullPageModal } from './FullPageModal';
import { Markdown } from './Markdown';

export interface StrategyNote {
  text: string;
  at: string;
  /** Older campaigns: the separate notes the strategy replaced. */
  legacy?: boolean;
}

const when = (iso: string) => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export function StrategyPanel({ note, onClose }: { note: StrategyNote; onClose: () => void }) {
  return (
    <FullPageModal title="Campaign strategy" kicker={`The designer's working plan · updated ${when(note.at)}`} onClose={onClose}>
      {note.legacy && <p className="cv-muted">This campaign was designed before the strategy was kept as one note; these are its earlier notes.</p>}
      <Markdown text={note.text} />
      <p className="cv-muted cv-drawer-hint">To change the strategy, ask in the chat. The designer keeps this note in step with the campaign.</p>
    </FullPageModal>
  );
}
