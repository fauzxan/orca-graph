import type { CleanupMode, SessionDetail } from './types';

export type ActionResult = {
  ok: boolean;
  error?: string;
  via?: 'prompt' | 'mailbox';
  note?: string;
  steps?: { step: string; ok: boolean; detail: string }[];
};

// The server only accepts actions carrying this header, which cross-site pages cannot send.
async function post(path: string, body: unknown): Promise<ActionResult> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-orca-graph': '1' },
      body: JSON.stringify(body),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, error: `Can't reach the orca-graph server: ${String(e)}` };
  }
}

export const cleanup = (id: string, mode: CleanupMode) => post('/api/cleanup', { id, mode });
export const send = (id: string, text: string) => post('/api/send', { id, text });

export async function session(id: string): Promise<SessionDetail> {
  const res = await fetch(`/api/session?id=${encodeURIComponent(id)}`, { cache: 'no-store' });
  return res.json();
}
