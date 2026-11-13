// Side-pane data for one session (a chat-style message list plus raw output) and sending it a message.
import { claudeTranscript } from './claude.mjs';
import { imageLine } from './images.mjs';
import { orca, sessionIndex } from './orca.mjs';

const TRANSCRIPT_LIMIT = 200;
const STREAM_LIMIT = 400;
const TOOL_PREVIEW = 4000;
const OWN_SUBJECT = 'Message from orca-graph';

// Every source is normalised to these entries:
//   user | assistant | thinking  { text }
//   tool                          { name, text }        text = command or input
//   result                        { text, error }
//   divider                       { text }
const clip = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2);
  return text.length > TOOL_PREVIEW ? `${text.slice(0, TOOL_PREVIEW)}\n… (truncated)` : text;
};

// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

function toolInput(input) {
  if (!input || typeof input !== 'object') return clip(input);
  return clip(input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.prompt ?? input);
}

// orca's hook transcript (worker-read).
function fromTranscript(messages) {
  const out = [];
  for (const m of messages) {
    for (const b of m.blocks || []) {
      if (b.type === 'text' && b.text?.trim()) {
        const kind = m.role === 'reasoning' ? 'thinking' : m.role === 'user' ? 'user' : 'assistant';
        out.push({ kind, text: b.text.trim(), at: m.timestamp });
      } else if (b.type === 'tool-call') {
        out.push({ kind: 'tool', name: b.name, description: b.input?.description, text: toolInput(b.input), at: m.timestamp });
      } else if (b.type === 'tool-result') {
        out.push({ kind: 'result', error: Boolean(b.isError), text: clip(b.output), at: m.timestamp });
      }
    }
  }
  return out;
}

// A structured worker's live stream: "[assistant] …", "[assistant] [tool Bash] {json}", "[tool result] …".
function fromWorkerStream(lines) {
  const out = [];
  let current = null;
  const push = (entry) => {
    current = entry;
    out.push(entry);
  };
  for (const raw of lines) {
    const line = stripAnsi(raw);
    const tool = line.match(/^\[assistant\] \[tool ([^\]]+)\]\s?(.*)$/);
    const tag = line.match(/^\[(assistant|user|reasoning|thinking|tool result|tool error)\]\s?(.*)$/);
    if (tool) {
      let input = tool[2];
      let description;
      try {
        const parsed = JSON.parse(input);
        description = parsed.description;
        input = toolInput(parsed);
      } catch {
        /* clipped or not JSON: keep the raw text */
      }
      push({ kind: 'tool', name: tool[1], description, text: input });
    } else if (tag) {
      const kind = { assistant: 'assistant', user: 'user', reasoning: 'thinking', thinking: 'thinking' }[tag[1]] ?? 'result';
      push({ kind, error: tag[1] === 'tool error', text: tag[2] });
    } else if (current) {
      current.text += `\n${line}`;
    }
  }
  return out.map((e) => ({ ...e, text: e.kind === 'result' ? clip(e.text.trimEnd()) : e.text.trim() })).filter((e) => e.text || e.kind === 'tool');
}

// Claude Code's terminal screen (coordinators and standalone tabs).
function fromClaudeScreen(lines) {
  const clean = lines.map((l) => stripAnsi(l).replace(/\s+$/, ''));
  // Drop the input box and status footer: everything from the last pair of horizontal rules down.
  const rules = clean.reduce((acc, l, i) => (/^─{10,}/.test(l) ? [...acc, i] : acc), []);
  const end = rules.length >= 2 ? rules.at(-2) : clean.length;
  const out = [];
  let current = null;
  for (const line of clean.slice(0, end)) {
    if (/^⏺ /.test(line)) {
      const head = line.slice(2);
      const call = head.match(/^([\w.-]+)\((.*)\)?$/);
      current = call ? { kind: 'tool', name: call[1], text: call[2].replace(/\)$/, '') } : { kind: 'assistant', text: head };
      out.push(current);
    } else if (/^[>❯] \S/.test(line)) {
      current = { kind: 'user', text: line.slice(2) };
      out.push(current);
    } else if (/^\s+⎿/.test(line)) {
      // A "⎿" under a reply means it was a tool call shown by its description.
      if (current?.kind === 'assistant') current.kind = 'tool';
      current = { kind: 'result', text: line.replace(/^\s+⎿\s?/, '') };
      out.push(current);
    } else if (/^[✻✽✢✳✶·*] .*…/.test(line) || /^\S\s+\S.*…\s*\(\d/.test(line)) {
      current = null; // spinner / thinking indicator
    } else if (current && (line.startsWith(' ') || line === '')) {
      current.text += `\n${line.replace(/^ {2,5}/, '')}`;
    }
  }
  return out.map((e) => ({ ...e, text: e.text.trim() })).filter((e) => e.text || e.kind === 'tool');
}

// The hook transcript can stop updating while the live stream carries on. Append the stream from
// the point where it passes the transcript's last reply.
function merge(transcript, live) {
  if (!live.length) return transcript;
  if (!transcript.length) return live;
  const key = (t) => t.replace(/\s+/g, ' ').slice(0, 160);
  const lastReply = [...transcript].reverse().find((e) => e.kind === 'assistant');
  const idx = lastReply ? live.map((e) => (e.kind === 'assistant' ? key(e.text) : null)).lastIndexOf(key(lastReply.text)) : -1;
  if (idx >= 0) return [...transcript, ...live.slice(idx + 1)];
  const at = transcript.at(-1)?.at;
  const when = at ? ` at ${new Date(at).toLocaleTimeString()}` : '';
  return [...transcript, { kind: 'divider', text: `Transcript stopped${when}. Live output below.` }, ...live];
}

async function streamFor(handle) {
  const res = await orca(['terminal', 'read', '--terminal', handle, '--limit', String(STREAM_LIMIT)]);
  if (!res.ok) return { lines: [], error: res.error };
  const t = res.result.terminal || {};
  return { lines: t.tail || [], status: t.status, source: t.source };
}

// A worker learns about mailbox messages from a notice like "You have 3 orchestration messages.
// Run `orca orchestration check`.", then reads them with a tool call. In the thread, each notice is
// replaced by the messages it announced, taken from orca's inbox. Notices are matched newest first,
// because the live stream may have lost its oldest lines.
const NOTICE = /^You have (\d+) (?:new )?orchestration messages?\b/i;

async function inboxFor(id, s) {
  const targets = new Set([id, ...(s.dispatchIds || []).map((d) => `dispatch:${d}`)]);
  const res = await orca(['orchestration', 'inbox', '--full', '--limit', '500']);
  if (!res.ok) return [];
  return (res.result.messages || [])
    .filter((m) => targets.has(m.to_handle) && m.delivered_at)
    .sort((a, b) => a.sequence - b.sequence);
}

function senderLabel(m) {
  if (m.subject === OWN_SUBJECT) return 'You';
  const from = m.from_handle || '';
  if (from.startsWith('run:')) return 'Run';
  return sessionIndex.get(from)?.name || from.replace(/^(term|structworker)_/, '').slice(0, 8) || 'Unknown sender';
}

function withInbox(messages, inbox) {
  if (!inbox.length || !messages.some((m) => m.kind === 'user' && NOTICE.test(m.text))) return messages;
  const queue = [...inbox];
  const out = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const notice = m.kind === 'user' && m.text.match(NOTICE);
    const batch = notice ? queue.splice(Math.max(0, queue.length - Number(notice[1]))) : [];
    if (!batch.length) {
      out.push(m);
      continue;
    }
    for (const msg of batch.reverse()) {
      const own = msg.subject === OWN_SUBJECT;
      out.push({
        kind: 'user',
        text: msg.body || msg.subject,
        from: senderLabel(msg),
        subject: own ? undefined : msg.subject,
        at: Date.parse(msg.created_at) || m.at,
      });
    }
  }
  return out.reverse();
}

export async function sessionDetail(id) {
  const s = sessionIndex.get(id);
  if (!s) return { ok: false, error: 'This agent is no longer open.' };
  const base = { ok: true, id, kind: s.kind, name: s.name };
  if (s.kind === 'run') return { ...base, messages: [], raw: [], canSend: false, note: 'This run has no coordinator session.' };

  if (s.kind === 'coordinator' || s.kind === 'session') {
    if (!s.connected) return { ...base, messages: [], raw: [], canSend: false, note: 'This terminal is closed.' };
    const stream = await streamFor(id);
    const raw = stream.lines.map(stripAnsi);
    if (stream.source !== 'screen') return { ...base, path: s.path, messages: fromWorkerStream(stream.lines), raw, error: stream.error, canSend: true };
    const screen = fromClaudeScreen(stream.lines);
    // Prefer Claude's own transcript: it keeps the Markdown (tables, code blocks) and the whole history.
    const transcript = s.agent === 'claude' ? await claudeTranscript(id, s.path, screen, { clip, toolInput }).catch(() => null) : null;
    const busy = stream.lines.some((l) => /esc to interrupt/i.test(l));
    return {
      ...base,
      path: s.path,
      messages: transcript ? [...transcript, ...(busy ? [{ kind: 'divider', text: 'Working…' }] : [])] : screen,
      raw,
      error: stream.error,
      note: transcript ? undefined : 'Showing what is on this tab’s screen right now.',
      canSend: true,
    };
  }

  const [read, stream, inbox] = await Promise.all([
    orca(['orchestration', 'worker-read', '--dispatch', s.latestDispatchId, '--limit', String(TRANSCRIPT_LIMIT)]),
    streamFor(id),
    inboxFor(id, s),
  ]);
  const transcript = read.ok ? fromTranscript(read.result.transcript?.messages || []) : [];
  const live = stream.source === 'screen' ? fromClaudeScreen(stream.lines) : fromWorkerStream(stream.lines);
  return {
    ...base,
    path: s.path,
    messages: withInbox(merge(transcript, live), inbox),
    raw: stream.lines.map(stripAnsi),
    error: [read.ok ? null : read.error, stream.error].filter(Boolean).join('\n') || undefined,
    canSend: s.active || stream.status === 'running',
  };
}

// Who the mailbox message is from. orca needs a sender terminal and sends replies to it.
// 1. The coordinator that dispatched the worker, while its tab is open: replies land with the
//    agent that owns the work.
// 2. ORCA_TERMINAL_HANDLE, set when this server was started inside an Orca terminal.
// A plain handle like run:<id> is not a terminal, so it is never used.
function senderFor(worker) {
  const coordinator = worker.coordinator;
  const entry = coordinator ? sessionIndex.get(coordinator) : null;
  if (coordinator?.startsWith('term_') && entry?.connected) return { handle: coordinator, name: entry.name };
  const own = process.env.ORCA_TERMINAL_HANDLE;
  if (own) return { handle: own, name: 'the terminal running orca-graph' };
  return null;
}

// Structured workers (structworker_*) are agent sessions, not terminals: orca refuses terminal
// commands for them, so their messages go straight to the orchestration mailbox.
const isAgentSession = (id) => id.startsWith('structworker_');

// Claude Code attaches an image when a paste holds nothing but the image's path, which is how
// Orca's own image paste works. So each path is pasted on its own (bracketed paste, without Enter),
// then the message is sent with Enter. A path inside a longer paste would stay plain text.
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendToClaudeTab(id, message, images) {
  for (const path of images) {
    const r = await orca(['terminal', 'send', '--terminal', id, '--text', `${PASTE_START}${path}${PASTE_END}`]);
    if (!r.ok) return r;
    await pause(250); // Claude reads the file before the next paste arrives
  }
  return orca(['terminal', 'send', '--terminal', id, '--text', message || ' ', '--enter', '--wait-submit', '5']);
}

// Prompts the agent directly where orca allows it; otherwise uses the worker's mailbox. A working
// worker reads the message now; a finished one gets it as a follow-up task.
export async function sendMessage(id, message, images = []) {
  const s = sessionIndex.get(id);
  if (!s) return { ok: false, error: 'This session is no longer open. Refresh and try again.' };
  if (s.kind === 'run') return { ok: false, error: 'This run has no session to message.' };
  // Agents other than a Claude tab get the image paths as text, and open the files themselves.
  const text = [message, ...images.map(imageLine)].filter(Boolean).join('\n\n');

  if (images.length && s.agent === 'claude') {
    const r = await sendToClaudeTab(id, message, images);
    return r.ok ? { ok: true, via: 'prompt' } : { ok: false, error: r.error };
  }

  let direct = null;
  if (!isAgentSession(id)) {
    direct = await orca(['terminal', 'send', '--terminal', id, '--text', text, '--enter', '--wait-submit', '5']);
    if (direct.ok) return { ok: true, via: 'prompt' };
    if (s.kind !== 'worker') return { ok: false, error: direct.error };
  }
  if (s.kind !== 'worker') return { ok: false, error: 'This session can only take messages through its own chat tab.' };

  const sender = senderFor(s);
  if (!sender) {
    return {
      ok: false,
      error:
        'orca needs a sender for mailbox messages, and none is available: the coordinator that dispatched this worker is closed, ' +
        'and orca-graph was not started inside an Orca terminal. Start orca-graph from an Orca terminal tab, or reopen the coordinator.',
    };
  }
  const args = ['orchestration', 'send', '--to', `dispatch:${s.latestDispatchId}`, '--from', sender.handle, '--subject', OWN_SUBJECT, '--body', text];
  if (s.runId) args.push('--run', s.runId);
  const mail = await orca(args);
  if (mail.ok) return { ok: true, via: 'mailbox', from: sender.name };
  return { ok: false, error: [direct?.error, mail.error].filter(Boolean).join('\n') };
}
