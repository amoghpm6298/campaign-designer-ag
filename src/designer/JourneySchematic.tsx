// The proposed journey as a scannable schematic: entry, every path (including
// one with nothing on it), waits as chips, and each message drawn as the
// customer would see it. Pure rendering of previewFromBlueprint().
import { templateSegments, type JourneyPreview, type PreviewRow } from './preview';

function MessageMock({ channel, copy, cta }: { channel: string; copy: string; cta?: string }) {
  const c = channel.toLowerCase();
  return (
    <div className={`cd-mock ${c}`}>
      <div className="cd-mock-bubble">
        {renderTemplate(copy)}
        {cta && <span className="cd-mock-cta">{cta}</span>}
        <span className="cd-mock-meta">{c === 'email' ? 'Inbox' : '9:41 AM'}</span>
      </div>
    </div>
  );
}

function renderTemplate(text: string) {
  return templateSegments(text).map((seg, i) =>
    seg.token ? (
      <span className="cd-mock-token" key={i}>
        {seg.text}
      </span>
    ) : (
      <span key={i}>{seg.text}</span>
    ),
  );
}

export function JourneySchematic({ preview, busy }: { preview: JourneyPreview; busy: boolean }) {
  return (
    <div className="cd-preview">
      <div className="cd-preview-banner">{busy ? 'Building the journey…' : 'Proposed — not built yet.'}</div>
      <div className="cd-preview-flow">
        <div className="cd-pv-node entry">
          <span className="cd-pv-kind">Who comes in</span>
          <span className="cd-pv-text">{preview.entry}</span>
          {preview.entryNote && <span className="cd-pv-note">{preview.entryNote}</span>}
        </div>
        <PreviewRows rows={preview.rows} />
        {preview.stops && <div className="cd-pv-stop">{preview.stops}</div>}
      </div>
    </div>
  );
}

function PreviewRows({ rows }: { rows: PreviewRow[] }) {
  return (
    <>
      {rows.map((row, i) => (
        <div className="cd-pv-row" key={i}>
          <span className="cd-pv-link" aria-hidden="true" />
          {row.kind === 'wait' || row.kind === 'await' ? (
            // A wait is a chip, not a card. Giving it the weight of a send
            // makes a three-message journey look like six steps.
            <span className="cd-pv-wait">{row.text}</span>
          ) : row.kind === 'fork' ? (
            <div className="cd-pv-fork">
              <div className="cd-pv-forkq">{row.text}</div>
              <div className="cd-pv-paths">
                {row.paths.map((p, j) => (
                  <div className="cd-pv-path" key={j}>
                    <div className="cd-pv-plabel">{p.label}</div>
                    {p.note && <div className="cd-pv-note">{p.note}</div>}
                    <PreviewRows rows={p.rows} />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className={`cd-pv-node ${row.kind}${row.kind === 'send' ? ` ch-${row.channel.toLowerCase().replace(/[^a-z]/g, '')}` : ''}`}>
              <span className="cd-pv-kind">
                {row.kind === 'send'
                  ? `${row.channel}${row.fallback ? ` · ${row.fallback} if it fails` : ''}`
                  : row.kind === 'exit'
                    ? 'Ends'
                    : 'Step'}
              </span>
              {row.text && <span className="cd-pv-text">{row.text}</span>}
              {row.kind === 'send' && row.copy && <MessageMock channel={row.channel} copy={row.copy} cta={row.cta} />}
            </div>
          )}
        </div>
      ))}
    </>
  );
}
