// A small, dependency-free markdown renderer for the agent's longer notes (the
// campaign strategy): headings, paragraphs, nested bullet and numbered lists,
// tables, rules, and inline **bold**, *italic*, `code`. Text only; no HTML is
// ever injected, so nothing the agent writes can run as markup.
import type { ReactNode } from 'react';
import { Cite, SourcesFooter } from './Citations';

/** Inline: **bold**, *italic* / _italic_, `code`, and source markers [Q7] / [M] / [O] as chips. */
export function inlineMd(s: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  // _italic_ only when the underscores aren't inside a word, so ids like points_2x_category stay as written.
  const re = /(\[(?:Q\d+|M|O)\]|\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|(?<![\w])_[^_\s][^_]*_(?![\w]))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${n++}`;
    if (t.startsWith('[')) out.push(<Cite key={k} id={t.slice(1, -1)} />);
    else if (t.startsWith('**')) out.push(<strong key={k}>{inlineMd(t.slice(2, -2), k)}</strong>);
    else if (t.startsWith('`')) out.push(<code key={k}>{t.slice(1, -1)}</code>);
    else out.push(<em key={k}>{inlineMd(t.slice(1, -1), k)}</em>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

interface Item {
  ordered: boolean;
  text: string;
  children: Item[];
  depth: number;
}

const bullet = /^(\s*)([-*•]|\d+[.)])\s+(.*)$/;

function renderList(items: Item[], key: string): ReactNode {
  const ordered = items[0]?.ordered;
  const Tag = ordered ? 'ol' : 'ul';
  return (
    <Tag key={key}>
      {items.map((it, i) => (
        <li key={i}>
          {inlineMd(it.text, `${key}-${i}`)}
          {it.children.length ? renderList(it.children, `${key}-${i}-c`) : null}
        </li>
      ))}
    </Tag>
  );
}

const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const isSep = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string) =>
  l
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

export function Markdown({ text }: { text: string }) {
  const lines = (text ?? '').replace(/\r/g, '').split('\n');
  const out: ReactNode[] = [];
  let para: string[] = [];
  let i = 0;
  const flushPara = () => {
    if (para.length) out.push(<p key={`p${out.length}`}>{inlineMd(para.join(' '), `p${out.length}`)}</p>);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line.trim());
    if (h) {
      flushPara();
      const level = Math.min(4, h[1].length + 1);
      const Tag = `h${level}` as 'h2' | 'h3' | 'h4';
      out.push(<Tag key={`h${out.length}`}>{inlineMd(h[2].replace(/#+\s*$/, ''), `h${out.length}`)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushPara();
      out.push(<hr key={`r${out.length}`} />);
      i++;
      continue;
    }
    if (isRow(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      flushPara();
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]));
      const k = `t${out.length}`;
      out.push(
        <table key={k}>
          <thead>
            <tr>{head.map((c, j) => <th key={j}>{inlineMd(c, `${k}h${j}`)}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>{head.map((_, j) => <td key={j}>{inlineMd(r[j] ?? '', `${k}${ri}${j}`)}</td>)}</tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }
    if (bullet.test(line)) {
      flushPara();
      // A list, nested by indentation; a continuation line (indented, not a bullet) joins the item above.
      const root: Item[] = [];
      const stack: Item[] = [];
      while (i < lines.length && (bullet.test(lines[i]) || (lines[i].trim() && /^\s{2,}/.test(lines[i]) && stack.length))) {
        const m = bullet.exec(lines[i]);
        if (!m) {
          stack[stack.length - 1].text += ` ${lines[i].trim()}`;
          i++;
          continue;
        }
        const depth = m[1].replace(/\t/g, '  ').length;
        const it: Item = { ordered: /\d/.test(m[2]), text: m[3], children: [], depth };
        while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
        (stack.length ? stack[stack.length - 1].children : root).push(it);
        stack.push(it);
        i++;
      }
      out.push(renderList(root, `l${out.length}`));
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flushPara();
  return (
    <div className="cv-md">
      {out}
      <SourcesFooter text={text ?? ''} />
    </div>
  );
}
