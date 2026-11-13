import { imageUrl } from './api';
import { Markdown } from './Markdown';
import type { Message } from './types';

// Replies and prompts are the main thread. Thinking, tool calls and their output between two
// replies fold into one "steps" row that starts closed.
type Item = { type: 'message'; m: Message } | { type: 'steps'; steps: Message[] };

const MAIN = new Set<Message['kind']>(['user', 'assistant', 'divider']);

function group(messages: Message[]): Item[] {
  const out: Item[] = [];
  for (const m of messages) {
    if (MAIN.has(m.kind)) out.push({ type: 'message', m });
    else {
      const prev = out.at(-1);
      if (prev?.type === 'steps') prev.steps.push(m);
      else out.push({ type: 'steps', steps: [m] });
    }
  }
  return out;
}

const time = (at?: number) => (at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');

function summary(steps: Message[]) {
  const tools = steps.filter((s) => s.kind === 'tool');
  const thoughts = steps.filter((s) => s.kind === 'thinking').length;
  const errors = steps.filter((s) => s.kind === 'result' && s.error).length;
  const names = [...new Set(tools.map((t) => t.name).filter(Boolean))].slice(0, 3).join(', ');
  const parts = [
    thoughts && `${thoughts} thought${thoughts > 1 ? 's' : ''}`,
    tools.length && `${tools.length} tool call${tools.length > 1 ? 's' : ''}${names ? ` (${names})` : ''}`,
    errors && `${errors} error${errors > 1 ? 's' : ''}`,
  ].filter(Boolean);
  return parts.join(' · ') || `${steps.length} steps`;
}

// Images in a prompt arrive as "[Image: source: <path>]" lines, plus "[Image #N]" placeholders from
// Claude Code. Show the files as thumbnails, and a plain tile for images pasted without a file.
const SOURCE = /\[Image: source: ([^\]\n]+)\]/g;
const PLACEHOLDER = /\[Image #\d+\]/g;

function splitImages(text: string) {
  const paths = [...text.matchAll(SOURCE)].map((m) => m[1].trim());
  const placeholders = (text.match(PLACEHOLDER) || []).length;
  const rest = text.replace(SOURCE, '').replace(PLACEHOLDER, '').replace(/\n{3,}/g, '\n\n').trim();
  return { paths, unseen: Math.max(0, placeholders - paths.length), rest };
}

function Images({ paths, unseen }: { paths: string[]; unseen: number }) {
  if (!paths.length && !unseen) return null;
  return (
    <div className="msg-images">
      {paths.map((p) => (
        <a key={p} href={imageUrl(p)} target="_blank" rel="noreferrer" title={p}>
          <img src={imageUrl(p)} alt="Attached image" loading="lazy" onError={(e) => e.currentTarget.parentElement?.classList.add('missing')} />
        </a>
      ))}
      {Array.from({ length: unseen }, (_, i) => (
        <span key={i} className="img-tile" title="Pasted image (no file to preview)">
          Image
        </span>
      ))}
    </div>
  );
}

function Step({ s }: { s: Message }) {
  if (s.kind === 'thinking') {
    return (
      <div className="step step-thinking">
        <div className="step-label">Thinking</div>
        <div className="thinking">{s.text}</div>
      </div>
    );
  }
  if (s.kind === 'tool') {
    return (
      <div className="step step-tool">
        <div className="step-label">
          <span className="tool-name">{s.name ?? 'Tool'}</span>
          {s.description && <span className="muted"> · {s.description}</span>}
        </div>
        {s.text && <pre className="code">{s.text}</pre>}
      </div>
    );
  }
  return (
    <div className={`step step-result${s.error ? ' is-error' : ''}`}>
      <div className="step-label">{s.error ? 'Error' : 'Output'}</div>
      <pre className="code output">{s.text}</pre>
    </div>
  );
}

export function Thread({ messages }: { messages: Message[] }) {
  return (
    <div className="thread">
      {group(messages).map((item, i) => {
        if (item.type === 'steps') {
          const errored = item.steps.some((s) => s.kind === 'result' && s.error);
          return (
            <details key={i} className={`steps-group${errored ? ' has-error' : ''}`}>
              <summary>{summary(item.steps)}</summary>
              <div className="steps-body">
                {item.steps.map((s, j) => (
                  <Step key={j} s={s} />
                ))}
              </div>
            </details>
          );
        }
        const { m } = item;
        if (m.kind === 'divider') return <div key={i} className="divider"><span>{m.text}</span></div>;
        return (
          <div key={i} className={`bubble-row ${m.kind}`}>
            <div className="bubble">
              <div className="bubble-meta">
                {m.kind === 'user' ? (m.from ? `${m.from} · via mailbox` : 'Prompt') : 'Agent'}
                {m.at && <span>{time(m.at)}</span>}
              </div>
              {m.subject && <div className="bubble-subject">{m.subject}</div>}
              {m.kind === 'user' ? (
                (() => {
                  const { paths, unseen, rest } = splitImages(m.text);
                  return (
                    <>
                      <Images paths={paths} unseen={unseen} />
                      {rest && <Markdown text={rest} />}
                    </>
                  );
                })()
              ) : (
                <Markdown text={m.text} />
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
