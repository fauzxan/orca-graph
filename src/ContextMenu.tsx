import { useEffect, useLayoutEffect, useRef } from 'react';
import type { CleanupMode, GraphNode } from './types';

export type MenuState = { node: GraphNode; x: number; y: number } | null;

const OPTIONS: { mode: CleanupMode; label: string }[] = [
  { mode: 'worktree', label: 'Clean up worktree' },
  { mode: 'worktree+transcripts', label: 'Clean up worktree and transcripts' },
];

export function ContextMenu({
  menu,
  onPick,
  onOpen,
  onClose,
}: {
  menu: MenuState;
  onPick: (node: GraphNode, mode: CleanupMode) => void;
  onOpen: (node: GraphNode) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as globalThis.Node)) onClose();
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [menu, onClose]);

  // Keep the menu on screen near the right and bottom edges.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!menu || !el) return;
    const { width, height } = el.getBoundingClientRect();
    el.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - width - 8))}px`;
    el.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - height - 8))}px`;
  }, [menu]);

  if (!menu) return null;
  const { node } = menu;
  const cleanup = node.cleanup;
  const disabledReason = node.kind !== 'worker' ? 'Only workers can be cleaned up' : cleanup && !cleanup.allowed ? cleanup.reason : null;

  return (
    <div ref={ref} className="menu" style={{ left: menu.x, top: menu.y }} role="menu">
      <div className="menu-title">{node.name}</div>
      <button role="menuitem" onClick={() => onOpen(node)}>
        Open session
      </button>
      <hr />
      {OPTIONS.map((o) => (
        <button key={o.mode} role="menuitem" disabled={Boolean(disabledReason)} onClick={() => onPick(node, o.mode)}>
          {o.label}
        </button>
      ))}
      {disabledReason && <div className="menu-note">{disabledReason}</div>}
    </div>
  );
}
