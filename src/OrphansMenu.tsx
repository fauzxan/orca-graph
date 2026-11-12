import { useRef, useState } from 'react';
import type { Orphan } from './types';

const PREVIEW = 6;

export function ago(ms: number | null): string {
  if (!ms) return '';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// Header button: hover (or focus) shows a preview list, click opens the full page.
export function OrphansMenu({ orphans, onOpenPage }: { orphans: Orphan[]; onOpenPage: () => void }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const show = () => {
    clearTimeout(timer.current);
    setOpen(true);
  };
  // A short delay lets the pointer cross the gap between the button and the dropdown.
  const hide = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), 150);
  };
  const cleanable = orphans.filter((o) => o.cleanup.allowed).length;

  return (
    <div className="orphans-menu" onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}>
      <button
        className={`orphans-button${orphans.length ? ' has-orphans' : ''}`}
        onClick={() => {
          setOpen(false);
          onOpenPage();
        }}
        aria-haspopup="true"
        aria-expanded={open}
      >
        Orphaned workers <span className="count">{orphans.length}</span>
      </button>
      {open && (
        <div className="orphans-dropdown" role="menu">
          {orphans.length === 0 ? (
            <div className="muted small">Nothing to clean up. Every worker worktree belongs to an open agent.</div>
          ) : (
            <>
              <div className="muted small">
                {cleanable} of {orphans.length} can be cleaned up
              </div>
              <ul>
                {orphans.slice(0, PREVIEW).map((o) => (
                  <li key={o.id}>
                    <div className="orphan-name">
                      <b>{o.name}</b>
                      <span className="muted">{ago(o.lastActivityAt)}</span>
                    </div>
                    <div className="muted small">
                      {o.repo} · {o.branch || 'no branch'}
                      {o.uncommitted ? <span className="warn"> · {o.uncommitted} uncommitted</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
              {orphans.length > PREVIEW && <div className="muted small">+{orphans.length - PREVIEW} more</div>}
            </>
          )}
          <button
            className="link"
            onClick={() => {
              setOpen(false);
              onOpenPage();
            }}
          >
            Open the cleanup page →
          </button>
        </div>
      )}
    </div>
  );
}
