import { useEffect, useMemo, useRef, useState } from 'react';
import { skills as fetchSkills, uploadImage, type Skill } from './api';
import { Markdown } from './Markdown';
import { matchSkills, SkillMenu, slashQuery } from './SkillMenu';

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

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 6;

type Attachment = { key: string; name: string; preview: string; path?: string; error?: string };

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

const imageFiles = (list: FileList | DataTransferItemList | null | undefined): File[] => {
  if (!list) return [];
  const files = list instanceof FileList ? [...list] : [...list].map((i) => (i.kind === 'file' ? i.getAsFile() : null));
  return files.filter((f): f is File => Boolean(f && f.type.startsWith('image/')));
};

export function Composer({
  sessionId,
  disabled,
  sending,
  placeholder,
  onSend,
}: {
  sessionId: string;
  disabled: boolean;
  sending: boolean;
  placeholder: string;
  onSend: (text: string, images: string[]) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>('write');
  const [cursor, setCursor] = useState(0);
  const [skillList, setSkillList] = useState<Skill[]>([]);
  const [active, setActive] = useState(0);
  const [menuClosed, setMenuClosed] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const pendingCursor = useRef<[number, number] | null>(null);

  // Skills for this session's folder and its parents. Refreshed when the session changes.
  useEffect(() => {
    let cancelled = false;
    fetchSkills(sessionId).then((list) => !cancelled && setSkillList(list));
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const query = mode === 'write' && !menuClosed ? slashQuery(text, cursor) : null;
  const matches = useMemo(() => (query == null ? [] : matchSkills(skillList, query)), [query, skillList]);
  const menuOpen = query != null && !disabled;
  useEffect(() => setActive(0), [query]);

  const pickSkill = (skill: Skill) => {
    const token = text.match(/^\/[^\s/]*/)?.[0] ?? '';
    const rest = text.slice(token.length).replace(/^ /, '');
    const next = `/${skill.name} ${rest}`;
    const at = skill.name.length + 2;
    pendingCursor.current = [at, at];
    setText(next);
    setCursor(at);
    area.current?.focus();
  };

  const attach = async (files: File[]) => {
    const room = MAX_IMAGES - attachments.length;
    for (const file of files.slice(0, Math.max(0, room))) {
      const key = `${Date.now()}-${Math.random()}`;
      const preview = URL.createObjectURL(file);
      const base: Attachment = { key, name: file.name || 'image', preview };
      if (file.size > MAX_IMAGE_BYTES) {
        setAttachments((a) => [...a, { ...base, error: 'Over 10 MB' }]);
        continue;
      }
      setAttachments((a) => [...a, base]);
      const r = await uploadImage(await readBase64(file)).catch((e) => ({ ok: false, error: String(e) }) as { ok: boolean; error?: string; path?: string });
      setAttachments((a) => a.map((x) => (x.key === key ? { ...x, path: r.ok ? r.path : undefined, error: r.ok ? undefined : r.error || 'Upload failed' } : x)));
    }
  };

  const removeAttachment = (key: string) =>
    setAttachments((a) => {
      const gone = a.find((x) => x.key === key);
      if (gone) URL.revokeObjectURL(gone.preview);
      return a.filter((x) => x.key !== key);
    });

  const uploading = attachments.some((a) => !a.path && !a.error);
  const ready = attachments.filter((a) => a.path).map((a) => a.path!);
  const canSend = !sending && !disabled && !uploading && Boolean(text.trim() || ready.length);

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
    if (!canSend) return;
    if (await onSend(text.trim(), ready)) {
      attachments.forEach((a) => URL.revokeObjectURL(a.preview));
      setAttachments([]);
      setText('');
      setMode('write');
      setMenuClosed(false);
    }
  };

  return (
    <form
      className={`composer-box${dragging ? ' dropping' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onDragOver={(e) => {
        if (disabled || ![...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        setDragging(false);
        const files = imageFiles(e.dataTransfer.files);
        if (!files.length || disabled) return;
        e.preventDefault();
        attach(files);
      }}
    >
      {menuOpen && <SkillMenu items={matches} active={active} onHover={setActive} onPick={pickSkill} />}
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
          <button
            type="button"
            title={`Attach images (up to ${MAX_IMAGES}). You can also paste or drop them here.`}
            onClick={() => filePicker.current?.click()}
            disabled={disabled || attachments.length >= MAX_IMAGES}
          >
            ⧉ Image
          </button>
          <input
            ref={filePicker}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(e) => {
              attach(imageFiles(e.target.files));
              e.target.value = '';
            }}
          />
        </div>
      </div>
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((a) => (
            <div key={a.key} className={`attachment${a.error ? ' failed' : ''}${!a.path && !a.error ? ' uploading' : ''}`} title={a.error || a.name}>
              <img src={a.preview} alt={a.name} />
              {a.error && <span className="attachment-error">{a.error}</span>}
              <button type="button" className="attachment-remove" aria-label={`Remove ${a.name}`} onClick={() => removeAttachment(a.key)}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="composer-row">
        {mode === 'write' ? (
          <textarea
            ref={area}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setCursor(e.target.selectionStart);
              if (!e.target.value.startsWith('/')) setMenuClosed(false);
            }}
            onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
            onBlur={() => setMenuClosed(true)}
            onFocus={() => setMenuClosed(false)}
            onKeyDown={(e) => {
              if (menuOpen && matches.length) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const step = e.key === 'ArrowDown' ? 1 : -1;
                  setActive((i) => (i + step + matches.length) % matches.length);
                  return;
                }
                if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
                  e.preventDefault();
                  pickSkill(matches[active]);
                  return;
                }
              }
              if (menuOpen && e.key === 'Escape') {
                // Close only the menu, not the side pane.
                e.preventDefault();
                e.nativeEvent.stopImmediatePropagation();
                setMenuClosed(true);
                return;
              }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={(e) => {
              const images = imageFiles(e.clipboardData.items);
              if (images.length) {
                e.preventDefault();
                attach(images);
                return;
              }
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
        <button type="submit" className="primary" disabled={!canSend} title={uploading ? 'Waiting for images to upload' : undefined}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </form>
  );
}
