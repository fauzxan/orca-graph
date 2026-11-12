import { useEffect, useMemo, useState } from 'react';
import type { CleanupRequest } from './CleanupDialog';
import { ago } from './OrphansMenu';
import type { CleanupMode, Orphan } from './types';

const OUTCOME_LABEL: Record<string, string> = { succeeded: 'Done', failed: 'Failed', ready: 'Unfinished' };

export function OrphansPage({
  orphans,
  loading,
  onBack,
  onCleanup,
}: {
  orphans: Orphan[];
  loading: boolean;
  onBack: () => void;
  onCleanup: (req: NonNullable<CleanupRequest>) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const cleanable = useMemo(() => orphans.filter((o) => o.cleanup.allowed), [orphans]);

  // Drop selections for orphans that are gone or no longer cleanable.
  useEffect(() => {
    setSelected((prev) => new Set([...prev].filter((id) => cleanable.some((o) => o.id === id))));
  }, [cleanable]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allSelected = cleanable.length > 0 && cleanable.every((o) => selected.has(o.id));
  const chosen = cleanable.filter((o) => selected.has(o.id));
  const cleanupMany = (mode: CleanupMode) => onCleanup({ targets: chosen, mode });

  return (
    <div className="page">
      <div className="page-head">
        <button className="link" onClick={onBack}>
          ← Back to graph
        </button>
        <h2>Orphaned workers</h2>
        <p className="muted">
          Worker worktrees whose agent session has closed, and worktrees under <code>~/orca/workspaces</code> with no worker.
          Cleanup removes the worktree and keeps the branch.
        </p>
      </div>

      {loading && <div className="muted">Loading…</div>}
      {!loading && orphans.length === 0 && <div className="empty-card">Nothing to clean up. Every worker worktree belongs to an open agent.</div>}

      {orphans.length > 0 && (
        <>
          <div className="bulk-bar">
            <label>
              <input
                type="checkbox"
                checked={allSelected}
                disabled={cleanable.length === 0}
                onChange={() => setSelected(allSelected ? new Set() : new Set(cleanable.map((o) => o.id)))}
              />
              Select all cleanable ({cleanable.length})
            </label>
            <span className="spacer" />
            <button disabled={!chosen.length} onClick={() => cleanupMany('worktree')}>
              Clean up worktree{chosen.length > 1 ? 's' : ''} ({chosen.length})
            </button>
            <button className="danger" disabled={!chosen.length} onClick={() => cleanupMany('worktree+transcripts')}>
              …and transcripts ({chosen.length})
            </button>
          </div>

          <div className="table-wrap">
            <table className="orphans">
              <thead>
                <tr>
                  <th />
                  <th>Worker</th>
                  <th>Branch</th>
                  <th>Last task</th>
                  <th>Last active</th>
                  <th>Changes</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {orphans.map((o) => (
                  <tr key={o.id} className={o.cleanup.allowed ? '' : 'blocked'}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`Select ${o.name}`}
                        checked={selected.has(o.id)}
                        disabled={!o.cleanup.allowed}
                        onChange={() => toggle(o.id)}
                      />
                    </td>
                    <td>
                      <div className="orphan-title">{o.name}</div>
                      <div className="muted small">
                        {o.repo} · {o.reason}
                      </div>
                      {o.lastMessage && <div className="orphan-msg" title={o.lastMessage}>{o.lastMessage}</div>}
                    </td>
                    <td>
                      <code>{o.branch || '—'}</code>
                    </td>
                    <td>
                      {o.outcome ? (
                        <span className={`pill outcome-${o.outcome}`}>{OUTCOME_LABEL[o.outcome] ?? o.outcome}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                      {o.tasks > 1 && <div className="muted small">{o.tasks} tasks</div>}
                    </td>
                    <td className="nowrap">{ago(o.lastActivityAt) || '—'}</td>
                    <td className="nowrap">
                      {o.uncommitted == null ? (
                        <span className="muted">unknown</span>
                      ) : o.uncommitted ? (
                        <span className="warn">{o.uncommitted} uncommitted</span>
                      ) : (
                        <span className="ok">clean</span>
                      )}
                    </td>
                    <td className="actions">
                      {o.cleanup.allowed ? (
                        <>
                          <button onClick={() => onCleanup({ targets: [o], mode: 'worktree' })}>Clean up</button>
                          <button className="danger" onClick={() => onCleanup({ targets: [o], mode: 'worktree+transcripts' })}>
                            + transcripts
                          </button>
                        </>
                      ) : (
                        <span className="muted small">{o.cleanup.reason}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">
            Worktrees with uncommitted changes are listed, but orca refuses to remove them. Commit or discard the changes first.
          </p>
        </>
      )}
    </div>
  );
}
