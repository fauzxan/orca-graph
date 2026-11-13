// Pictures sent from the side pane. Each is saved as a file in the system temp folder, and the
// prompt carries its path the same way Orca's own paste does: "[Image: source: <path>]". The agent
// opens the file from that path.
import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 6;
const TMP = tmpdir();

// Detected from the file's first bytes, never from what the browser claims.
const SIGNATURES = [
  { ext: 'png', type: 'image/png', test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: 'jpg', type: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { ext: 'gif', type: 'image/gif', test: (b) => /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1')) },
  { ext: 'webp', type: 'image/webp', test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];
const TYPE_BY_EXT = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// Files this app may show: its own uploads and Orca's pasted screenshots, directly in the temp folder.
const SHOWABLE = /^(orca-graph-image|orca-paste)-[\w-]+\.(png|jpe?g|gif|webp)$/i;
const OWN = /^orca-graph-image-[\w-]+\.(png|jpg|gif|webp)$/;

export async function saveImage(base64) {
  if (typeof base64 !== 'string' || !base64) return { ok: false, error: 'No image data.' };
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_IMAGE_BYTES) return { ok: false, error: `Image is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB.` };
  const kind = SIGNATURES.find((s) => s.test(bytes));
  if (!kind) return { ok: false, error: 'Only PNG, JPEG, GIF and WebP images can be sent.' };
  const path = join(TMP, `orca-graph-image-${Date.now()}-${randomUUID()}.${kind.ext}`);
  await writeFile(path, bytes, { mode: 0o600 });
  return { ok: true, path };
}

// Only paths this server created can be attached to a message.
export async function isOwnImage(path) {
  if (typeof path !== 'string' || dirname(path) !== TMP || !OWN.test(basename(path))) return false;
  return stat(path).then((s) => s.isFile()).catch(() => false);
}

export async function readShowable(path) {
  const name = basename(path || '');
  if (dirname(path || '') !== TMP || !SHOWABLE.test(name)) return null;
  const body = await readFile(path).catch(() => null);
  if (!body) return null;
  return { body, type: TYPE_BY_EXT[name.split('.').pop().toLowerCase()] };
}

export const imageLine = (path) => `[Image: source: ${path}]`;
