// Shared formatting for tool calls and results in the side-pane thread.
const TOOL_PREVIEW = 4000;

export const clip = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2);
  return text.length > TOOL_PREVIEW ? `${text.slice(0, TOOL_PREVIEW)}\n… (truncated)` : text;
};

export function toolInput(input) {
  if (!input || typeof input !== 'object') return clip(input);
  return clip(input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.prompt ?? input);
}
