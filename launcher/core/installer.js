// Installs services into services/<id> from a git repository, a .tar.gz archive verified
// by sha256, or a copied directory.
// The package is assembled in a temporary directory under cache/ and only then replaces
// the previous version, so a failed install never breaks the installed service.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANIFEST, readManifest } from './manifest.js';

export async function install(entry, lay, { fetchImpl = fetch } = {}) {
  const staging = await fs.mkdtemp(path.join(lay.cache, `install-${entry.id}-`));
  try {
    let pkg;
    if (entry.source.type === 'dir') {
      pkg = path.join(staging, 'pkg');
      await fs.cp(entry.source.path, pkg, {
        recursive: true,
        filter: (src) => path.basename(src) !== '.git',
      });
    } else if (entry.source.type === 'git') {
      pkg = path.join(staging, 'pkg');
      await run('git', ['clone', '--quiet', '--depth', '1', '--branch', entry.source.ref, '--', entry.source.url, pkg], {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
      });
      await fs.rm(path.join(pkg, '.git'), { recursive: true, force: true });
    } else {
      pkg = await unpackArchive(entry.source, staging, fetchImpl);
    }
    const manifest = await readManifest(pkg);
    if (manifest.id !== entry.id) throw new Error(`the package contains service ${manifest.id}, expected ${entry.id}`);
    if (entry.version && manifest.version !== entry.version) {
      throw new Error(`the package contains ${entry.id} ${manifest.version}, the catalog says ${entry.version}`);
    }
    await replaceDir(pkg, path.join(lay.services, entry.id));
    return manifest;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

// Removes only the service code; the user's data/ and output/ stay.
export async function uninstall(id, lay) {
  await fs.rm(path.join(lay.services, id), { recursive: true, force: true });
}

export async function listInstalled(lay) {
  const out = new Map();
  for (const d of await fs.readdir(lay.services, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.includes('.')) continue;
    try {
      out.set(d.name, await readManifest(path.join(lay.services, d.name)));
    } catch (err) {
      out.set(d.name, { id: d.name, broken: String(err.message ?? err) });
    }
  }
  return out;
}

async function replaceDir(src, target) {
  const old = `${target}.old-${Date.now()}`;
  let hadOld = false;
  try {
    await fs.rename(target, old);
    hadOld = true;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  try {
    await fs.rename(src, target);
  } catch (err) {
    if (hadOld) await fs.rename(old, target);
    throw err;
  }
  if (hadOld) await fs.rm(old, { recursive: true, force: true });
}

async function unpackArchive(source, staging, fetchImpl) {
  const file = path.join(staging, 'package.tar.gz');
  const bytes = await download(source.url, fetchImpl);
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== source.sha256) throw new Error(`archive sha256 ${actual} does not match the catalog`);
  await fs.writeFile(file, bytes);
  const dest = path.join(staging, 'unpacked');
  await fs.mkdir(dest);
  // tar ships with Linux, macOS and Windows 10+ (bsdtar); it refuses paths with ..
  await run('tar', ['-xzf', file, '-C', dest]);
  // The package is either at the archive root or in its single top-level directory.
  try {
    await fs.access(path.join(dest, MANIFEST));
    return dest;
  } catch {
    const items = await fs.readdir(dest, { withFileTypes: true });
    if (items.length === 1 && items[0].isDirectory()) return path.join(dest, items[0].name);
    throw new Error(`${MANIFEST} not found in the archive`);
  }
}

async function download(url, fetchImpl) {
  if (url.startsWith('file:')) return fs.readFile(fileURLToPath(url));
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function run(cmd, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env });
    let err = '';
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(`program not found: ${cmd}`) : e));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd}: exit code ${code}: ${err.trim()}`))));
  });
}
