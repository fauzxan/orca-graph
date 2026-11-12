// Cleans up one worker session: stops or releases its agent, removes its worktree and,
// optionally, moves its Claude Code transcripts to the Trash.
import { existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { orca, sessionIndex } from './orca.mjs';

export const MODES = ['worktree', 'worktree+transcripts'];

// Claude Code stores a project's transcripts in ~/.claude/projects/<path with non-alphanumerics as "-">.
export const transcriptDir = (path) => join(homedir(), '.claude', 'projects', path.replace(/[^A-Za-z0-9]/g, '-'));

async function moveToTrash(dir) {
  const trash = join(homedir(), '.Trash');
  await mkdir(trash, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(trash, `${dir.split('/').pop()}-${stamp}`);
  await rename(dir, target);
  return target;
}

export async function cleanupSession(id, mode) {
  const steps = [];
  const session = sessionIndex.get(id);
  if (!session) return { ok: false, steps, error: 'Unknown worker. Refresh and try again.' };
  if (!session.cleanup.allowed) return { ok: false, steps, error: session.cleanup.reason };

  // Settle each dispatch first. Running ones are stopped; settled ones have their terminal released.
  const list = await orca(['orchestration', 'worker-list']);
  if (!list.ok) return { ok: false, steps, error: list.error };
  const states = new Map(list.result.workers.map((w) => [w.dispatchId, w]));
  for (const dispatchId of session.dispatchIds) {
    const w = states.get(dispatchId);
    if (!w) continue;
    const settled = w.state === 'succeeded' || w.state === 'failed';
    if (!settled) {
      const res = await orca(['orchestration', 'worker-stop', '--dispatch', dispatchId]);
      steps.push({ step: `Stop ${dispatchId}`, ok: res.ok, detail: res.ok ? 'stopped' : res.error });
      if (!res.ok && session.kind === 'orphan') {
        // The agent already exited, so there's nothing to stop. Fence the dispatch so orca stops tracking it.
        const fence = await orca(['orchestration', 'worker-abandon', '--dispatch', dispatchId]);
        steps.push({ step: `Abandon ${dispatchId}`, ok: fence.ok, detail: fence.ok ? 'fenced' : fence.error });
        if (!fence.ok) return { ok: false, steps, error: `Could not settle ${dispatchId}, so nothing was removed.` };
      } else if (!res.ok) {
        return { ok: false, steps, error: `Could not stop ${dispatchId}, so nothing was removed.` };
      }
    } else if (w.terminalState !== 'released') {
      const res = await orca(['orchestration', 'worker-release', '--dispatch', dispatchId]);
      steps.push({ step: `Release ${dispatchId}`, ok: res.ok, detail: res.ok ? 'terminal released' : res.error });
    }
  }

  // Keeps the branch. Without --force, orca refuses if the worktree has uncommitted changes.
  const rm = await orca(['worktree', 'rm', '--worktree', `id:${session.worktreeId}`], 60000);
  steps.push({ step: 'Remove worktree', ok: rm.ok, detail: rm.ok ? session.path : rm.error });
  if (!rm.ok) return { ok: false, steps, error: 'orca did not remove the worktree. The branch and transcripts are untouched.' };

  if (mode === 'worktree+transcripts') {
    const dir = transcriptDir(session.path);
    if (!existsSync(dir)) {
      steps.push({ step: 'Move transcripts to Trash', ok: true, detail: 'no transcripts found' });
    } else {
      try {
        const target = await moveToTrash(dir);
        steps.push({ step: 'Move transcripts to Trash', ok: true, detail: target });
      } catch (e) {
        steps.push({ step: 'Move transcripts to Trash', ok: false, detail: String(e) });
        return { ok: false, steps, error: 'Worktree removed, but the transcripts could not be moved.' };
      }
    }
  }

  sessionIndex.delete(id);
  return { ok: true, steps };
}
