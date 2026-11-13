import { useEffect, useRef, useState } from 'react';
import { send, session } from './api';
import { Composer } from './Composer';
import { Thread } from './Thread';
import { STATUS_LABEL, type GraphNode, type SessionDetail } from './types';

type Tab = 'messages' | 'raw';

const WIDTH_KEY = 'orca-graph.pane-width';
const MIN_WIDTH = 320;
const DEFAULT_WIDTH = 480;
const maxWidth = () => Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.8));
const clampWidth = (w: number) => Math.min(maxWidth(), Math.max(MIN_WIDTH, Math.round(w)));

function savedWidth() {
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY));
    return clampWidth(w > 0 ? w : DEFAULT_WIDTH);
  } catch {
    return clampWidth(DEFAULT_WIDTH);
  }
}

function saveWidth(w: number) {
  try {
    localStorage.setItem(WIDTH_KEY, String(w));
  } catch {
    /* storage unavailable: the width just won't be remembered */
  }
}

// Drag the pane's left edge to resize it. Arrow keys work on the handle too; the width is remembered.
function useResizableWidth() {
  const [width, setWidth] = useState(savedWidth);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const onResize = () => setWidth((w) => clampWidth(w));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setDragging(true);
    let next = startWidth;
    const move = (ev: PointerEvent) => {
      next = clampWidth(startWidth + (startX - ev.clientX));
      setWidth(next);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      setDragging(false);
      saveWidth(next);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 80 : 20;
    const delta = e.key === 'ArrowLeft' ? step : e.key === 'ArrowRight' ? -step : 0;
    if (!delta) return;
    e.preventDefault();
    const next = clampWidth(width + delta);
    setWidth(next);
    saveWidth(next);
  };

  const reset = () => {
    const next = clampWidth(DEFAULT_WIDTH);
    setWidth(next);
    saveWidth(next);
  };

  return { width, dragging, onPointerDown, onKeyDown, reset };
}

export function SidePane({ node, pollMs, onClose }: { node: GraphNode; pollMs: number; onClose: () => void }) {
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [tab, setTab] = useState<Tab>('messages');
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const body = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const resize = useResizableWidth();

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    setDetail(null);
    setNotice(null);
    setTab('messages');
    stick.current = true;
    const load = async () => {
      try {
        const d = await session(node.id);
        // A failed refresh keeps the last good view. If the agent exited, the graph poll closes the pane.
        if (!cancelled) setDetail((prev) => (d.ok || !prev?.ok ? d : prev));
      } finally {
        if (!cancelled) timer = setTimeout(load, pollMs);
      }
    };
    load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [node.id, pollMs]);

  // Follow new messages only while the reader is already at the bottom.
  useEffect(() => {
    const el = body.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [detail, tab]);

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);

  const submit = async (message: string) => {
    setSending(true);
    const r = await send(node.id, message);
    setSending(false);
    if (r.ok) {
      stick.current = true;
      setNotice({ ok: true, text: r.via === 'mailbox' ? 'Sent to the worker’s orchestration mailbox.' : 'Sent to the agent.' });
    } else {
      setNotice({ ok: false, text: r.error || 'Send failed.' });
    }
    return r.ok;
  };

  return (
    <aside
      className={`pane status-${node.status}${resize.dragging ? ' resizing' : ''}`}
      style={{ width: resize.width }}
      aria-label={`${node.name} session`}
    >
      <div
        className="pane-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize side pane"
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={maxWidth()}
        aria-valuenow={resize.width}
        tabIndex={0}
        title="Drag to resize · double-click to reset"
        onPointerDown={resize.onPointerDown}
        onKeyDown={resize.onKeyDown}
        onDoubleClick={resize.reset}
      />
      <div className="pane-head">
        <div>
          <div className="pane-title">{node.name}</div>
          <div className="meta">
            <span className="pill">{STATUS_LABEL[node.status]}</span> {detail?.path ?? ''}
          </div>
        </div>
        <button className="icon" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'messages'} onClick={() => setTab('messages')}>
          Messages
        </button>
        <button role="tab" aria-selected={tab === 'raw'} onClick={() => setTab('raw')}>
          Raw output
        </button>
      </div>

      <div
        className="pane-body"
        ref={body}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {!detail && <div className="muted">Loading…</div>}
        {detail?.error && <div className="warn small">{detail.error}</div>}
        {detail?.note && <div className="muted small">{detail.note}</div>}
        {detail?.ok && tab === 'messages' &&
          (detail.messages.length ? <Thread messages={detail.messages} /> : <div className="muted">No messages yet.</div>)}
        {detail?.ok && tab === 'raw' && <pre className="stream">{detail.raw.length ? detail.raw.join('\n') : 'No output.'}</pre>}
      </div>

      <div className="composer">
        {notice && <div className={notice.ok ? 'ok small' : 'warn small'}>{notice.text}</div>}
        <Composer
          disabled={detail?.canSend === false}
          sending={sending}
          placeholder={detail?.canSend === false ? 'This session can’t take messages.' : 'Message this agent… Markdown works. ⌘↵ to send'}
          onSend={submit}
        />
      </div>
    </aside>
  );
}
