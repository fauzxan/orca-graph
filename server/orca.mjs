// Builds the coordinator -> worker graph from the orca CLI.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { lastClaudeReply } from './claude.mjs';

const ORCA = process.env.ORCA_BIN || 'orca';
const CONCURRENCY = 6;
const MESSAGE_CROP = 220;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

export function orca(args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(ORCA, [...args, '--json'], { timeout, maxBuffer: 50 * 1024 * 1024 }, (err, stdout) => {
      const json = parseJson(stdout || '');
      if (json?.ok) return resolve({ ok: true, result: json.result });
      const message = json?.error?.message || err?.message || 'unreadable orca output';
      resolve({ ok: false, error: `orca ${args.slice(0, 2).join(' ')}: ${message}` });
    });
  });
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return out;
}

const crop = (text, n = MESSAGE_CROP) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

const clean = (text) =>
  text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/[╭╮╰╯│─━┃┏┓┗┛]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Settled dispatches and their last messages never change, so keep them between polls.
const dispatchCache = new Map();
const messageCache = new Map();

// orca's `input` attention flag can stay set after the worker has moved on, so it only
// counts once the worker's output has been unchanged for this long.
const INPUT_IDLE_MS = 60_000;
// Per worker session: hash of its latest output and when that output last changed.
const activity = new Map();

function isSettled(worker) {
  return worker.state === 'succeeded' || worker.state === 'failed';
}

function statusOf(worker, live) {
  const attention = worker.attention || [];
  if (worker.state === 'failed' || attention.includes('failure')) return 'error';
  if (worker.state === 'succeeded') return 'done';
  const idle = !live || (!live.toolRunning && Date.now() - live.changedAt >= INPUT_IDLE_MS);
  if (attention.includes('input') && idle) return 'input';
  return 'working';
}

// The stream ends on a tool call with no result after it while a command is still running.
function isToolRunning(tail) {
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (line.startsWith('[tool result]')) return false;
    if (line.startsWith('[assistant]')) return line.startsWith('[assistant] [tool');
  }
  return false;
}

function hash(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}

function noteActivity(handle, tail) {
  const h = hash(tail);
  const seen = activity.get(handle);
  // First sighting counts as a change, so a worker shows as working for one idle window before any
  // stale input flag takes over.
  if (!seen || seen.hash !== h) activity.set(handle, { hash: h, changedAt: Date.now() });
  return activity.get(handle).changedAt;
}

async function dispatchFor(worker) {
  const cached = dispatchCache.get(worker.taskId);
  if (cached) return cached;
  const res = await orca(['orchestration', 'dispatch-show', '--task', worker.taskId]);
  if (!res.ok) return { error: res.error };
  const dispatch = res.result.dispatch;
  if (isSettled(worker)) dispatchCache.set(worker.taskId, dispatch);
  return dispatch;
}

function lastText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = messages[i].blocks || [];
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j];
      if (block.type === 'text' && block.text?.trim()) return { text: clean(block.text), at: messages[i].timestamp };
    }
  }
  return null;
}

// The live stream from `terminal read`. Its "[assistant] …" lines are the worker's own words;
// tool calls and results are skipped.
function streamMessage(tail) {
  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i];
    if (line.startsWith('[assistant]') && !line.startsWith('[assistant] [tool')) {
      return clean(line.replace(/^\[assistant\]\s*/, ''));
    }
  }
  return '';
}

// Active workers: read the live stream, which keeps updating after the hook transcript goes stale.
async function liveStateFor(handle, worker) {
  const res = await orca(['terminal', 'read', '--terminal', handle, '--limit', '120']);
  if (!res.ok) return null;
  const tail = res.result.terminal?.tail || [];
  if (!tail.length) return null;
  const changedAt = noteActivity(handle, tail.join('\n'));
  return { text: streamMessage(tail), changedAt, toolRunning: isToolRunning(tail) };
}

async function lastMessageFor(handle, worker) {
  if (!isSettled(worker)) {
    const live = await liveStateFor(handle, worker);
    if (live?.text) return { text: live.text, at: live.changedAt, live };
    if (live) return { ...(await transcriptMessageFor(worker)), live };
  }
  return transcriptMessageFor(worker);
}

async function transcriptMessageFor(worker) {
  const cached = messageCache.get(worker.dispatchId);
  if (cached) return cached;
  const res = await orca(['orchestration', 'worker-read', '--dispatch', worker.dispatchId, '--limit', '12']);
  if (!res.ok) return { text: '', error: res.error };
  const messages = res.result.transcript?.messages || [];
  const found = lastText(messages);
  const lines = res.result.lines || res.result.output;
  const message = found || (Array.isArray(lines) ? { text: clean(lines.slice(-3).join(' ')) } : { text: '' });
  if (isSettled(worker)) messageCache.set(worker.dispatchId, message);
  return message;
}

// Claude Code's status footer and prompt chrome, which fill the bottom of a terminal preview.
const TUI_NOISE = [/\/clear to save/i, /auto-update/i, /for shortcuts/i, /bypass permissions/i, /^[>❯$%#]\s*$/, /^esc to interrupt/i];

function terminalMessage(preview) {
  const lines = (preview || '')
    .split('\n')
    .map(clean)
    .filter((l) => l && !TUI_NOISE.some((re) => re.test(l)));
  return lines.slice(-3).join(' ');
}

// Coordinators and standalone agent tabs: working while their terminal is producing output.
const ACTIVE_OUTPUT_MS = 60_000;

function terminalStatus(s, screen) {
  if (s.kind === 'run' || !s.terminal?.connected) return 'offline';
  if (screen && screen.busy != null) return screen.busy ? 'working' : 'idle';
  const last = s.terminal.lastOutputAt;
  return last && Date.now() - last < ACTIVE_OUTPUT_MS ? 'working' : 'idle';
}

// Claude Code's screen: "⏺ " starts a reply or a tool call (a tool call is followed by a "⎿" line),
// and a spinner line like "✢ Cascading… (1m 49s" is shown while it works.
const SPINNER = /^\S\s+\S.*…\s*\(\d/;

function readClaudeScreen(tail) {
  const busy = tail.some((l) => SPINNER.test(l) || /esc to interrupt/i.test(l));
  let message = '';
  for (let i = 0; i < tail.length; i++) {
    if (!tail[i].startsWith('⏺ ')) continue;
    const body = [];
    let j = i + 1;
    while (j < tail.length && (tail[j].startsWith(' ') || tail[j] === '')) body.push(tail[j++]);
    const isTool = /^⏺ [\w.-]+\(/.test(tail[i]) || body.some((l) => l.trimStart().startsWith('⎿'));
    if (!isTool) message = clean([tail[i].slice(2), ...body].join(' '));
  }
  return { busy, message };
}

// The screen only shows what's visible, so a long tool output can push the last reply off it.
// Keep the last reply seen per terminal.
const lastScreenMessage = new Map();

async function screenFor(terminal) {
  if (!terminal?.connected || terminal.agentIdentity !== 'claude') return null;
  const res = await orca(['terminal', 'read', '--terminal', terminal.handle, '--limit', '200']);
  if (!res.ok) return null;
  if (res.result.terminal?.source !== 'screen') {
    // A /fork session has no readable screen. Its transcript still has the last reply; whether it
    // is working comes from the tab's output time instead (busy: null).
    const message = await lastClaudeReply(terminal.handle, terminal.worktreePath, terminal.title);
    return message ? { busy: null, message: clean(message) } : null;
  }
  const screen = readClaudeScreen(res.result.terminal.tail || []);
  if (screen.message) lastScreenMessage.set(terminal.handle, screen.message);
  return { ...screen, message: screen.message || lastScreenMessage.get(terminal.handle) || '' };
}

const pathOf = (worktreeId) => (worktreeId || '').split('::').pop() || '';
const basename = (p) => p.split('/').filter(Boolean).pop() || p;

// Only worktrees orca created for a worker can be cleaned up. Everything else (repo roots,
// your own checkouts, folders shared with other sessions) is off limits.
const ORCA_WORKSPACES = `${homedir()}/orca/workspaces/`;

function cleanupEligibility(session, worktree, sharedPaths) {
  const path = pathOf(session.worktreeId);
  if (!worktree) return { allowed: false, reason: 'Worktree is no longer registered in orca' };
  if (worktree.isMainWorktree) return { allowed: false, reason: 'This is a repo root, not a worker worktree' };
  if (!path.startsWith(ORCA_WORKSPACES)) return { allowed: false, reason: 'Worktree was not created by orca' };
  if (sharedPaths.get(path) > 1) return { allowed: false, reason: 'Worktree is shared with another session' };
  return { allowed: true, reason: null };
}

// Uncommitted-change counts per worktree, refreshed at most every 30s (git status is the slow part).
const GIT_TTL_MS = 30_000;
const gitCache = new Map();

function gitChanges(path) {
  const hit = gitCache.get(path);
  if (hit && Date.now() - hit.at < GIT_TTL_MS) return hit.value;
  const value = new Promise((resolve) => {
    execFile('git', ['-C', path, 'status', '--porcelain'], { timeout: 10000 }, (err, stdout) =>
      resolve(err ? null : stdout.split('\n').filter(Boolean).length),
    );
  });
  gitCache.set(path, { at: Date.now(), value });
  return value;
}

const shortBranch = (ref) => (ref || '').replace(/^refs\/heads\//, '');

// Orphans: worker worktrees orca created whose agent session is closed, plus worktrees under
// ~/orca/workspaces that no worker record points at. These are what cleanup is for.
async function collectOrphans({ closedWorkers, sessions, worktrees, sharedPaths, nextIndex }) {
  const openPaths = new Set(
    [...sessions.values()].filter((s) => s.kind === 'worker').map((s) => pathOf(s.worktreeId)),
  );
  const candidates = [];
  const seen = new Set();

  for (const s of closedWorkers) {
    const path = pathOf(s.worktreeId);
    const w = worktrees.get(s.worktreeId);
    // Workers that ran in a repo root or your own checkout leave nothing behind to clean up.
    if (!w || w.isMainWorktree || !path.startsWith(ORCA_WORKSPACES)) continue;
    if (openPaths.has(path) || seen.has(path)) continue;
    seen.add(path);
    candidates.push({ id: s.id, session: s, worktree: worktrees.get(s.worktreeId) });
  }
  for (const w of worktrees.values()) {
    if (!w.path.startsWith(ORCA_WORKSPACES) || w.isMainWorktree || openPaths.has(w.path) || seen.has(w.path)) continue;
    seen.add(w.path);
    candidates.push({ id: `worktree:${w.id}`, session: null, worktree: w });
  }

  const details = await pool(candidates, CONCURRENCY, async (c) => {
    const latest = c.session?.dispatches.at(-1)?.worker;
    const [changes, message] = await Promise.all([
      gitChanges(c.worktree.path),
      latest ? transcriptMessageFor(latest) : Promise.resolve({ text: '' }),
    ]);
    return { changes, message };
  });

  return candidates.map((c, i) => {
    const s = c.session;
    const latest = s?.dispatches.at(-1);
    // An open agent tab working in this folder blocks cleanup.
    const cleanup = sharedPaths.has(c.worktree.path)
      ? { allowed: false, reason: 'An open agent is using this folder' }
      : cleanupEligibility({ worktreeId: c.worktree.id }, c.worktree, sharedPaths);
    const { changes, message } = details[i];
    nextIndex.set(c.id, {
      kind: 'orphan',
      name: c.worktree.displayName || basename(c.worktree.path),
      worktreeId: c.worktree.id,
      path: c.worktree.path,
      dispatchIds: s ? s.dispatches.map((d) => d.worker.dispatchId) : [],
      latestDispatchId: latest?.worker.dispatchId,
      runId: latest?.runId,
      active: false,
      cleanup,
    });
    return {
      id: c.id,
      name: c.worktree.displayName || basename(c.worktree.path),
      repo: basename(c.worktree.path.slice(ORCA_WORKSPACES.length).split('/')[0] || ''),
      path: c.worktree.path,
      branch: shortBranch(c.worktree.branch),
      lastActivityAt: c.worktree.lastActivityAt || null,
      reason: s ? 'Agent session closed' : 'No worker record',
      outcome: latest ? latest.worker.state : null,
      runs: s ? [...s.runs] : [],
      tasks: s ? s.dispatches.length : 0,
      lastMessage: crop(message.text || ''),
      uncommitted: changes,
      cleanup: { ...cleanup, active: false, path: c.worktree.path },
    };
  });
}

// Server-side record of what each worker session owns, so cleanup never trusts paths from the browser.
// Each poll builds a fresh map and swaps it in synchronously, so lookups never see it half-built.
export const sessionIndex = new Map();

function replaceIndex(next) {
  sessionIndex.clear();
  for (const [k, v] of next) sessionIndex.set(k, v);
}

// Is the worker's agent session still open? orca's observation says live, exited or missing.
async function isWorkerOpen(worker) {
  const res = await orca(['orchestration', 'worker-show', '--dispatch', worker.dispatchId, '--full']);
  return res.ok && res.result.observation?.status === 'live';
}

// An agent tab is open while orca sees an agent in it. agentIdentity clears when the agent exits.
const isAgentTabOpen = (t) => Boolean(t?.connected && t.agentIdentity);

export async function collectGraph() {
  const errors = [];
  const [runList, workerList, terminalList, worktreeList] = await Promise.all([
    orca(['orchestration', 'run-list']),
    orca(['orchestration', 'worker-list']),
    orca(['terminal', 'list']),
    orca(['worktree', 'list']),
  ]);
  for (const r of [runList, workerList, terminalList, worktreeList]) if (!r.ok) errors.push(r.error);

  const worktrees = new Map((worktreeList.ok ? worktreeList.result.worktrees : []).map((w) => [w.id, w]));
  const nameForWorktree = (id) => {
    const w = worktrees.get(id);
    return w?.displayName || basename(w?.path || pathOf(id));
  };
  const terminals = new Map((terminalList.ok ? terminalList.result.terminals : []).map((t) => [t.handle, t]));

  const runs = runList.ok ? runList.result.runs.filter((r) => !r.legacy) : [];
  const runDetails = await pool(runs, CONCURRENCY, (r) => orca(['orchestration', 'run-show', '--id', r.id, '--full']));
  const runById = new Map();
  runs.forEach((r, i) => {
    const detail = runDetails[i];
    runById.set(r.id, {
      id: r.id,
      objective: r.objective,
      coordinator: detail.ok ? detail.result.run?.coordinator_handle ?? null : null,
    });
  });

  const workers = workerList.ok ? workerList.result.workers : [];
  const dispatches = await pool(workers, CONCURRENCY, dispatchFor);

  // One node per agent session. A session can take several dispatches (follow-ups reuse it).
  const sessions = new Map();
  const edges = new Map();

  workers.forEach((worker, i) => {
    const d = dispatches[i];
    if (d?.error) errors.push(d.error);
    const runId = d?.run_id;
    const run = runById.get(runId);
    const parent = d?.creator_handle || run?.coordinator || `run:${runId || 'unknown'}`;
    const handle = d?.assignee_handle || worker.terminal;
    const dispatchedAt = d?.dispatched_at || '';

    const session = sessions.get(handle) || {
      id: handle,
      kind: 'worker',
      name: nameForWorktree(worker.workspace),
      worktreeId: worker.workspace,
      runs: new Set(),
      dispatches: [],
    };
    session.runs.add(run?.objective || runId || 'unknown run');
    session.dispatches.push({ worker, dispatchedAt, runId, coordinator: parent });
    sessions.set(handle, session);

    const key = `${parent}->${handle}`;
    const edge = edges.get(key) || { id: key, source: parent, target: handle, count: 0 };
    edge.count += 1;
    edges.set(key, edge);

    if (!sessions.has(parent)) {
      const terminal = terminals.get(parent);
      if (parent.startsWith('run:')) {
        sessions.set(parent, {
          id: parent,
          kind: 'run',
          name: run?.objective || runId,
          runs: new Set([run?.objective || runId]),
          dispatches: [],
        });
      } else {
        sessions.set(parent, {
          id: parent,
          kind: 'coordinator',
          name: terminal
            ? `${terminal.title} · ${nameForWorktree(terminal.worktreeId)}`
            : `Closed coordinator ${parent.replace(/^term_/, '').slice(0, 8)}`,
          runs: new Set(),
          dispatches: [],
          terminal,
        });
      }
    }
    sessions.get(parent).runs.add(run?.objective || runId || 'unknown run');
  });

  // Only open agents appear. A worker stays while its latest dispatch's agent session is live; a
  // coordinator while an agent is running in its tab. Runs without a coordinator are dropped, and
  // workers whose parent is gone become roots.
  const allWorkerSessions = [...sessions.values()].filter((s) => s.kind === 'worker');
  allWorkerSessions.forEach((s) => s.dispatches.sort((a, b) => a.dispatchedAt.localeCompare(b.dispatchedAt)));
  const open = await pool(allWorkerSessions, CONCURRENCY, (s) => isWorkerOpen(s.dispatches.at(-1).worker));
  const closedWorkers = allWorkerSessions.filter((_, i) => !open[i]);
  closedWorkers.forEach((s) => sessions.delete(s.id));
  for (const s of [...sessions.values()]) {
    if (s.kind === 'run' || (s.kind === 'coordinator' && !isAgentTabOpen(s.terminal))) sessions.delete(s.id);
  }
  for (const [key, e] of edges) if (!sessions.has(e.source) || !sessions.has(e.target)) edges.delete(key);

  // Agent tabs outside any orchestration run (like the session you're chatting in) still get a node.
  for (const t of terminals.values()) {
    if (!isAgentTabOpen(t) || sessions.has(t.handle)) continue;
    sessions.set(t.handle, {
      id: t.handle,
      kind: 'session',
      name: `${t.title} · ${nameForWorktree(t.worktreeId)}`,
      runs: new Set(),
      dispatches: [],
      terminal: t,
    });
  }

  // Last message for the latest dispatch of every worker session.
  const workerSessions = [...sessions.values()].filter((s) => s.kind === 'worker');
  const sharedPaths = new Map();
  for (const s of sessions.values()) {
    const p = s.kind === 'worker' ? pathOf(s.worktreeId) : s.terminal?.worktreePath;
    if (p) sharedPaths.set(p, (sharedPaths.get(p) || 0) + 1);
  }
  const nextIndex = new Map();
  const terminalSessions = [...sessions.values()].filter((s) => s.kind !== 'worker');
  const [messages, screens] = await Promise.all([
    pool(workerSessions, CONCURRENCY, (s) => lastMessageFor(s.id, s.dispatches.at(-1).worker)),
    pool(terminalSessions, CONCURRENCY, (s) => screenFor(s.terminal)),
  ]);

  const nodes = [...sessions.values()].map((s) => {
    const base = { id: s.id, kind: s.kind, name: s.name, runs: [...s.runs] };
    if (s.kind === 'worker') {
      const latest = s.dispatches.at(-1).worker;
      const message = messages[workerSessions.indexOf(s)] || { text: '' };
      if (message.error) errors.push(message.error);
      const cleanup = cleanupEligibility(s, worktrees.get(s.worktreeId), sharedPaths);
      const active = s.dispatches.some((d) => !isSettled(d.worker));
      const last = s.dispatches.at(-1);
      nextIndex.set(s.id, {
        kind: 'worker',
        name: s.name,
        worktreeId: s.worktreeId,
        path: pathOf(s.worktreeId),
        dispatchIds: s.dispatches.map((d) => d.worker.dispatchId),
        latestDispatchId: latest.dispatchId,
        runId: last.runId,
        coordinator: last.coordinator,
        active,
        cleanup,
      });
      return {
        ...base,
        cleanup: { ...cleanup, active, path: pathOf(s.worktreeId) },
        status: statusOf(latest, message.live),
        liveness: latest.liveness,
        dispatches: {
          total: s.dispatches.length,
          done: s.dispatches.filter((d) => d.worker.state === 'succeeded').length,
        },
        lastMessage: crop(message.text || ''),
        lastMessageFull: message.text || '',
        lastMessageAt: message.at || null,
      };
    }
    const screen = screens[terminalSessions.indexOf(s)];
    // A Claude tab with no reply on screen yet shows nothing, rather than its shell prompt.
    const preview = screen ? screen.message : s.terminal ? terminalMessage(s.terminal.preview) : '';
    nextIndex.set(s.id, {
      kind: s.kind,
      name: s.name,
      connected: Boolean(s.terminal?.connected),
      path: s.terminal?.worktreePath || pathOf(s.terminal?.worktreeId),
      agent: s.terminal?.agentIdentity || null,
      title: s.terminal?.title || '',
    });
    return {
      ...base,
      status: terminalStatus(s, screen),
      lastMessage: crop(preview),
      lastMessageFull: preview,
      lastMessageAt: s.terminal?.lastOutputAt || null,
    };
  });

  const orphans = await collectOrphans({ closedWorkers, sessions, worktrees, sharedPaths, nextIndex });

  replaceIndex(nextIndex);
  return { generatedAt: new Date().toISOString(), nodes, edges: [...edges.values()], orphans, errors };
}
