// Service manifest: crealika-service.json in the service root.
import fs from 'node:fs/promises';
import path from 'node:path';

export const MANIFEST = 'crealika-service.json';
export const ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
const RUNTIMES = new Set(['node']);

export function validateManifest(m) {
  if (!m || typeof m !== 'object') throw new Error('manifest: expected an object');
  if (!ID_RE.test(m.id ?? '')) throw new Error(`manifest: invalid id ${JSON.stringify(m.id)}`);
  const where = `manifest ${m.id}`;
  if (typeof m.name !== 'string' || !m.name) throw new Error(`${where}: missing name`);
  if (typeof m.version !== 'string' || !m.version) throw new Error(`${where}: missing version`);
  if (!RUNTIMES.has(m.runtime)) throw new Error(`${where}: unsupported runtime ${JSON.stringify(m.runtime)}`);
  if (typeof m.entry !== 'string' || !isInside(m.entry)) throw new Error(`${where}: entry must be a path inside the service`);
  const engines = m.engines ?? [];
  if (!Array.isArray(engines) || !engines.every((e) => typeof e === 'string')) {
    throw new Error(`${where}: engines must be a list of strings`);
  }
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    description: typeof m.description === 'string' ? m.description : '',
    runtime: m.runtime,
    entry: m.entry,
    engines,
  };
}

export async function readManifest(dir) {
  const raw = await fs.readFile(path.join(dir, MANIFEST), 'utf8');
  return validateManifest(JSON.parse(raw));
}

function isInside(rel) {
  if (!rel || path.isAbsolute(rel) || path.win32.isAbsolute(rel)) return false;
  const norm = path.posix.normalize(rel.replaceAll('\\', '/'));
  return norm !== '..' && !norm.startsWith('../');
}
