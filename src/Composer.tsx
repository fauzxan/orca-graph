import { useEffect, useRef, useState } from 'react';
import { Markdown } from './Markdown';

type Mode = 'write' | 'preview';

const TABLE_TEMPLATE = '| Column | Column |\n| --- | --- |\n|  |  |\n';

// Cells copied from a spreadsheet arrive as tab-separated lines. Two or more columns on every
// line become a Markdown table, with the first line as the header.
export function tsvToTable(text: string): string | null {
  const lines = text.replace(/\r/g, '').replace(/\n+$/, '').split('\n');
  if (lines.length < 2 || !lines.every((l) => l.includes('\t'))) return null;
  const rows = lines.map((l) => l.split('\t').map((c) => c.trim().replace(/\|/g, '\\|')));
  const width = Math.max(...rows.map((r) => r.length));
  if (width < 2) return null;
  const row = (r: string[]) => `| ${Array.from({ length: width }, (_, k) => r[k] ?? '').join(' | ')} |`;
  return [row(rows[0]), row(rows[0].map(() => '---').concat(Array(width - rows[0].length).fill('---'))), ...rows.slice(1).map(row)].join('\n') + '\n';
}

export function Composer({
  disabled,
  sending,
  placeholder,
  onSend,
}: {
  disabled: boolean;
  sending: boolean;
  placeholder: string;
  onSend: (text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>('write');
  const area = useRef<HTMLTextAreaElement>(null);
  const pendingCursor = useRef<[number, number] | null>(null);

  // Grow with the draft up to about 14 lines, then scroll.
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 280)}px`;
    if (pendingCursor.current) {
      el.setSelectionRange(...pendingCursor.current);
      pendingCursor.current = null;
    }
  }, [text, mode]);

  // Replace the selection with `before + selection + after`, and put the cursor where it's useful.
  const insert = (before: string, after = '', placeholderText = '') => {
    const el = area.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const selected = text.slice(start, end) || placeholderText;
    // Block elements need to start on their own line.
    const lead = before.startsWith('\n') || start === 0 || text[start - 1] === '\n' ? '' : '\n';
    const next = text.slice(0, start) + lead + before + selected + after + text.slice(end);
    const cursor = start + lead.length + before.length;
    pendingCursor.current = [cursor, cursor + selected.length];
    setMode('write');
    setText(next);
    el?.focus();
  };

  const submit = async () => {
    const message = text.trim();
    if (!message || disabled || sending) return;
    if (await onSend(message)) {
      setText('');
      setMode('write');
    }
  };

  return (
    <form
      className="composer-box"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="composer-bar">
        <div className="composer-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={mode === 'write'} onClick={() => setMode('write')}>
            Write
          </button>
          <button type="button" role="tab" aria-selected={mode === 'preview'} onClick={() => setMode('preview')} disabled={!text.trim()}>
            Preview
          </button>
        </div>
        <div className="composer-tools">
          <button type="button" title="Code block (wraps the selection)" onClick={() => insert('```\n', '\n```\n', '')} disabled={disabled}>
            {'</>'} Code
          </button>
          <button type="button" title="Insert a table. Pasting cells from a spreadsheet also makes a table." onClick={() => insert(TABLE_TEMPLATE)} disabled={disabled}>
            ▦ Table
          </button>
        </div>
      </div>
      <div className="composer-row">
        {mode === 'write' ? (
          <textarea
            ref={area}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={(e) => {
              const table = tsvToTable(e.clipboardData.getData('text/plain'));
              if (!table) return;
              e.preventDefault();
              insert(table);
            }}
            placeholder={placeholder}
            disabled={sending || disabled}
            rows={2}
          />
        ) : (
          <div className="composer-preview" onDoubleClick={() => setMode('write')} title="Double-click to edit">
            <Markdown text={text} />
          </div>
        )}
        <button type="submit" className="primary" disabled={sending || disabled || !text.trim()}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </form>
  );
}
