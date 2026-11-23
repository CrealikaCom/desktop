// Launcher window: catalog, installation and starting of services. Services are separate
// processes (service-host.js) not owned by the launcher: closing it leaves them running.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { loadCatalogs } from './core/catalog.js';
import { ensureHome, resolveHome } from './core/home.js';
import { install, listInstalled, uninstall } from './core/installer.js';
import { control, listRunning, readRun } from './core/registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const POLL_MS = 2000;

export function runLauncher() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  let lay, mainWindow;
  const busy = new Set(); // ids of services being installed, removed or started

  const catalogFiles = () => [path.join(appRoot, 'catalog.json'), path.join(lay.config, 'catalog.json')];

  async function state() {
    const catalog = await loadCatalogs(catalogFiles());
    const installed = await listInstalled(lay);
    const running = await listRunning(lay);
    const ids = new Set([...catalog.map((c) => c.id), ...installed.keys()]);
    return {
      home: lay.home,
      session: { mode: 'guest', user: null },
      services: [...ids].sort().map((id) => {
        const c = catalog.find((x) => x.id === id);
        const m = installed.get(id);
        return {
          id,
          name: m?.name ?? c?.name ?? id,
          description: m?.description || c?.description || '',
          source: c ? describeSource(c.source) : null,
          installed: m ? (m.broken ? { broken: m.broken } : { version: m.version }) : null,
          running: running.has(id),
          busy: busy.has(id),
        };
      }),
    };
  }

  function notify() {
    mainWindow?.webContents.send('state-changed');
  }

  async function withBusy(id, fn) {
    if (busy.has(id)) throw new Error(`${id}: another operation is in progress`);
    busy.add(id);
    notify();
    try {
      return await fn();
    } finally {
      busy.delete(id);
      notify();
    }
  }

  async function assertStopped(id) {
    if ((await listRunning(lay)).has(id)) throw new Error(`${id}: stop the service first`);
  }

  // Running: show its window. Otherwise start a separate process detached from the launcher.
  async function openService(id) {
    const run = await readRun(lay, id);
    if (run && (await control(run, 'focus'))) return;
    await withBusy(id, async () => {
      const args = app.isPackaged ? [`--service=${id}`] : [app.getAppPath(), `--service=${id}`];
      const env = { ...process.env, CREALIKA_HOME: lay.home };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env, windowsHide: false });
      child.unref();
      // Wait for the host to register itself; the host reports startup errors on its own.
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) return;
        const r = await readRun(lay, id);
        if (r && r.hostPid === child.pid) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    });
  }

  async function stopService(id) {
    const run = await readRun(lay, id);
    if (!run) return;
    await withBusy(id, async () => {
      if (!(await control(run, 'quit'))) return;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && (await readRun(lay, id))) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    });
  }

  function handle(channel, fn) {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return { ok: true, value: await fn(...args) };
      } catch (err) {
        return { ok: false, error: String(err.message ?? err) };
      }
    });
  }

  function showWindow() {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }

  async function main() {
    lay = await ensureHome(resolveHome());

    handle('state', state);
    handle('install', async (id) => {
      const entry = (await loadCatalogs(catalogFiles())).find((c) => c.id === id);
      if (!entry) throw new Error(`${id}: not in the catalog`);
      return withBusy(id, async () => {
        await assertStopped(id);
        return install(entry, lay);
      });
    });
    handle('uninstall', (id) =>
      withBusy(id, async () => {
        await assertStopped(id);
        return uninstall(id, lay);
      }),
    );
    handle('open', openService);
    handle('stop', stopService);
    handle('open-folder', (kind) => {
      if (!['home', 'models', 'output', 'logs', 'config', 'services'].includes(kind)) throw new Error('unknown folder');
      return shell.openPath(lay[kind]);
    });

    mainWindow = new BrowserWindow({
      width: 900,
      height: 640,
      title: 'Crealika Desktop',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(here, 'preload.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
    // Services start and stop on their own, so the launcher window refreshes on a timer.
    const timer = setInterval(notify, POLL_MS);
    mainWindow.on('closed', () => clearInterval(timer));
    await mainWindow.loadFile(path.join(here, 'ui', 'index.html'));
  }

  app.on('second-instance', showWindow);
  // Closing the launcher leaves running services alone.
  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(main).catch((err) => {
    console.error(err);
    app.exit(1);
  });
}

function describeSource(s) {
  if (s.type === 'git') return `git ${s.url} @ ${s.ref}`;
  if (s.type === 'archive') return `archive ${s.url}`;
  return `folder ${s.path}`;
}
