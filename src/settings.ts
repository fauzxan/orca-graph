import { useCallback, useState } from 'react';

const POLL_KEY = 'orca-graph.poll-seconds';
export const DEFAULT_POLL_SECONDS = 5;
export const MIN_POLL_SECONDS = 1;
export const MAX_POLL_SECONDS = 3600;

// Returns an error message, or null when the input is a valid number of seconds.
export function validatePollSeconds(raw: string): string | null {
  const text = raw.trim();
  if (!text) return 'Enter a number of seconds.';
  if (!/^\d+(\.\d+)?$/.test(text)) return 'Use a number, like 5 or 2.5.';
  const n = Number(text);
  if (n < MIN_POLL_SECONDS) return `Minimum is ${MIN_POLL_SECONDS}s.`;
  if (n > MAX_POLL_SECONDS) return `Maximum is ${MAX_POLL_SECONDS}s.`;
  return null;
}

function load(): number {
  try {
    const raw = localStorage.getItem(POLL_KEY);
    if (raw && !validatePollSeconds(raw)) return Number(raw);
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_POLL_SECONDS;
}

export function usePollSeconds() {
  const [seconds, setSeconds] = useState(load);
  const update = useCallback((next: number) => {
    setSeconds(next);
    try {
      localStorage.setItem(POLL_KEY, String(next));
    } catch {
      /* storage unavailable: the setting just won't be remembered */
    }
  }, []);
  return [seconds, update] as const;
}
