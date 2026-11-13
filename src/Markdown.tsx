import { Fragment, useState, type ReactNode } from 'react';

// A Markdown subset for prompts and replies: fenced code, tables (Markdown pipe tables, and the
// box-drawn tables Claude Code puts on screen), headings, lists, quotes, plus inline code, bold,
// italics and links. Builds React elements, never raw HTML.

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))|(https?:\/\/[^\s)]*[^\s).,;:!?'"|])|(\*[^*\s][^*]*\*)/g;

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

type Align = 'left' | 'center' | 'right' | undefined;

type Block =
  | { type: 'code'; lang: string; text: string }
  | { type: 'table'; head: string[]; rows: string[][]; align: Align[] }
  | { type: 'heading'; text: string }
  | { type: 'list'; ordered: boolean; start: number; items: string[] }
  | { type: 'quote'; text: string }
  | { type: 'para'; text: string };

const FENCE = /^\s*(```|~~~)\s*([\w+#.-]*)/;
const LIST_ITEM = /^\s*([-*•]|\d+[.)])\s+/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const BOX_TOP = /^\s*┌[─┬]+┐\s*$/;

// "| a | b |" -> ["a", "b"]. A pipe written as \| stays in the cell.
function splitRow(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

const isPipeTableAt = (lines: string[], i: number) =>
  lines[i].includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && lines[i + 1].includes('-') && TABLE_DIVIDER.test(lines[i + 1]);

function pipeTable(lines: string[], i: number): [Block, number] {
  const head = splitRow(lines[i]);
  const align: Align[] = splitRow(lines[i + 1]).map((c) =>
    c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : undefined,
  );
  let j = i + 2;
  const rows: string[][] = [];
  while (j < lines.length && lines[j].includes('|') && lines[j].trim()) {
    const cells = splitRow(lines[j++]);
    rows.push(head.map((_, k) => cells[k] ?? ''));
  }
  return [{ type: 'table', head, rows, align }, j];
}

// Claude Code draws tables with box characters. Rows are separated by ├───┤ lines, and a long
// cell wraps onto several │ lines, which are joined back together.
function boxTable(lines: string[], i: number): [Block, number] {
  const rows: string[][] = [];
  let current: string[][] | null = null;
  let j = i + 1;
  const flush = () => {
    if (current) rows.push(current.map((parts) => parts.filter(Boolean).join(' ')));
    current = null;
  };
  for (; j < lines.length; j++) {
    const line = lines[j].trim();
    if (line.startsWith('└')) {
      j++;
      break;
    }
    if (line.startsWith('├')) {
      flush();
      continue;
    }
    if (!line.startsWith('│')) break;
    const cells = line.slice(1, line.endsWith('│') ? -1 : undefined).split('│').map((c) => c.trim());
    if (!current) current = cells.map(() => []);
    cells.forEach((c, k) => (current![k] ??= []).push(c));
  }
  flush();
  const [head = [], ...body] = rows;
  return [{ type: 'table', head, rows: body, align: head.map(() => undefined) }, j];
}

const startsBlock = (lines: string[], i: number) =>
  FENCE.test(lines[i]) || /^#{1,6}\s/.test(lines[i]) || LIST_ITEM.test(lines[i]) || /^>/.test(lines[i]) || BOX_TOP.test(lines[i]) || isPipeTableAt(lines, i);

function blocks(src: string): Block[] {
  const lines = src.replace(/\r/g, '').split('\n');
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(FENCE);
    if (fence) {
      const close = new RegExp(`^\\s*${fence[1]}\\s*$`);
      const indent = line.match(/^\s*/)![0].length;
      const body: string[] = [];
      i++;
      // A fence indented inside a list item: drop that indent from its lines.
      while (i < lines.length && !close.test(lines[i])) {
        const l = lines[i++];
        body.push(l.slice(Math.min(indent, l.search(/\S|$/))));
      }
      i++;
      out.push({ type: 'code', lang: fence[2], text: body.join('\n') });
    } else if (BOX_TOP.test(line)) {
      const [block, next] = boxTable(lines, i);
      out.push(block);
      i = next;
    } else if (isPipeTableAt(lines, i)) {
      const [block, next] = pipeTable(lines, i);
      out.push(block);
      i = next;
    } else if (/^#{1,6}\s/.test(line)) {
      out.push({ type: 'heading', text: line.replace(/^#+\s/, '') });
      i++;
    } else if (LIST_ITEM.test(line)) {
      const ordered = /^\s*\d/.test(line);
      // A list split by a code block keeps counting from where it was.
      const start = ordered ? Number(line.match(/\d+/)![0]) : 1;
      const items: string[] = [];
      while (i < lines.length && LIST_ITEM.test(lines[i])) {
        let item = lines[i++].replace(LIST_ITEM, '');
        // Indented continuation lines belong to the item.
        while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !LIST_ITEM.test(lines[i]) && !FENCE.test(lines[i])) item += ` ${lines[i++].trim()}`;
        items.push(item);
      }
      out.push({ type: 'list', ordered, start, items });
    } else if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      out.push({ type: 'quote', text: body.join(' ') });
    } else if (line.trim() === '') {
      i++;
    } else {
      const body: string[] = [line];
      i++;
      while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) body.push(lines[i++]);
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

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked: nothing to do */
    }
  };
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang || 'code'}</span>
        <button type="button" className="link" onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="code">
        <code>{text}</code>
      </pre>
    </div>
  );
}

function Table({ head, rows, align }: { head: string[]; rows: string[][]; align: Align[] }) {
  return (
    <div className="md-table">
      <table>
        <thead>
          <tr>
            {head.map((h, k) => (
              <th key={k} style={{ textAlign: align[k] }}>
                {inline(h)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, j) => (
            <tr key={j}>
              {r.map((c, k) => (
                <td key={k} style={{ textAlign: align[k] }}>
                  {inline(c)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {blocks(text).map((b, i) => {
        switch (b.type) {
          case 'code':
            return <CodeBlock key={i} lang={b.lang} text={b.text} />;
          case 'table':
            return <Table key={i} head={b.head} rows={b.rows} align={b.align} />;
          case 'heading':
            return <h4 key={i}>{inline(b.text)}</h4>;
          case 'list': {
            const Tag = b.ordered ? 'ol' : 'ul';
            return (
              <Tag key={i} start={b.ordered && b.start !== 1 ? b.start : undefined}>
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
