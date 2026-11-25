// Launcher window: catalog, installation and starting of services. Services are separate
// processes (service-host.js) not owned by the launcher: closing it leaves them running.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, nativeTheme, net, protocol, shell } from 'electron';
import { createAppSession } from './app-session.js';
import { loadCatalogs } from './core/catalog.js';
import { ensureHome, resolveHome } from './core/home.js';
import { install, listInstalled, uninstall } from './core/installer.js';
import { SignInError, signInWithBrowser } from './core/crealika-id.js';
import { createPreferences, themeSource } from './core/preferences.js';
import { control, listRunning, readRun } from './core/registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const POLL_MS = 2000;
const UI_DIR = path.join(here, 'ui');
const CORE_DIR = path.join(appRoot, 'vendor', 'crealika-ui-core');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.woff2': 'font/woff2',
};

// The launcher window is served from launcher://app/ rather than file://, so ES modules and fetch
// work and the Crealika UI core loads like on a website.
protocol.registerSchemesAsPrivileged([
  { scheme: 'launcher', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

export function runLauncher() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  let lay, mainWindow, auth, preferences;
  // One browser sign-in at a time: { url, abort } while waiting for the browser.
  let signIn = null;
  let signInError = null;
  const busy = new Set(); // ids of services being installed, removed or started

  const catalogFiles = () => [path.join(appRoot, 'catalog.json'), path.join(lay.config, 'catalog.json')];

  async function state() {
    const catalog = await loadCatalogs(catalogFiles());
    const installed = await listInstalled(lay);
    const running = await listRunning(lay);
    const ids = new Set([...catalog.map((c) => c.id), ...installed.keys()]);
    return {
      home: lay.home,
      session: await auth.session.state(),
      preferences: await followPreferences(),
      signIn: signIn ? { url: signIn.url } : null,
      signInError,
      weakStorage: auth.weakStorage(),
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

  // Opens the system browser; CREALIKA_DESKTOP_NO_BROWSER keeps it closed (headless checks),
  // the window then shows the sign-in link.
  async function openBrowser(url) {
    if (!process.env.CREALIKA_DESKTOP_NO_BROWSER) await shell.openExternal(url);
  }

  function startSignIn() {
    if (signIn) return;
    const abort = new AbortController();
    signIn = { url: null, abort };
    signInError = null;
    notify();
    const idp = auth.idp();
    signInWithBrowser({
      idp,
      openBrowser,
      signal: abort.signal,
      onUrl: (url) => {
        signIn.url = url;
        notify();
      },
    })
      .then(async ({ tokens, user }) => {
        await auth.session.signIn({ issuer: idp.issuer, user, tokens, resources: idp.resources });
        // The theme chosen in the account wins once, at sign-in.
        if (user.theme) await applyPreferences({ theme: user.theme });
      })
      .catch((err) => {
        if (!(err instanceof SignInError && err.code === 'cancelled')) {
          signInError = err instanceof SignInError && err.code === 'denied'
            ? 'Sign-in was cancelled in the browser.'
            : `Sign-in failed: ${err.message ?? err}`;
        }
      })
      .finally(() => {
        signIn = null;
        notify();
      });
  }

  // Services may change the preferences too; window chrome follows whatever is stored.
  async function followPreferences() {
    const current = await preferences.read();
    nativeTheme.themeSource = themeSource(current.theme);
    return current;
  }

  async function applyPreferences(update) {
    const next = await preferences.write(update);
    nativeTheme.themeSource = themeSource(next.theme);
    notify();
    return next;
  }

  // launcher://app/<path>: the launcher UI and, under /crealika-ui-core/, the vendored kit.
  // index.html gets the current preferences so the theme applies before the first paint.
  async function serveUi(request) {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    const [base, sub] = rel.startsWith('/crealika-ui-core/') ? [CORE_DIR, rel.slice('/crealika-ui-core/'.length)] : [UI_DIR, rel.slice(1)];
    const file = path.resolve(base, sub);
    if (!file.startsWith(base + path.sep)) return new Response('Forbidden', { status: 403 });
    const type = TYPES[path.extname(file)] ?? 'application/octet-stream';
    if (file === path.join(UI_DIR, 'index.html')) {
      const prefs = await preferences.read();
      const meta = JSON.stringify({ locale: prefs.locale, theme: prefs.theme }).replaceAll('"', '&quot;');
      const html = (await fs.readFile(file, 'utf8')).replace('<!--preferences-->', `<meta name="crealika-preferences" content="${meta}">`);
      return new Response(html, { headers: { 'content-type': type } });
    }
    const res = await net.fetch(pathToFileURL(file).href).catch(() => null);
    if (!res?.ok) return new Response('Not found', { status: 404 });
    return new Response(res.body, { headers: { 'content-type': type } });
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
    auth = createAppSession(lay);
    preferences = createPreferences(lay);
    nativeTheme.themeSource = themeSource((await preferences.read()).theme);
    protocol.handle('launcher', serveUi);

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
    handle('set-preferences', (update) => applyPreferences(update));
    handle('sign-in', startSignIn);
    handle('sign-in-cancel', () => signIn?.abort.abort());
    handle('sign-in-reopen', () => signIn?.url && shell.openExternal(signIn.url));
    handle('sign-out', async () => {
      signInError = null;
      await auth.session.signOut();
      notify();
    });
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
    await mainWindow.loadURL('launcher://app/index.html');
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
