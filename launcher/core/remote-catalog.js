// The fresh catalog of released services: catalog.json on the main branch of the launcher's own
// repository, read so that a new service version reaches users without a launcher release. It is saved in the cache only after it checks out as a release
// catalog; without the network the saved one and the built-in catalog are used.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCatalog } from './catalog.js';

export const REMOTE_CATALOG_URL = 'https://raw.githubusercontent.com/CrealikaCom/desktop/main/catalog.json';
const MAX_BYTES = 1024 * 1024;

// CREALIKA_DESKTOP_CATALOG_URL points to another catalog (a file: URL too); "off" turns it off.
export function remoteCatalogUrl(env = process.env) {
  const value = env.CREALIKA_DESKTOP_CATALOG_URL;
  if (value === 'off') return null;
  return value || REMOTE_CATALOG_URL;
}

export function remoteCatalogFile(lay) {
  return path.join(lay.cache, 'catalog.json');
}

export async function refreshCatalog(lay, { url, fetchImpl = fetch, timeoutMs = 15000 }) {
  let text;
  if (url.startsWith('file:')) {
    text = await fs.readFile(fileURLToPath(url), 'utf8');
  } else {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`catalog ${url}: HTTP ${res.status}`);
    text = await res.text();
  }
  if (text.length > MAX_BYTES) throw new Error(`catalog ${url}: too large`);
  const file = remoteCatalogFile(lay);
  const next = `${file}.new`;
  await fs.writeFile(next, text);
  try {
    await loadCatalog(next, { release: true });
  } catch (err) {
    await fs.rm(next, { force: true });
    throw err;
  }
  await fs.rename(next, file);
}
