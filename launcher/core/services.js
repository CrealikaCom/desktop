// Services the user can switch to from a service window, and opening one of them the way the
// launcher's Open button does: focus it when running, start it when installed, otherwise show
// it in the launcher. Without Electron: the caller says how to start the app.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { loadCatalogs } from './catalog.js';
import { listInstalled } from './installer.js';
import { ID_RE } from './manifest.js';
import { control, listRunning, readRun } from './registry.js';

// The built-in catalog next to the app and the user's catalog in the home directory.
export function catalogFiles(lay, appRoot) {
  return [path.join(appRoot, 'catalog.json'), path.join(lay.config, 'catalog.json')];
}

// Catalog entries and installed services, by name; broken installs are left out.
export async function listServices(lay, files, currentId = null) {
  const catalog = await loadCatalogs(files);
  const installed = await listInstalled(lay);
  const running = await listRunning(lay);
  const out = [];
  for (const id of new Set([...catalog.map((c) => c.id), ...installed.keys()])) {
    const m = installed.get(id);
    if (m?.broken) continue;
    const c = catalog.find((x) => x.id === id);
    out.push({
      id,
      name: m?.name ?? c?.name ?? id,
      description: m?.description || c?.description || '',
      installed: Boolean(m),
      running: running.has(id),
      current: id === currentId,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export class ServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// start({service}) starts the service host, start({show}) the launcher showing that service
// (not installed, or a broken install to repair). Returns 'focused', 'started' or 'launcher'.
export async function openService(lay, files, id, start) {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new ServiceError('unknown_service', 'unknown service');
  const run = await readRun(lay, id);
  if (run && (await control(run, 'focus'))) return 'focused';
  const installed = await listInstalled(lay);
  const m = installed.get(id);
  if (m && !m.broken) {
    await start({ service: id });
    return 'started';
  }
  if (!m && !(await loadCatalogs(files)).some((c) => c.id === id)) throw new ServiceError('unknown_service', `${id}: unknown service`);
  await start({ show: id });
  return 'launcher';
}

// The executable that starts this app again. A packaged AppImage runs from a mount that goes away
// when its first process exits, so other processes start from the AppImage file itself.
export function selfCommand({ packaged, env = process.env, execPath = process.execPath }) {
  return (packaged && env.APPIMAGE) || execPath;
}

// Starts the app detached from this process: it keeps running when this one exits.
export function spawnApp({ command, args, home }) {
  const env = { ...process.env, CREALIKA_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(command, args, { detached: true, stdio: 'ignore', env, windowsHide: false });
  child.unref();
  return child;
}
