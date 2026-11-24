// Service host: the same executable started with --service=<id>. A standalone app with
// its own window that keeps running without the launcher. It starts the service backend,
// opens its window, writes run/<id>.json and answers control requests from the launcher.
// Closing the window shuts the service down.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { app, BrowserWindow, dialog, shell } from 'electron';
import { createAppSession } from './app-session.js';
import { createLauncherApi } from './core/api.js';
import { ensureHome, resolveHome } from './core/home.js';
import { readManifest } from './core/manifest.js';
import { removeRun, writeRun } from './core/registry.js';
import { ServiceRunner } from './core/runner.js';

export function runServiceHost(id) {
  // Own userData: a separate single-instance lock per service,
  // and separate cookies and storage for its window.
  app.setPath('userData', path.join(app.getPath('userData'), 'services', id));
  if (!app.requestSingleInstanceLock()) {
    // Already running: the existing instance gets second-instance and shows its window.
    app.quit();
    return;
  }

  let lay, api, runner, win;
  let quitting = false;

  const focus = () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  async function shutdown() {
    await Promise.allSettled([runner?.stopAll()]);
    if (lay) await removeRun(lay, id, process.pid).catch(() => {});
    await api?.close();
  }

  app.on('second-instance', focus);
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (e) => {
    if (quitting) return;
    e.preventDefault();
    quitting = true;
    shutdown().finally(() => app.exit(0));
  });
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => app.quit());

  async function main() {
    lay = await ensureHome(resolveHome());
    const manifest = await readManifest(path.join(lay.services, id));
    const controlToken = randomBytes(32).toString('base64url');
    // The launcher signs in; every host reads the same shared session.
    const { session } = createAppSession(lay);
    api = createLauncherApi({
      getSession: () => session.state(),
      getToken: (_id, resource) => session.accessToken(resource ?? ''),
      getPaths: async (sid) => ({
        home: lay.home,
        models: lay.models,
        engines: lay.engines,
        output: path.join(lay.output, sid),
        data: path.join(lay.data, sid),
      }),
      controlToken,
      onControl: (action) => {
        if (action === 'focus') focus();
        if (action === 'quit') app.quit();
      },
    });
    await api.start();
    runner = new ServiceRunner({ layout: lay, api });
    runner.on('exit', (_sid, code) => {
      if (quitting) return;
      dialog.showErrorBox(manifest.name, `The service exited (${code}). Log: ${path.join(lay.logs, `${id}.log`)}`);
      app.quit();
    });
    const info = await runner.start(id);
    const origin = new URL(info.url).origin;

    win = new BrowserWindow({
      width: 1100,
      height: 760,
      title: manifest.name,
      autoHideMenuBar: true,
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    win.once('ready-to-show', () => win.show());
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (new URL(url).origin !== origin) {
        e.preventDefault();
        if (/^https?:/.test(url)) shell.openExternal(url);
      }
    });

    await writeRun(lay, {
      id,
      name: manifest.name,
      version: manifest.version,
      hostPid: process.pid,
      backendPid: info.pid,
      url: info.url,
      controlUrl: api.url,
      controlToken,
      startedAt: new Date().toISOString(),
    });
    await win.loadURL(info.launchUrl);
  }

  app.whenReady().then(main).catch((err) => {
    console.error(err);
    if (!quitting) dialog.showErrorBox(`Crealika Desktop: ${id}`, String(err.message ?? err));
    app.quit();
  });
}
