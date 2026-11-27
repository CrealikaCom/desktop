// Catalog of available services: what can be installed and from where.
// Release catalogs list the released services: the built-in one, which comes with the app, and the
// fresh one read from GitHub (remote-catalog.js). Their entries are release archives pinned to a
// version, and of two entries for one service the newer version wins. The user's catalog
// (<home>/config/catalog.json) comes last: an entry with the same id replaces the released one,
// e.g. to install from a local checkout.
import fs from 'node:fs/promises';
import path from 'node:path';
import { ID_RE } from './manifest.js';

const SHA256_RE = /^[0-9a-f]{64}$/;
const REF_RE = /^[A-Za-z0-9._\/-]{1,200}$/;
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

// The only archives a release catalog may point to: a GitHub release of the service's repository.
export function releaseArchiveUrl(id, version) {
  return `https://github.com/CrealikaCom/desktop-${id}/releases/download/v${version}/${id}-${version}.tar.gz`;
}

export async function loadCatalog(file, { release = false } = {}) {
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
  }).map((e) => {
    if (release && (!e.version || e.source.type !== 'archive' || e.source.url !== releaseArchiveUrl(e.id, e.version))) {
      throw new Error(`${file}: ${e.id}: a release catalog entry must be the release archive of its version`);
    }
    return { ...e, released: release };
  });
}

// Files in order: paths, or {path, release: true} for release catalogs. Missing files are skipped.
// A later entry replaces an earlier one by id, except that between two release entries the newer
// version stays.
export async function loadCatalogs(files) {
  const byId = new Map();
  for (const item of files) {
    const { path: file, release = false } = typeof item === 'string' ? { path: item } : item;
    let entries;
    try {
      entries = await loadCatalog(file, { release });
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for (const e of entries) {
      const prev = byId.get(e.id);
      if (e.released && prev?.released && compareVersions(prev.version, e.version) >= 0) continue;
      byId.set(e.id, e);
    }
  }
  return [...byId.values()];
}

// Compares x.y.z versions with an optional -pre-release, which comes before its release:
// negative when a is older than b, 0 when equal, positive when newer. Other strings compare as text.
export function compareVersions(a, b) {
  const parse = (v) => /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(v);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return a === b ? 0 : a < b ? -1 : 1;
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i]);
    if (d) return Math.sign(d);
  }
  if (pa[4] === pb[4]) return 0;
  if (!pa[4]) return 1;
  if (!pb[4]) return -1;
  return pa[4] < pb[4] ? -1 : 1;
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
