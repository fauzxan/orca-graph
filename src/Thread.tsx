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
                {m.kind === 'user' ? 'Prompt' : 'Agent'}
                {m.at && <span>{time(m.at)}</span>}
              </div>
              <Markdown text={m.text} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
