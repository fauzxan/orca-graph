// Skills a session can use: <dir>/.claude/skills/<name>/SKILL.md for its folder and every parent
// folder, plus your personal ~/.claude/skills. Sibling folders are never searched.
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

const HOME = homedir();
const PERSONAL = join(HOME, '.claude', 'skills');
const TTL_MS = 10_000;

// Just enough YAML for SKILL.md frontmatter: `key: value`, quoted values, and `>`/`|` blocks.
function frontmatter(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  if (lines[0].trim() !== '---') return {};
  const out = {};
  for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
    const m = lines[i].match(/^([\w-]+):\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const block = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) block.push(lines[++i].trim());
      value = block.join(' ');
    } else if (/^(["']).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value.replace(/\s+/g, ' ').trim();
  }
  return out;
}

// No frontmatter description: use the first line of prose, like Claude Code does.
function firstParagraph(text) {
  const body = text.replace(/\r/g, '').replace(/^---\n[\s\S]*?\n---\n?/, '');
  return body.split('\n').map((l) => l.trim()).find((l) => l && !l.startsWith('#') && !l.startsWith('```')) || '';
}

async function skillsIn(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const file = join(dir, e.name, 'SKILL.md');
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text == null) continue;
    const meta = frontmatter(text);
    if (meta['user-invocable'] === 'false') continue;
    out.push({ name: meta.name || e.name, description: meta.description || firstParagraph(text), file });
  }
  return out;
}

// Folders to search, nearest first: the session folder, then each parent up to /.
function lineage(path) {
  const dirs = [];
  for (let d = path; d && !dirs.includes(d); d = dirname(d)) dirs.push(d);
  return dirs;
}

const cache = new Map();

export async function skillsFor(path) {
  const key = path || '';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.skills;

  // Claude Code's precedence when names clash: personal first, then the nearest project folder.
  const sources = [{ dir: PERSONAL, label: 'Personal' }];
  for (const d of path ? lineage(path) : []) {
    const dir = join(d, '.claude', 'skills');
    if (dir === PERSONAL) continue;
    const isDir = await stat(dir).then((s) => s.isDirectory()).catch(() => false);
    if (isDir) sources.push({ dir, label: d === HOME ? 'Home' : basename(d) });
  }

  const byName = new Map();
  for (const { dir, label } of sources) {
    for (const s of await skillsIn(dir)) {
      if (!byName.has(s.name)) byName.set(s.name, { name: s.name, description: s.description, source: label, path: dir });
    }
  }
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  cache.set(key, { at: Date.now(), skills });
  return skills;
}
