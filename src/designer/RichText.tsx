// The agent's own text, rendered.
//
// ONE RENDERER, and that is the point of the file. This lived inside
// `CampaignDesigner` and the Chats page had its own version —
// `<div className="cd-msg-bubble">{m.content}</div>`, raw. So the same
// message read as prose in Design and as source in Chats:
//
//   **The sequence**
//   *₹10,000 and above*
//
// Two renderers for one kind of content is the drift this codebase keeps
// paying for (two event-label maps, two notions of identical arms, two
// completeness predicates). Anything that shows an agent message imports
// this.
//
// Deliberately minimal: **bold** and "- " bullets, which is what the agent
// writes. A full markdown pipeline is a dependency and a new attack surface
// for text a model produced.
import type { ReactNode } from 'react';

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
  function inline(s: string): ReactNode[] {
    return s.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
      part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <span key={i}>{part}</span>,
    );
  }
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
