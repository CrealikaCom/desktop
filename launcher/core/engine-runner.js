// Shared engine processes. An engine is started on demand by a service host, detached from it,
// and shared by every service that asks for it: run/engines/<id>.json records its address, API
// key and the leases of the hosts using it. All changes happen under run/engines/<id>.lock, as the
// launcher and every service host are separate processes. The last host to release an engine
// stops it; leases of hosts that died are dropped by the next acquire, release or reap.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { openSync, closeSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { withFileLock } from './file-lock.js';
import { ID_RE } from './manifest.js';
import { readInstalledEngine, serverPath } from './engine-installer.js';

export class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const dir = (lay) => path.join(lay.run, 'engines');
const regFile = (lay, id) => path.join(dir(lay), `${id}.json`);
const lockFile = (lay, id) => path.join(dir(lay), `${id}.lock`);

/**
 * Starts the engine or joins the running one. holder: { pid, service } of the asking host.
 * Returns { id, url, apiKey, version, accel, models }.
 * launch(file, args, options) replaces child_process.spawn in tests.
 */
export async function acquireEngine(lay, engine, holder, { readyTimeoutMs = 60000, launch = spawn } = {}) {
  await fs.mkdir(dir(lay), { recursive: true });
  return withEngineLock(lay, engine.id, async () => {
    let reg = await readReg(lay, engine.id);
    if (reg && !(await healthy(reg, engine))) {
      // Dead or unresponsive: forget it (a hung process is stopped first).
      if (isAlive(reg.pid)) await stopProcess(reg.pid);
      await fs.rm(regFile(lay, engine.id), { force: true });
      reg = null;
    }
    if (!reg) reg = await startEngine(lay, engine, { readyTimeoutMs, launch });
    reg.leases = reg.leases.filter((l) => isAlive(l.pid) && !(l.pid === holder.pid && l.service === holder.service));
    reg.leases.push({ pid: holder.pid, service: holder.service, at: new Date().toISOString() });
    await writeReg(lay, reg);
    return publicInfo(lay, engine, reg);
  });
}

// Drops the lease of this host; the engine stops when no lease is left.
export async function releaseEngine(lay, id, holder) {
  if (!(await exists(regFile(lay, id)))) return;
  await withEngineLock(lay, id, async () => {
    const reg = await readReg(lay, id);
    if (!reg) return;
    reg.leases = reg.leases.filter((l) => isAlive(l.pid) && !(l.pid === holder.pid && (!holder.service || l.service === holder.service)));
    await settle(lay, reg);
  });
}

// Called by the launcher on its timer: stops engines whose hosts all died, forgets dead engines.
export async function reapEngines(lay) {
  for (const id of await registeredIds(lay)) {
    await withEngineLock(lay, id, async () => {
      const reg = await readReg(lay, id);
      if (!reg) return;
      if (!isAlive(reg.pid)) {
        await fs.rm(regFile(lay, id), { force: true });
        return;
      }
      reg.leases = reg.leases.filter((l) => isAlive(l.pid));
      await settle(lay, reg);
    }).catch(() => {});
  }
}

// Running engines without their API keys: { id, pid, url, version, accel, services, startedAt }.
export async function listRunningEngines(lay) {
  const out = new Map();
  for (const id of await registeredIds(lay)) {
    const reg = await readReg(lay, id);
    if (!reg || !isAlive(reg.pid)) continue;
    const services = [...new Set(reg.leases.filter((l) => isAlive(l.pid)).map((l) => l.service))];
    out.set(id, { id, pid: reg.pid, url: reg.url, version: reg.version, accel: reg.accel, services, startedAt: reg.startedAt });
  }
  return out;
}

async function settle(lay, reg) {
  if (reg.leases.length) {
    await writeReg(lay, reg);
    return;
  }
  await stopProcess(reg.pid);
  await fs.rm(regFile(lay, reg.id), { force: true });
}

async function startEngine(lay, engine, { readyTimeoutMs, launch }) {
  const marker = await readInstalledEngine(lay, engine.id);
  if (!marker) throw new EngineError('not_installed', `${engine.name} is not installed; install it in Crealika Desktop`);
  const exe = serverPath(lay, marker);
  const models = path.join(lay.models, engine.models);
  await fs.mkdir(models, { recursive: true });
  const port = await freePort();
  const apiKey = randomBytes(32).toString('base64url');
  const values = { host: '127.0.0.1', port: String(port), apiKey, models };
  const args = engine.args.map((a) => a.replace(/\{(\w+)\}/g, (_, name) => values[name]));
  const logPath = path.join(lay.logs, `engine-${engine.id}.log`);
  await fs.appendFile(logPath, `\n--- ${new Date().toISOString()} start ${engine.id} ${marker.version} ${marker.accel} port ${port}\n`);
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
    id: engine.id,
    pid: child.pid,
    url: `http://127.0.0.1:${port}`,
    apiKey,
    version: marker.version,
    accel: marker.accel,
    startedAt: new Date().toISOString(),
    leases: [],
  };
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    const ready = await Promise.race([healthy(reg, engine), spawnError]).catch((err) => {
      throw new EngineError('start_failed', `${engine.name} could not start: ${err.message}`);
    });
    if (ready) return reg;
    if (exited !== null) {
      throw new EngineError('start_failed', `${engine.name} exited (${exited}) before it was ready; see logs/engine-${engine.id}.log`);
    }
    if (Date.now() > deadline) {
      await stopProcess(child.pid);
      throw new EngineError('start_failed', `${engine.name} did not start within ${Math.round(readyTimeoutMs / 1000)} s; see logs/engine-${engine.id}.log`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function publicInfo(lay, engine, reg) {
  return {
    id: engine.id,
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

function withEngineLock(lay, id, fn) {
  // Starting an engine may take a while (loading the binary, first health check).
  return withFileLock(lockFile(lay, id), fn, { staleMs: 120000, timeoutMs: 90000, what: `engine ${id} lock` });
}

async function registeredIds(lay) {
  let names;
  try {
    names = await fs.readdir(dir(lay));
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).filter((id) => ID_RE.test(id));
}

async function readReg(lay, id) {
  try {
    const reg = JSON.parse(await fs.readFile(regFile(lay, id), 'utf8'));
    if (!reg || reg.id !== id || !Number.isInteger(reg.pid) || typeof reg.url !== 'string' || !Array.isArray(reg.leases)) return null;
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
