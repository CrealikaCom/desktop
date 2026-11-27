// Catalog of available services: what can be installed and from where.
// The built-in catalog, which comes with the app and lists the released services, is extended by
// the user's one (<home>/config/catalog.json): an entry with the same id replaces the built-in
// one, e.g. to install from a local checkout.
import fs from 'node:fs/promises';
import path from 'node:path';
import { ID_RE } from './manifest.js';

const SHA256_RE = /^[0-9a-f]{64}$/;
const REF_RE = /^[A-Za-z0-9._\/-]{1,200}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

export async function loadCatalog(file) {
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(raw.services)) throw new Error(`${file}: missing services list`);
  const base = path.dirname(file);
  const seen = new Set();
  return raw.services.map((s) => {
    if (!ID_RE.test(s.id ?? '')) throw new Error(`${file}: invalid id ${JSON.stringify(s.id)}`);
    if (seen.has(s.id)) throw new Error(`${file}: duplicate id ${s.id}`);
    seen.add(s.id);
    if (s.version !== undefined && !VERSION_RE.test(String(s.version))) throw new Error(`${file}: ${s.id}: invalid version ${JSON.stringify(s.version)}`);
    return {
      id: s.id,
      name: typeof s.name === 'string' && s.name ? s.name : s.id,
      description: typeof s.description === 'string' ? s.description : '',
      // The version the source holds: a release archive is pinned to one, a checkout is not.
      version: s.version ?? null,
      source: parseSource(s.source, base, `${file}: ${s.id}`),
      origin: file,
    };
  });
}

// Files in order; missing ones are skipped, later entries replace earlier ones by id.
export async function loadCatalogs(files) {
  const byId = new Map();
  for (const file of files) {
    let entries;
    try {
      entries = await loadCatalog(file);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for (const e of entries) byId.set(e.id, e);
  }
  return [...byId.values()];
}

function parseSource(src, base, where) {
  if (src?.type === 'dir' && typeof src.path === 'string') {
    return { type: 'dir', path: path.resolve(base, src.path) };
  }
  if (src?.type === 'git' && typeof src.url === 'string' && src.url) {
    const ref = src.ref ?? 'main';
    if (!REF_RE.test(ref) || ref.startsWith('-')) throw new Error(`${where}: invalid ref ${JSON.stringify(ref)}`);
    // A local repository path is relative to the catalog file; URLs (ssh://, https://, git@host:) are kept.
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(src.url) || /^[\w.-]+@[\w.-]+:/.test(src.url)
      ? src.url
      : path.resolve(base, src.url);
    if (url.startsWith('-')) throw new Error(`${where}: invalid url`);
    return { type: 'git', url, ref };
  }
  if (src?.type === 'archive' && typeof src.url === 'string') {
    const url = new URL(src.url, `file://${base.replaceAll('\\', '/')}/`);
    if (!['https:', 'http:', 'file:'].includes(url.protocol)) throw new Error(`${where}: unsupported protocol ${url.protocol}`);
    if (!SHA256_RE.test(src.sha256 ?? '')) throw new Error(`${where}: archive source requires sha256`);
    return { type: 'archive', url: url.href, sha256: src.sha256 };
  }
  throw new Error(`${where}: source must be {type:"git",url,ref}, {type:"archive",url,sha256} or {type:"dir",path}`);
}
