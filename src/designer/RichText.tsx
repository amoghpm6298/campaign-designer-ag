// The agent's own text, rendered as light markdown (bold, lists, paragraphs).
import type { ReactNode } from 'react';

/** One line of text with **bold** spans. */
export function renderInline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>,
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
  return <>{out}</>;
}
