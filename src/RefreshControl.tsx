import { useEffect, useState } from 'react';
import { DEFAULT_POLL_SECONDS, MIN_POLL_SECONDS, validatePollSeconds } from './settings';

// "every [5] s" in the header. Applies on Enter or blur; invalid input shows why and isn't applied.
export function RefreshControl({ seconds, onChange }: { seconds: number; onChange: (s: number) => void }) {
  const [text, setText] = useState(String(seconds));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setText(String(seconds)), [seconds]);

  const apply = () => {
    const problem = validatePollSeconds(text);
    setError(problem);
    if (!problem) {
      const next = Number(text.trim());
      setText(String(next));
      if (next !== seconds) onChange(next);
    }
  };

  return (
    <label className={`refresh${error ? ' invalid' : ''}`} title={error ?? `Refresh interval in seconds (min ${MIN_POLL_SECONDS}s)`}>
      every
      <input
        type="text"
        inputMode="decimal"
        value={text}
        aria-label="Refresh interval in seconds"
        aria-invalid={Boolean(error)}
        onChange={(e) => {
          setText(e.target.value);
          setError(validatePollSeconds(e.target.value));
        }}
        onBlur={apply}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setText(String(seconds));
            setError(null);
          }
        }}
      />
      s
      {seconds !== DEFAULT_POLL_SECONDS && !error && (
        <button type="button" className="link small" onClick={() => onChange(DEFAULT_POLL_SECONDS)}>
          reset
        </button>
      )}
      {error && <span className="refresh-error">{error}</span>}
    </label>
  );
}
