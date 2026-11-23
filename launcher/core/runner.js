// Runs installed service backends as separate processes.
// A Node service runs on the launcher's own executable (Electron with
// ELECTRON_RUN_AS_NODE=1), so users do not need a separate Node install.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { ensureServiceDirs } from './home.js';
import { readManifest } from './manifest.js';

export const READY_PREFIX = 'CREALIKA_READY ';

export class ServiceRunner extends EventEmitter {
  #running = new Map();

  constructor({ layout, api, execPath = process.execPath, readyTimeoutMs = 20000 }) {
    super();
    this.layout = layout;
    this.api = api;
    this.execPath = execPath;
    this.readyTimeoutMs = readyTimeoutMs;
  }

  list() {
    return [...this.#running.values()].map(({ id, url, pid }) => ({ id, url, pid }));
  }

  get(id) {
    return this.#running.get(id);
  }

  async start(id) {
    const existing = this.#running.get(id);
    if (existing) return existing.ready;
    const dir = path.join(this.layout.services, id);
    const manifest = await readManifest(dir);
    const own = await ensureServiceDirs(this.layout, id);
    const token = randomBytes(32).toString('base64url');
    const secret = randomBytes(32).toString('base64url');
    const env = {
      ...inheritedEnv(),
      ELECTRON_RUN_AS_NODE: '1',
      CREALIKA_SERVICE_ID: id,
      CREALIKA_HOME: this.layout.home,
      CREALIKA_DATA_DIR: own.data,
      CREALIKA_OUTPUT_DIR: own.output,
      CREALIKA_MODELS_DIR: this.layout.models,
      CREALIKA_ENGINES_DIR: this.layout.engines,
      CREALIKA_CACHE_DIR: this.layout.cache,
      CREALIKA_LAUNCHER_URL: this.api.url,
      CREALIKA_LAUNCHER_TOKEN: token,
      CREALIKA_SERVICE_SECRET: secret,
    };
    const log = fs.createWriteStream(path.join(this.layout.logs, `${id}.log`), { flags: 'a' });
    log.write(`\n--- ${new Date().toISOString()} start ${id} ${manifest.version}\n`);
    const child = spawn(this.execPath, [path.join(dir, manifest.entry)], {
      cwd: dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.api.register(token, id);
    const entry = { id, manifest, child, pid: child.pid, url: null, secret, token, ready: null };
    this.#running.set(id, entry);

    entry.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${id}: the service did not report readiness within ${this.readyTimeoutMs} ms`));
        child.kill();
      }, this.readyTimeoutMs);
      let buf = '';
      child.stdout.on('data', (chunk) => {
        log.write(chunk);
        if (entry.url) return;
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith(READY_PREFIX)) continue;
          try {
            const { port } = JSON.parse(line.slice(READY_PREFIX.length));
            if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('port');
            entry.url = `http://127.0.0.1:${port}/`;
          } catch {
            continue;
          }
          clearTimeout(timer);
          this.emit('change');
          resolve({ id, url: entry.url, launchUrl: launchUrl(entry), pid: child.pid });
          return;
        }
      });
      child.stderr.on('data', (chunk) => log.write(chunk));
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        log.end(`--- exit ${code ?? signal}\n`);
        this.api.unregister(token);
        if (this.#running.get(id) === entry) this.#running.delete(id);
        reject(new Error(`${id}: the process exited (${code ?? signal}) before it was ready; see logs/${id}.log`));
        this.emit('exit', id, code ?? signal);
        this.emit('change');
      });
    });
    entry.ready.catch(() => {});
    this.emit('change');
    return entry.ready;
  }

  async stop(id, { timeoutMs = 5000 } = {}) {
    const entry = this.#running.get(id);
    if (!entry) return;
    const { child } = entry;
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill();
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    await exited;
    clearTimeout(timer);
  }

  async stopAll() {
    await Promise.all([...this.#running.keys()].map((id) => this.stop(id)));
  }
}

// URL the service window opens first: the service sets the launch secret cookie there.
export function launchUrl(entry) {
  return `${entry.url}crealika/launch?secret=${encodeURIComponent(entry.secret)}`;
}

function inheritedEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('ELECTRON_') || k.startsWith('CREALIKA_') || k === 'NODE_OPTIONS') continue;
    env[k] = v;
  }
  return env;
}
