// Serves the API and, outside dev mode, the built frontend from dist/.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectGraph } from './orca.mjs';
import { MODES, cleanupSession } from './cleanup.mjs';
import { MAX_IMAGE_BYTES, MAX_IMAGES, isOwnImage, readShowable, saveImage } from './images.mjs';
import { sessionIndex } from './orca.mjs';
import { sendMessage, sessionDetail } from './session.mjs';
import { skillsFor } from './skills.mjs';

const PORT = Number(process.env.PORT || 4317);
const HOST = '127.0.0.1';
const DEV = process.argv.includes('--dev');
const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const MAX_BODY = 64 * 1024;
// Base64 is 4/3 the size of the image, plus room for the JSON around it.
const MAX_IMAGE_BODY = Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4096;

// Polls from several tabs share one in-flight orca collection.
let inFlight = null;
let last = null;

async function graph() {
  if (!inFlight) {
    inFlight = collectGraph()
      .then((g) => (last = g))
      .catch((e) => ({ ...(last || { nodes: [], edges: [] }), errors: [String(e)] }))
      .finally(() => (inFlight = null));
  }
  return inFlight;
}

// orca-graph.xyz is the local name served by ~/personal/local-proxy (/etc/hosts -> 127.0.0.1).
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|orca-graph\.xyz)(:\d+)?$/;

// Actions change real agents and files, so only this app's own pages may call them:
// a local Host header (blocks DNS rebinding), a local or absent Origin, and a custom header
// that cross-site forms and simple requests cannot set.
function trustedAction(req) {
  if (!LOCAL_HOST.test(req.headers.host || '')) return false;
  const origin = req.headers.origin;
  if (origin && !LOCAL_HOST.test(origin.replace(/^https?:\/\//, ''))) return false;
  return req.headers['x-orca-graph'] === '1' && (req.headers['content-type'] || '').startsWith('application/json');
}

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) reject(new Error('Body too large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serveStatic(url, res) {
  const path = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '');
  try {
    const body = await readFile(join(DIST, path));
    res.writeHead(200, { 'content-type': TYPES[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    const body = await readFile(join(DIST, 'index.html')).catch(() => null);
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' });
    res.end(body || 'Run `npm run build` first.');
  }
}

async function handleAction(req, res, url) {
  if (!trustedAction(req)) return json(res, 403, { ok: false, error: 'Forbidden' });
  let body;
  try {
    body = await readJson(req, url === '/api/image' ? MAX_IMAGE_BODY : MAX_BODY);
  } catch (e) {
    return json(res, 400, { ok: false, error: String(e.message || e) });
  }
  if (url === '/api/image') {
    const result = await saveImage(body.data);
    return json(res, result.ok ? 200 : 400, result);
  }
  if (typeof body.id !== 'string') return json(res, 400, { ok: false, error: 'Missing session id' });

  if (url === '/api/cleanup') {
    if (!MODES.includes(body.mode)) return json(res, 400, { ok: false, error: 'Unknown cleanup mode' });
    const result = await cleanupSession(body.id, body.mode);
    last = null;
    return json(res, result.ok ? 200 : 409, result);
  }
  if (url === '/api/send') {
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const images = Array.isArray(body.images) ? body.images : [];
    if (!text && !images.length) return json(res, 400, { ok: false, error: 'Message is empty' });
    if (images.length > MAX_IMAGES) return json(res, 400, { ok: false, error: `Send at most ${MAX_IMAGES} images at a time.` });
    for (const path of images) {
      if (!(await isOwnImage(path))) return json(res, 400, { ok: false, error: 'An attached image is missing. Attach it again.' });
    }
    const result = await sendMessage(body.id, text, images);
    return json(res, result.ok ? 200 : 409, result);
  }
  return json(res, 404, { ok: false, error: 'Not found' });
}

createServer(async (req, res) => {
  const { pathname: url, searchParams } = new URL(req.url, `http://${HOST}`);
  if (req.method === 'POST' && url.startsWith('/api/')) return handleAction(req, res, url);
  if (url === '/api/graph') return json(res, 200, await graph());
  if (url === '/api/skills' || url === '/api/image') {
    if (!LOCAL_HOST.test(req.headers.host || '')) return json(res, 403, { ok: false, error: 'Forbidden' });
  }
  if (url === '/api/skills') {
    // The folder comes from the server's own session record, never from the browser.
    const s = sessionIndex.get(searchParams.get('id') || '');
    return json(res, 200, { ok: true, skills: await skillsFor(s?.path || '') });
  }
  if (url === '/api/image') {
    const image = await readShowable(searchParams.get('path') || '');
    if (!image) return json(res, 404, { ok: false, error: 'Not found' });
    res.writeHead(200, { 'content-type': image.type, 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' });
    return res.end(image.body);
  }
  if (url === '/api/session') {
    if (!LOCAL_HOST.test(req.headers.host || '')) return json(res, 403, { ok: false, error: 'Forbidden' });
    const id = searchParams.get('id') || '';
    let detail = await sessionDetail(id);
    // Right after a restart the session list is still empty: wait for one collection, then retry.
    if (!detail.ok && (!last || inFlight)) {
      await graph();
      detail = await sessionDetail(id);
    }
    return json(res, 200, detail);
  }
  if (DEV) {
    res.writeHead(404);
    return res.end();
  }
  return serveStatic(url, res);
}).listen(PORT, HOST, () => {
  console.log(`orca-graph API on http://${HOST}:${PORT}/api/graph${DEV ? '' : `\nUI on http://${HOST}:${PORT}`}`);
});
