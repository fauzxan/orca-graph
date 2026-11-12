import { useState } from 'react';
import { cleanup, type ActionResult } from './api';
import type { CleanupMode } from './types';

// Anything that can be cleaned up: a graph worker or an orphan.
export type CleanupTarget = {
  id: string;
  name: string;
  cleanup?: { allowed: boolean; reason: string | null; active: boolean; path: string };
};

export type CleanupRequest = { targets: CleanupTarget[]; mode: CleanupMode } | null;

const transcriptFolder = (path: string) => `~/.claude/projects/${path.replace(/[^A-Za-z0-9]/g, '-')}`;

type Outcome = { target: CleanupTarget; result: ActionResult };

export function CleanupDialog({
  request,
  onClose,
  onDone,
}: {
  request: CleanupRequest;
  onClose: () => void;
  onDone: (outcomes: Outcome[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  if (!request) return null;

  const { targets, mode } = request;
  const single = targets.length === 1 ? targets[0] : null;
  const running = targets.some((t) => t.cleanup?.active);

  // One at a time, so orca never removes several worktrees of the same repo at once.
  const run = async () => {
    setBusy(true);
    const done: Outcome[] = [];
    for (const target of targets) {
      setProgress(done.length + 1);
      done.push({ target, result: await cleanup(target.id, mode) });
    }
    setBusy(false);
    setOutcomes(done);
    onDone(done);
  };

  const close = () => {
    setOutcomes(null);
    setProgress(0);
    onClose();
  };

  const title = single ? `Clean up ${single.name}?` : `Clean up ${targets.length} workers?`;

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && close()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="cleanup-title">
        <h2 id="cleanup-title">{outcomes ? 'Cleanup finished' : title}</h2>
        {!outcomes && (
          <>
            <ol>
              {running && (
                <li>
                  <b className="warn">Stop the worker.</b> It's still running, so its current task ends now.
                </li>
              )}
              <li>Close {single ? 'the worker’s' : 'each worker’s'} agent session in orca, if still open.</li>
              <li>
                Remove {single ? <>the worktree <code>{single.cleanup?.path}</code></> : 'each worktree'}. Branches are kept.
                Orca refuses if there are uncommitted changes.
              </li>
              {mode === 'worktree+transcripts' && (
                <li>
                  Move {single ? <>its Claude transcripts <code>{transcriptFolder(single.cleanup?.path ?? '')}</code></> : 'their Claude transcripts'} to
                  the Trash.
                </li>
              )}
            </ol>
            {!single && (
              <ul className="target-list">
                {targets.map((t) => (
                  <li key={t.id}>
                    <b>{t.name}</b> <code>{t.cleanup?.path}</code>
                  </li>
                ))}
              </ul>
            )}
            <div className="dialog-actions">
              <button onClick={close} disabled={busy}>
                Cancel
              </button>
              <button className="danger" onClick={run} disabled={busy}>
                {busy
                  ? targets.length > 1
                    ? `Cleaning up ${progress} of ${targets.length}…`
                    : 'Cleaning up…'
                  : running
                    ? 'Stop and clean up'
                    : 'Clean up'}
              </button>
            </div>
          </>
        )}
        {outcomes && (
          <>
            {outcomes.map(({ target, result }) => (
              <div key={target.id} className="outcome">
                <p className={result.ok ? 'ok' : 'warn'}>
                  {result.ok ? '✓' : '✗'} <b>{target.name}</b>
                  {result.ok ? ' cleaned up.' : `: ${result.error}`}
                </p>
                <ul className="steps">
                  {result.steps?.map((s) => (
                    <li key={s.step} className={s.ok ? 'ok' : 'warn'}>
                      {s.ok ? '✓' : '✗'} {s.step}: <span>{s.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <div className="dialog-actions">
              <button onClick={close}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
