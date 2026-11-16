// Claude Code tabs: the screen only shows rendered text, so tables lose their Markdown and code
// blocks lose their fences. Claude Code also writes every session to
// ~/.claude/projects/<cwd with non-alphanumerics as "-">/<session>.jsonl, which keeps the original
// Markdown. orca doesn't say which file belongs to which tab, so this finds the file whose session
// title matches the tab's title, or whose latest prompt and reply match what's on the tab's screen.
//
// A fork (/fork, or --fork-session) gets its own file that starts with a copy of the parent's
// conversation since its last compaction, so the shared history shows in the fork's thread too.
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { clip, toolInput } from './format.mjs';

const PROJECTS = join(homedir(), '.claude', 'projects');
const TAIL_BYTES = 3 * 1024 * 1024; // enough for a few hundred messages; files can be tens of MB
const MAX_MESSAGES = 400;
const CANDIDATES = 25;
const RECENT_MS = 3 * 24 * 3600 * 1000;

const dashed = (path) => path.replace(/[^a-zA-Z0-9]/g, '-');
const norm = (text) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

// Lines Claude Code writes as "user" that you didn't type: command output, hook output, reminders.
const NOT_TYPED = /^\s*<(command-message|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-stdout|bash-stderr|task-notification|user-prompt-submit-hook)\b/;
const tag = (text, name) => text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim();

// What you typed, as shown on screen: "/skill args" for slash commands, "! cmd" for shell mode.
function typed(text) {
  const command = tag(text, 'command-name');
  if (command) return [command, tag(text, 'command-args')].filter(Boolean).join(' ');
  const bash = tag(text, 'bash-input');
  if (bash) return `! ${bash}`;
  return NOT_TYPED.test(text) ? null : text;
}

// The notice Claude Code adds as a fork's first prompt.
function forkDivider(text) {
  if (!/<fork-source>/.test(text)) return null;
  const parent = text.match(/self-reported name is '([^']+)'/)?.[1];
  return `Forked from ${parent ? `“${parent}”` : 'another session'}. Everything above is shared history.`;
}

async function readTail(file) {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    // Starting mid-file means the first line is partial.
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } finally {
    await fh.close();
  }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return JSON.stringify(content ?? '', null, 2);
}

function parse(text) {
  const out = [];
  let customTitle = '';
  let aiTitle = '';
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    // Titles are written again now and then, so the newest one is near the end of the file.
    if (e.type === 'custom-title' && e.customTitle) customTitle = e.customTitle;
    if (e.type === 'ai-title' && e.aiTitle) aiTitle = e.aiTitle;
    if ((e.type !== 'user' && e.type !== 'assistant') || e.isSidechain || e.isMeta) continue;
    const at = e.timestamp ? Date.parse(e.timestamp) : undefined;
    if (e.isCompactSummary) {
      out.push({ kind: 'divider', text: 'Earlier messages were compacted.', at });
      continue;
    }
    const content = e.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text?.trim()) {
        const fork = e.type === 'user' ? forkDivider(b.text) : null;
        if (fork) {
          out.push({ kind: 'divider', text: fork, at });
          continue;
        }
        const text = e.type === 'user' ? typed(b.text) : b.text;
        if (!text?.trim()) continue;
        const prev = out.at(-1);
        // Claude writes a pasted image's "[Image: source: <path>]" as its own entry: keep it with its prompt.
        if (e.type === 'user' && prev?.kind === 'user' && /^(\[Image: source: [^\]]+\]\s*)+$/.test(text.trim())) prev.text += `\n${text.trim()}`;
        else out.push({ kind: e.type === 'user' ? 'user' : 'assistant', text: text.trim(), at });
      } else if (b.type === 'thinking' && b.thinking?.trim()) {
        out.push({ kind: 'thinking', text: b.thinking.trim(), at });
      } else if (b.type === 'tool_use') {
        out.push({ kind: 'tool', name: b.name, description: b.input?.description, text: toolInput(b.input), at });
      } else if (b.type === 'tool_result') {
        out.push({ kind: 'result', error: Boolean(b.is_error), text: clip(resultText(b.content).trimEnd()), at });
      }
    }
  }
  return { messages: out.slice(-MAX_MESSAGES), title: customTitle || aiTitle };
}

// The newest prompt and reply on screen, as normalised snippets. The screen strips Markdown and
// wraps lines, so compare only letters and digits from the first line of each.
function probesFrom(screen) {
  const probes = [];
  for (const kind of ['user', 'assistant']) {
    const m = [...screen].reverse().find((x) => x.kind === kind);
    const first = norm((m?.text || '').split('\n')[0]).slice(0, 48);
    // Pasted prompts show as "[Pasted text #1 +20 lines]", which the transcript never contains.
    if (first.length >= 12 && !/^pastedtext/.test(first)) probes.push(first);
  }
  return probes;
}

const matches = (messages, probes) =>
  probes.length > 0 && probes.every((p) => messages.some((m) => (m.kind === 'user' || m.kind === 'assistant') && norm(m.text).includes(p)));

// Claude Code puts the session title in the tab title, after a status glyph ("✳ ", "◐ ") while it works.
const tabTitle = (title) => norm((title || '').replace(/^[^\p{L}\p{N}]+/u, ''));
// A title cut short in the tab ("…") matches by prefix. Otherwise only an exact match counts: an
// unrenamed fork is titled "<parent title> ⑂ …", which must not match the parent's tab.
const cutShort = (title) => /(…|\.\.\.)\s*$/.test(title || '');
const sameTitle = (want, have, prefix) => Boolean(want && have) && (want === have || (prefix && want.length >= 16 && have.startsWith(want)));

// Parsed tails, reused while the file hasn't changed.
const parsed = new Map();
async function transcriptOf(file) {
  const st = await stat(file);
  const hit = parsed.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.transcript;
  const transcript = parse(await readTail(file));
  parsed.set(file, { mtime: st.mtimeMs, size: st.size, transcript });
  return transcript;
}

async function candidates(path) {
  const prefix = dashed(path);
  const dirs = (await readdir(PROJECTS, { withFileTypes: true }).catch(() => [])).filter(
    (d) => d.isDirectory() && d.name.startsWith(prefix),
  );
  const files = [];
  for (const d of dirs) {
    const dir = join(PROJECTS, d.name);
    for (const f of await readdir(dir).catch(() => [])) {
      if (!f.endsWith('.jsonl')) continue;
      const st = await stat(join(dir, f)).catch(() => null);
      if (st && Date.now() - st.mtimeMs < RECENT_MS) files.push({ file: join(dir, f), mtime: st.mtimeMs });
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).slice(0, CANDIDATES).map((f) => f.file);
}

const fileFor = new Map(); // terminal handle -> transcript file

// Returns the tab's messages from its transcript, or null when no transcript matches the tab.
// `screen` is what's on the tab's screen (empty when orca can't read it, as for /fork sessions).
export async function claudeTranscript(handle, path, screen, title) {
  const probes = probesFrom(screen);
  const want = tabTitle(title);
  const prefix = cutShort(title);
  const titled = (t) => sameTitle(want, norm(t.title), prefix);
  const cached = fileFor.get(handle);
  if (cached) {
    const t = await transcriptOf(cached).catch(() => null);
    // With nothing to check against (just after /clear), keep the last match.
    if (t && (titled(t) || matches(t.messages, probes) || (!probes.length && !want))) return t.messages;
    fileFor.delete(handle);
  }
  if (!path || (!probes.length && !want)) return null;

  // Newest first. Best: title and screen both match. Then title alone (a /fork tab has no screen,
  // and a slash command on screen isn't stored as a prompt). Then screen alone (an unnamed session).
  const seen = [];
  for (const file of await candidates(path)) {
    const t = await transcriptOf(file).catch(() => null);
    if (!t) continue;
    const byTitle = titled(t);
    const byScreen = matches(t.messages, probes);
    if (byTitle && (byScreen || !probes.length)) return remember(handle, file, t);
    seen.push({ file, t, byTitle, byScreen });
  }
  const pick = seen.find((x) => x.byTitle) || seen.find((x) => x.byScreen);
  return pick ? remember(handle, pick.file, pick.t) : null;
}

function remember(handle, file, t) {
  fileFor.set(handle, file);
  return t.messages;
}

// The newest reply in a Claude tab's transcript, for the graph node when orca can't read the screen.
export async function lastClaudeReply(handle, path, title) {
  const messages = await claudeTranscript(handle, path, [], title).catch(() => null);
  return [...(messages || [])].reverse().find((m) => m.kind === 'assistant')?.text || '';
}
