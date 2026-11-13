// Claude Code tabs: the screen only shows rendered text, so tables lose their Markdown and code
// blocks lose their fences. Claude Code also writes every session to
// ~/.claude/projects/<cwd with non-alphanumerics as "-">/<session>.jsonl, which keeps the original
// Markdown. orca doesn't say which file belongs to which tab, so this finds the file whose latest
// prompt and reply match what's on the tab's screen.
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

function parse(text, { clip, toolInput }) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if ((e.type !== 'user' && e.type !== 'assistant') || e.isSidechain || e.isMeta) continue;
    const at = e.timestamp ? Date.parse(e.timestamp) : undefined;
    const content = e.message?.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (b.type === 'text' && b.text?.trim()) {
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
  return out.slice(-MAX_MESSAGES);
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
  probes.every((p) => messages.some((m) => (m.kind === 'user' || m.kind === 'assistant') && norm(m.text).includes(p)));

// Parsed tails, reused while the file hasn't changed.
const parsed = new Map();
async function messagesOf(file, helpers) {
  const st = await stat(file);
  const hit = parsed.get(file);
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.messages;
  const messages = parse(await readTail(file), helpers);
  parsed.set(file, { mtime: st.mtimeMs, size: st.size, messages });
  return messages;
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

// Returns the tab's messages from its transcript, or null when no transcript matches the screen.
export async function claudeTranscript(handle, path, screen, helpers) {
  const probes = probesFrom(screen);
  const cached = fileFor.get(handle);
  if (cached) {
    const messages = await messagesOf(cached, helpers).catch(() => null);
    // With nothing on screen to check against (just after /clear), keep the last match.
    if (messages && (!probes.length || matches(messages, probes))) return messages;
    fileFor.delete(handle);
  }
  if (!probes.length || !path) return null;
  for (const file of await candidates(path)) {
    if (file === cached) continue;
    const messages = await messagesOf(file, helpers).catch(() => null);
    if (messages && matches(messages, probes)) {
      fileFor.set(handle, file);
      return messages;
    }
  }
  return null;
}
