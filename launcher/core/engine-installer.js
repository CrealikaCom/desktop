// Installs a prebuilt engine into engines/<id>/. Every archive of the build is downloaded into
// cache/ with its sha256 checked while streaming, unpacked and merged into one folder, which then
// replaces the installed engine. engines/<id>/crealika-engine.json records what is installed.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENGINE_MARKER = 'crealika-engine.json';

/**
 * onProgress({ received, total }) is called while downloading; total is the sum of the
 * catalog sizes (null when unknown).
 */
export async function installEngine(engine, build, lay, { fetchImpl = fetch, onProgress = () => {}, platform = process.platform } = {}) {
  const staging = await fs.mkdtemp(path.join(lay.cache, `engine-${engine.id}-`));
  try {
    const total = build.files.every((f) => f.size) ? build.files.reduce((sum, f) => sum + f.size, 0) : null;
    let done = 0;
    const pkg = path.join(staging, 'pkg');
    await fs.mkdir(pkg);
    for (const [i, file] of build.files.entries()) {
      const name = path.posix.basename(new URL(file.url).pathname);
      const archive = path.join(staging, `${i}-${name}`);
      const received = await download(file, archive, fetchImpl, (n) => onProgress({ received: done + n, total }));
      done += received;
      const unpacked = path.join(staging, `unpacked-${i}`);
      await fs.mkdir(unpacked);
      await unpack(archive, unpacked, platform);
      await fs.rm(archive, { force: true });
      await fs.cp(await contentRoot(unpacked), pkg, { recursive: true, force: true, verbatimSymlinks: true });
      await fs.rm(unpacked, { recursive: true, force: true });
    }
    const exe = platform === 'win32' ? `${engine.server}.exe` : engine.server;
    const server = await findFile(pkg, exe);
    if (!server) throw new Error(`${engine.id}: ${exe} not found in the downloaded build`);
    const marker = {
      id: engine.id,
      version: engine.version,
      os: build.os,
      arch: build.arch,
      accel: build.accel,
      server: path.relative(pkg, server).split(path.sep).join('/'),
      sha256: build.files.map((f) => f.sha256),
      installedAt: new Date().toISOString(),
    };
    await fs.writeFile(path.join(pkg, ENGINE_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
    await replaceDir(pkg, path.join(lay.engines, engine.id));
    // The user puts models here before the engine first starts.
    await fs.mkdir(path.join(lay.models, engine.models), { recursive: true });
    return marker;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

export async function uninstallEngine(id, lay) {
  await fs.rm(path.join(lay.engines, id), { recursive: true, force: true });
}

export async function readInstalledEngine(lay, id) {
  try {
    const m = JSON.parse(await fs.readFile(path.join(lay.engines, id, ENGINE_MARKER), 'utf8'));
    return m && m.id === id && typeof m.server === 'string' ? m : null;
  } catch {
    return null;
  }
}

// Absolute path of the server executable of an installed engine.
export function serverPath(lay, marker) {
  const file = path.resolve(lay.engines, marker.id, ...marker.server.split('/'));
  if (!file.startsWith(path.join(lay.engines, marker.id) + path.sep)) throw new Error(`${marker.id}: invalid server path`);
  return file;
}

async function download(file, dest, fetchImpl, onBytes) {
  const hash = createHash('sha256');
  const out = createWriteStream(dest, { mode: 0o600 });
  let received = 0;
  const write = (chunk) => {
    hash.update(chunk);
    received += chunk.length;
    onBytes(received);
    return out.write(chunk) ? null : new Promise((resolve) => out.once('drain', resolve));
  };
  try {
    if (file.url.startsWith('file:')) {
      for await (const chunk of createReadStream(fileURLToPath(file.url))) await write(chunk);
    } else {
      const res = await fetchImpl(file.url, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`download ${file.url}: HTTP ${res.status}`);
      for await (const chunk of res.body) await write(Buffer.from(chunk));
    }
  } finally {
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  }
  const actual = hash.digest('hex');
  if (actual !== file.sha256) throw new Error(`${path.basename(dest)}: sha256 ${actual} does not match the catalog`);
  return received;
}

// tar ships with Linux, macOS and Windows 10+ and refuses paths with ..; on Windows and macOS it
// is bsdtar and also reads .zip. GNU tar on Linux does not, so .zip goes through unzip there.
function unpack(archive, dest, platform) {
  if (/\.(tar\.gz|tgz)$/.test(archive)) return run('tar', ['-xzf', archive, '-C', dest]);
  if (platform === 'linux') return run('unzip', ['-q', '-o', archive, '-d', dest]);
  return run('tar', ['-xf', archive, '-C', dest]);
}

// Archives keep their files either at the root or in one top-level folder.
async function contentRoot(dir) {
  const items = await fs.readdir(dir, { withFileTypes: true });
  return items.length === 1 && items[0].isDirectory() ? path.join(dir, items[0].name) : dir;
}

async function findFile(dir, name, depth = 3) {
  const items = await fs.readdir(dir, { withFileTypes: true });
  const hit = items.find((d) => d.isFile() && d.name === name);
  if (hit) return path.join(dir, hit.name);
  if (depth === 0) return null;
  for (const d of items) {
    if (!d.isDirectory()) continue;
    const found = await findFile(path.join(dir, d.name), name, depth - 1);
    if (found) return found;
  }
  return null;
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

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr.on('data', (c) => (err += c));
    child.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(`program not found: ${cmd}`) : e));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd}: exit code ${code}: ${err.trim()}`))));
  });
}
