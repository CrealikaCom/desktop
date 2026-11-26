// Launcher window: catalog, installation and starting of services, and the shared engines they
// use. Services are separate processes (service-host.js) not owned by the launcher: closing it
// leaves them running.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, nativeTheme, net, protocol, shell } from 'electron';
import { createAppSession } from './app-session.js';
import { loadCatalogs } from './core/catalog.js';
import { buildsFor, currentPlatform, loadEngineCatalogs, recommendedBuild, detectAccelerators } from './core/engine-catalog.js';
import { installEngine, uninstallEngine } from './core/engine-installer.js';
import { listRunningEngines, reapEngines } from './core/engine-runner.js';
import { engineCatalogFiles, engineOverview } from './core/engines.js';
import { findExternalEngines } from './core/external-engines.js';
import { ensureHome, resolveHome } from './core/home.js';
import { install, listInstalled, uninstall } from './core/installer.js';
import { SignInError, signInWithBrowser } from './core/crealika-id.js';
import { createPreferences, themeSource } from './core/preferences.js';
import { control, listRunning, readRun } from './core/registry.js';
import { parseShowArg } from './core/args.js';
import { catalogFiles as serviceCatalogFiles } from './core/services.js';
import { startApp } from './start-app.js';

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
  const busy = new Set(); // ids of services being installed, removed or started; engine:<id> for engines
  const progress = new Map(); // engine id -> { received, total } while downloading

  const catalogFiles = () => serviceCatalogFiles(lay, appRoot);
  // A service window asked to show this service (--show=<id>): its card is highlighted.
  let show = parseShowArg(process.argv);

  async function state() {
    const catalog = await loadCatalogs(catalogFiles());
    const installed = await listInstalled(lay);
    const running = await listRunning(lay);
    const ids = new Set([...catalog.map((c) => c.id), ...installed.keys()]);
    const overview = await engineOverview(lay, { external: false });
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
          engines: m && !m.broken ? m.engines : [],
        };
      }),
      detected: overview.detected,
      engines: overview.engines.map((e) => ({ ...e, busy: busy.has(`engine:${e.id}`), progress: progress.get(e.id) ?? null })),
      external: await externalEngines(),
    };
  }

  // Engines the user runs themselves, probed at most every 10 seconds.
  let externalCache = { at: 0, list: [] };
  async function externalEngines() {
    if (Date.now() - externalCache.at > 10000) {
      const { external } = await loadEngineCatalogs(engineCatalogFiles(lay));
      externalCache = { at: Date.now(), list: await findExternalEngines(external) };
    }
    return externalCache.list;
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

  // Installs or replaces a shared engine; accel null picks the recommended build for this computer.
  async function installEngineBuild(id, accel) {
    const { engines } = await loadEngineCatalogs(engineCatalogFiles(lay));
    const engine = engines.find((e) => e.id === id);
    if (!engine) throw new Error(`engine ${id} is not in the engine catalog`);
    const builds = buildsFor(engine, currentPlatform());
    const build = accel ? builds.find((b) => b.accel === accel) : recommendedBuild(builds, await detectAccelerators());
    if (!build) throw new Error(`${engine.name}: no ${accel ? `${accel} ` : ''}build for ${process.platform} ${process.arch}`);
    return withBusy(`engine:${id}`, async () => {
      if ((await listRunningEngines(lay)).has(id)) throw new Error(`${engine.name} is in use; close the services using it first`);
      let last = 0;
      try {
        return await installEngine(engine, build, lay, {
          onProgress: (p) => {
            progress.set(id, p);
            if (Date.now() - last > 300) {
              last = Date.now();
              notify();
            }
          },
        });
      } finally {
        progress.delete(id);
      }
    });
  }

  // A service brings the engines its manifest lists.
  async function installServiceEngines(manifest) {
    const { engines } = await loadEngineCatalogs(engineCatalogFiles(lay));
    const missing = manifest.engines.filter((id) => !engines.some((e) => e.id === id));
    if (missing.length) throw new Error(`${manifest.name} needs ${missing.join(', ')}, which the engine catalog does not have`);
    for (const id of manifest.engines) {
      if (!(await engineOverview(lay, { external: false })).engines.find((e) => e.id === id)?.installed) await installEngineBuild(id, null);
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
      const child = startApp(lay, { service: id });
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

  function showWindow(_e, argv = []) {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    const id = parseShowArg(argv);
    if (id) {
      show = id;
      mainWindow.webContents.send('show-service');
    }
  }

  async function main() {
    lay = await ensureHome(resolveHome());
    auth = createAppSession(lay);
    preferences = createPreferences(lay);
    nativeTheme.themeSource = themeSource((await preferences.read()).theme);
    protocol.handle('launcher', serveUi);

    handle('state', state);
    handle('take-show', () => {
      const id = show;
      show = null;
      return id;
    });
    handle('install', async (id) => {
      const entry = (await loadCatalogs(catalogFiles())).find((c) => c.id === id);
      if (!entry) throw new Error(`${id}: not in the catalog`);
      const manifest = await withBusy(id, async () => {
        await assertStopped(id);
        return install(entry, lay);
      });
      await installServiceEngines(manifest);
      return manifest;
    });
    handle('engine-install', (id, accel) => installEngineBuild(id, accel ?? null));
    handle('engine-uninstall', (id) =>
      withBusy(`engine:${id}`, async () => {
        if ((await listRunningEngines(lay)).has(id)) throw new Error('The engine is in use; close the services using it first');
        return uninstallEngine(id, lay);
      }),
    );
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
      if (!['home', 'models', 'output', 'logs', 'config', 'services', 'engines'].includes(kind)) throw new Error('unknown folder');
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
    // Services start and stop on their own, so the launcher window refreshes on a timer. Engines
    // left by services that crashed are stopped on the same timer.
    const timer = setInterval(() => {
      reapEngines(lay).catch(() => {});
      notify();
    }, POLL_MS);
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
