// Shared engine processes. An engine is started on demand by a service host, detached from it,
// and shared by every service that asks for it. Most engines load models on request and run as
// one process; an engine whose args take {model} loads one model at start and runs one process
// per model file (an instance). run/engines/<instance>.json records the address, API key and the
// leases of the hosts using it; the key is also written to run/engines/<instance>.key for engines
// that read it from a file. All changes happen under run/engines/<instance>.lock, as the launcher
// and every service host are separate processes. The last host to release an instance stops it;
// leases of hosts that died are dropped by the next acquire, release or reap.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { withFileLock } from './file-lock.js';
import { readInstalledEngine, serverPath } from './engine-installer.js';

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// <engine id> or <engine id>.<12 hex digits of the model path hash>
const INSTANCE_RE = /^[a-z][a-z0-9-]{1,31}(\.[0-9a-f]{12})?$/;
const dir = (lay) => path.join(lay.run, 'engines');
const regFile = (lay, key) => path.join(dir(lay), `${key}.json`);
const keyFile = (lay, key) => path.join(dir(lay), `${key}.key`);
const lockFile = (lay, key) => path.join(dir(lay), `${key}.lock`);

/**
 * The instance an acquire refers to: { key, model } where model is the model file relative to
 * the engine's models folder (null for engines that load models on request).
 */
export async function engineInstance(lay, engine, model, { mustExist = true } = {}) {
  if (!engine.perModel) return { key: engine.id, model: null };
  if (typeof model !== 'string' || !model.trim()) {
    throw new EngineError('model_required', `${engine.name} needs a model file from ${path.join(lay.models, engine.models)}`);
  }
  const rel = path.posix.normalize(model.trim().replaceAll('\\', '/'));
  if (rel.length > 255 || rel.includes('\0') || path.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel === '..' || rel.startsWith('../')) {
    throw new EngineError('model_not_found', `model must be a file inside ${path.join(lay.models, engine.models)}`);
  }
  const file = modelPath(lay, engine, rel);
  const stat = mustExist ? await fs.stat(file).catch(() => null) : null;
  if (mustExist && !stat?.isFile()) throw new EngineError('model_not_found', `model ${rel} not found in ${path.join(lay.models, engine.models)}`);
  const hash = createHash('sha256').update(rel).digest('hex').slice(0, 12);
  return { key: `${engine.id}.${hash}`, model: rel };
}

function modelPath(lay, engine, rel) {
  const root = path.join(lay.models, engine.models);
  const file = path.join(root, ...rel.split('/'));
  if (!file.startsWith(root + path.sep)) throw new EngineError('model_not_found', `model must be inside ${root}`);
  return file;
}

/**
 * Starts the engine (or its instance for the given model) or joins the running one.
 * holder: { pid, service } of the asking host.
 * Returns { id, instance, model, url, apiKey, version, accel, models }.
 * launch(file, args, options) replaces child_process.spawn in tests.
 */
export async function acquireEngine(lay, engine, holder, { model = null, readyTimeoutMs = 60000, launch = spawn } = {}) {
  await fs.mkdir(dir(lay), { recursive: true });
  const inst = await engineInstance(lay, engine, model);
  return withEngineLock(lay, inst.key, async () => {
    let reg = await readReg(lay, inst.key);
    if (reg && !(await healthy(reg, engine))) {
      // Dead or unresponsive: forget it (a hung process is stopped first).
      if (isAlive(reg.pid)) await stopProcess(reg.pid);
      await forget(lay, inst.key);
      reg = null;
    }
    if (!reg) reg = await startEngine(lay, engine, inst, { readyTimeoutMs, launch });
    reg.leases = reg.leases.filter((l) => isAlive(l.pid) && !(l.pid === holder.pid && l.service === holder.service));
    reg.leases.push({ pid: holder.pid, service: holder.service, at: new Date().toISOString() });
    await writeReg(lay, reg);
    return publicInfo(lay, engine, reg);
  });
}

// Drops the lease of this host on one instance; the instance stops when no lease is left.
export async function releaseEngine(lay, key, holder) {
  if (!INSTANCE_RE.test(key) || !(await exists(regFile(lay, key)))) return;
  await withEngineLock(lay, key, async () => {
    const reg = await readReg(lay, key);
    if (!reg) return;
    reg.leases = reg.leases.filter((l) => isAlive(l.pid) && !(l.pid === holder.pid && (!holder.service || l.service === holder.service)));
    await settle(lay, reg);
  });
}

// Instances of an engine that have a lease of this holder.
export async function heldInstances(lay, engineId, holder) {
  const out = [];
  for (const key of await registeredKeys(lay)) {
    const reg = await readReg(lay, key);
    if (reg && engineOf(reg) === engineId && reg.leases.some((l) => l.pid === holder.pid && (!holder.service || l.service === holder.service))) {
      out.push(key);
    }
  }
  return out;
}

// Called by the launcher on its timer: stops engines whose hosts all died, forgets dead engines.
export async function reapEngines(lay) {
  for (const key of await registeredKeys(lay)) {
    await withEngineLock(lay, key, async () => {
      const reg = await readReg(lay, key);
      if (!reg) return;
      if (!isAlive(reg.pid)) {
        await forget(lay, key);
        return;
      }
      reg.leases = reg.leases.filter((l) => isAlive(l.pid));
      await settle(lay, reg);
    }).catch(() => {});
  }
}

/**
 * Running engines by engine id, without their API keys:
 * { id, pid, url, version, accel, services, startedAt, instances: [{ model, pid, url, services }] }.
 * pid, url and startedAt are those of the first instance.
 */
export async function listRunningEngines(lay) {
  const out = new Map();
  for (const key of await registeredKeys(lay)) {
    const reg = await readReg(lay, key);
    if (!reg || !isAlive(reg.pid)) continue;
    const id = engineOf(reg);
    const services = [...new Set(reg.leases.filter((l) => isAlive(l.pid)).map((l) => l.service))];
    let entry = out.get(id);
    if (!entry) {
      entry = { id, pid: reg.pid, url: reg.url, version: reg.version, accel: reg.accel, services: [], startedAt: reg.startedAt, instances: [] };
      out.set(id, entry);
    }
    entry.instances.push({ model: reg.model ?? null, pid: reg.pid, url: reg.url, services });
    entry.services = [...new Set([...entry.services, ...services])];
  }
  return out;
}

const engineOf = (reg) => reg.engine ?? reg.id;

async function settle(lay, reg) {
  if (reg.leases.length) {
    await writeReg(lay, reg);
    return;
  }
  await stopProcess(reg.pid);
  await forget(lay, reg.id);
}

async function forget(lay, key) {
  await fs.rm(regFile(lay, key), { force: true });
  await fs.rm(keyFile(lay, key), { force: true });
}

async function startEngine(lay, engine, inst, { readyTimeoutMs, launch }) {
  const marker = await readInstalledEngine(lay, engine.id);
  if (!marker) throw new EngineError('not_installed', `${engine.name} is not installed; install it in Crealika Desktop`);
  const exe = serverPath(lay, marker);
  const models = path.join(lay.models, engine.models);
  await fs.mkdir(models, { recursive: true });
  const port = await freePort();
  const apiKey = randomBytes(32).toString('base64url');
  // The key file keeps the key out of the process list for engines that can read it.
  await fs.writeFile(keyFile(lay, inst.key), `${apiKey}\n`, { mode: 0o600 });
  const values = {
    host: '127.0.0.1',
    port: String(port),
    apiKey,
    apiKeyFile: keyFile(lay, inst.key),
    models,
    model: inst.model ? modelPath(lay, engine, inst.model) : '',
  };
  const args = engine.args.map((a) => a.replace(/\{(\w+)\}/g, (_, name) => values[name]));
  const logPath = path.join(lay.logs, `engine-${engine.id}.log`);
  const what = inst.model ? `${engine.id} ${inst.model}` : engine.id;
  await fs.appendFile(logPath, `\n--- ${new Date().toISOString()} start ${what} ${marker.version} ${marker.accel} port ${port}\n`);
  const fd = openSync(logPath, 'a');
  let child;
  try {
    // Own process group (detached): the engine outlives the host that started it, and stopping
    // the group also stops the model processes llama.cpp starts in router mode.
    child = launch(exe, args, {
      cwd: path.dirname(exe),
      detached: true,
      stdio: ['ignore', fd, fd],
      windowsHide: true,
      env: engineEnv(),
    });
  } catch (err) {
    await fs.rm(keyFile(lay, inst.key), { force: true });
    throw err;
  } finally {
    closeSync(fd);
  }
  let exited = null;
  child.on('exit', (code, signal) => {
    exited = code ?? signal;
  });
  const spawnError = new Promise((_, reject) => child.once('error', reject));
  spawnError.catch(() => {});
  child.unref();
  const reg = {
    id: inst.key,
    engine: engine.id,
    model: inst.model,
    pid: child.pid,
    url: `http://127.0.0.1:${port}`,
    apiKey,
    version: marker.version,
    accel: marker.accel,
    startedAt: new Date().toISOString(),
    leases: [],
  };
  const fail = async (message) => {
    await fs.rm(keyFile(lay, inst.key), { force: true });
    return new EngineError('start_failed', message);
  };
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    let ready;
    try {
      ready = await Promise.race([healthy(reg, engine), spawnError]);
    } catch (err) {
      throw await fail(`${engine.name} could not start: ${err.message}`);
    }
    if (ready) return reg;
    if (exited !== null) {
      throw await fail(`${engine.name} exited (${exited}) before it was ready; see logs/engine-${engine.id}.log`);
    }
    if (Date.now() > deadline) {
      await stopProcess(child.pid);
      throw await fail(`${engine.name} did not start within ${Math.round(readyTimeoutMs / 1000)} s; see logs/engine-${engine.id}.log`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function publicInfo(lay, engine, reg) {
  return {
    id: engine.id,
    instance: reg.id,
    model: reg.model ?? null,
    url: reg.url,
    apiKey: reg.apiKey,
    version: reg.version,
    accel: reg.accel,
    models: path.join(lay.models, engine.models),
  };
}

async function healthy(reg, engine) {
  try {
    const res = await fetch(new URL(engine.health, reg.url), { signal: AbortSignal.timeout(1000) });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Stops the engine and the processes it started: SIGTERM to the process group, SIGKILL after
// timeoutMs. On Windows taskkill /T ends the process tree.
export async function stopProcess(pid, { timeoutMs = 5000 } = {}) {
  if (!isAlive(pid)) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      k.on('exit', resolve);
      k.on('error', resolve);
    });
    return;
  }
  const signal = (sig) => {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        process.kill(pid, sig);
      } catch {
        // Already gone.
      }
    }
  };
  signal('SIGTERM');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid) && !groupAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  signal('SIGKILL');
}

function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// The engine gets the user's environment without the launcher's own variables.
function engineEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('ELECTRON_') || k.startsWith('CREALIKA_') || k === 'NODE_OPTIONS') continue;
    env[k] = v;
  }
  return env;
}

function withEngineLock(lay, key, fn) {
  // Starting an engine may take a while (loading the binary or the model, first health check).
  return withFileLock(lockFile(lay, key), fn, { staleMs: 120000, timeoutMs: 90000, what: `engine ${key} lock` });
}

async function registeredKeys(lay) {
  let names;
  try {
    names = await fs.readdir(dir(lay));
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((key) => INSTANCE_RE.test(key));
}

async function readReg(lay, key) {
  try {
    const reg = JSON.parse(await fs.readFile(regFile(lay, key), 'utf8'));
    if (!reg || reg.id !== key || !Number.isInteger(reg.pid) || typeof reg.url !== 'string' || !Array.isArray(reg.leases)) return null;
    return reg;
  } catch {
    return null;
  }
}

async function writeReg(lay, reg) {
  const file = regFile(lay, reg.id);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(reg, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
