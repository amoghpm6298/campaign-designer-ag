// The agent's own text, rendered as light markdown (bold, lists, paragraphs).
import type { ReactNode } from 'react';
import { SourcesFooter, withCites } from './v2/Citations';

/** One line of text with **bold** spans. */
export function renderInline(s: string): ReactNode[] {
  // Source markers ([Q7], [M], [O]) become chips: the designer cites its figures (v2/Citations.tsx).
  const cites = (t: string, k: string) => (/\[(?:Q\d+|M|O)\]/.test(t) ? withCites(t, k) : t);
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{cites(part.slice(2, -2), `b${i}`)}</strong> : <span key={i}>{cites(part, `s${i}`)}</span>,
  );
}

const inline = renderInline;

export function RichText({ text }: { text: string }) {
  const blocks = text.split('\n');
  const out: ReactNode[] = [];
  let list: string[] = [];
  const flush = (key: string) => {
    if (!list.length) return;
    out.push(
      <ul key={key}>
        {list.map((li, i) => (
          <li key={i}>{inline(li)}</li>
        ))}
      </ul>,
    );
    list = [];
  };
  blocks.forEach((line, i) => {
    if (line.startsWith('- ')) {
      list.push(line.slice(2));
      return;
    }
    flush(`l${i}`);
    if (line.trim()) out.push(<div key={i}>{inline(line)}</div>);
  });
  flush('lend');
  return (
    <>
      {out}
      <SourcesFooter text={text} />
    </>
  );
}
