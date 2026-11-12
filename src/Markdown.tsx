import { Fragment, type ReactNode } from 'react';

// A small Markdown subset for agent replies: fenced code, headings, lists, quotes, tables are left
// as text, plus inline code, bold, italics and links. Builds React elements, never raw HTML.

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s)]*[^\s).,;:!?'"])|(\*[^*\s][^*]*\*)/g;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    const [token] = m;
    if (m[1]) out.push(<code key={i}>{token.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={i}>{token.slice(2, -2)}</strong>);
    else if (m[3]) {
      const label = token.slice(1, token.indexOf(']('));
      out.push(<a key={i} href={m[4]} target="_blank" rel="noreferrer">{label}</a>);
    } else if (m[5]) out.push(<a key={i} href={token} target="_blank" rel="noreferrer">{token}</a>);
    else if (m[6]) out.push(<em key={i}>{token.slice(1, -1)}</em>);
    last = i + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block =
  | { type: 'code'; lang: string; text: string }
  | { type: 'heading'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'para'; text: string };

function blocks(src: string): Block[] {
  const lines = src.replace(/\r/g, '').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push({ type: 'code', lang: fence[1], text: body.join('\n') });
    } else if (/^#{1,6}\s/.test(line)) {
      out.push({ type: 'heading', text: line.replace(/^#+\s/, '') });
      i++;
    } else if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
        let item = lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, '');
        // Indented continuation lines belong to the item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) item += ` ${lines[i++].trim()}`;
        items.push(item);
      }
      out.push({ type: 'list', ordered, items });
    } else if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      out.push({ type: 'quote', text: body.join(' ') });
    } else if (line.trim() === '') {
      i++;
    } else {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|[-*•]\s|\d+[.)]\s|>)/.test(lines[i])) body.push(lines[i++]);
      out.push({ type: 'para', text: body.join('\n') });
    }
  }
  return out;
}

function withBreaks(text: string) {
  return text.split('\n').map((l, i, all) => (
    <Fragment key={i}>
      {inline(l)}
      {i < all.length - 1 && <br />}
    </Fragment>
  ));
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {blocks(text).map((b, i) => {
        switch (b.type) {
          case 'code':
            return (
              <pre key={i} className="code" data-lang={b.lang || undefined}>
                <code>{b.text}</code>
              </pre>
            );
          case 'heading':
            return <h4 key={i}>{inline(b.text)}</h4>;
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul';
            return (
              <Tag key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </Tag>
            );
          }
          case 'quote':
            return <blockquote key={i}>{inline(b.text)}</blockquote>;
          default:
            return <p key={i}>{withBreaks(b.text)}</p>;
        }
      })}
    </div>
  );
}
