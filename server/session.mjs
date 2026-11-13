// Side-pane data for one session (a chat-style message list plus raw output) and sending it a message.
import { claudeTranscript } from './claude.mjs';
import { orca, sessionIndex } from './orca.mjs';

const TRANSCRIPT_LIMIT = 200;
const STREAM_LIMIT = 400;
const TOOL_PREVIEW = 4000;

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

  const [read, stream] = await Promise.all([
    orca(['orchestration', 'worker-read', '--dispatch', s.latestDispatchId, '--limit', String(TRANSCRIPT_LIMIT)]),
    streamFor(id),
  ]);
  const transcript = read.ok ? fromTranscript(read.result.transcript?.messages || []) : [];
  const live = stream.source === 'screen' ? fromClaudeScreen(stream.lines) : fromWorkerStream(stream.lines);
  return {
    ...base,
    path: s.path,
    messages: merge(transcript, live),
    raw: stream.lines.map(stripAnsi),
    error: [read.ok ? null : read.error, stream.error].filter(Boolean).join('\n') || undefined,
    canSend: s.active || stream.status === 'running',
  };
}

// Prompts the agent directly. orca rejects terminal commands for some chat-style worker
// sessions; for those the message goes to the worker's orchestration mailbox instead.
export async function sendMessage(id, text) {
  const s = sessionIndex.get(id);
  if (!s) return { ok: false, error: 'Unknown session. Refresh and try again.' };
  if (s.kind === 'run') return { ok: false, error: 'This run has no session to message.' };

  const direct = await orca(['terminal', 'send', '--terminal', id, '--text', text, '--enter', '--wait-submit', '5']);
  if (direct.ok) return { ok: true, via: 'prompt' };
  if (s.kind !== 'worker') return { ok: false, error: direct.error };

  const args = ['orchestration', 'send', '--to', `dispatch:${s.latestDispatchId}`, '--subject', 'Message from orca-graph', '--body', text];
  if (s.runId) args.push('--run', s.runId);
  const mail = await orca(args);
  if (mail.ok) return { ok: true, via: 'mailbox', note: `Sent to the worker's mailbox. Direct prompt failed: ${direct.error}` };
  return { ok: false, error: `${direct.error}\n${mail.error}` };
}
