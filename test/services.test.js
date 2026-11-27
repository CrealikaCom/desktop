// Switching between services: the list a service window shows and what opening one does.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createLauncherApi } from '../launcher/core/api.js';
import { parseServiceArg, parseShowArg } from '../launcher/core/args.js';
import { ensureHome } from '../launcher/core/home.js';
import { removeRun, writeRun } from '../launcher/core/registry.js';
import { catalogFiles, listServices, openService, ServiceError } from '../launcher/core/services.js';

let tmp, lay, files, host, focused;

async function installFake(id, name, extra = {}) {
  const dir = path.join(lay.services, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'crealika-service.json'), JSON.stringify({ id, name, version: '1.0.0', runtime: 'node', entry: 'server.js', ...extra }));
}

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'crealika-services-test-'));
  lay = await ensureHome(path.join(tmp, 'home'));
  const appRoot = path.join(tmp, 'app');
  await fs.mkdir(appRoot);
  files = catalogFiles(lay, appRoot);
  await fs.writeFile(files[0], JSON.stringify({ services: [] }));
  await fs.writeFile(files[1], JSON.stringify({ services: [
    { id: 'images', name: 'Images', description: 'Pictures', source: { type: 'git', url: 'ssh://git@example.com/images.git' } },
    { id: 'voice', name: 'Voice', source: { type: 'git', url: 'ssh://git@example.com/voice.git' } },
  ] }));
  await installFake('images', 'Images', { description: 'Image generation' });
  await installFake('dummy', 'Dummy');
  await fs.mkdir(path.join(lay.services, 'broken'));

  // A running host of "dummy": answers ping and focus with its control token.
  focused = 0;
  host = http.createServer((req, res) => {
    const ok = req.headers.authorization === 'Bearer control';
    if (ok && req.url === '/control/focus') focused++;
    res.writeHead(ok ? 200 : 401).end();
  });
  await new Promise((resolve) => host.listen(0, '127.0.0.1', resolve));
  await writeRun(lay, { id: 'dummy', name: 'Dummy', hostPid: process.pid, controlUrl: `http://127.0.0.1:${host.address().port}`, controlToken: 'control' });
});

after(async () => {
  await removeRun(lay, 'dummy', process.pid);
  await new Promise((resolve) => host.close(resolve));
  await fs.rm(tmp, { recursive: true, force: true });
});

test('--show picks the service whose card the launcher highlights', () => {
  assert.equal(parseShowArg(['electron', '.', '--show=images']), 'images');
  assert.equal(parseShowArg(['electron', '.', '--show', 'dummy']), 'dummy');
  assert.equal(parseShowArg(['electron', '.']), null);
  assert.equal(parseServiceArg(['electron', '.', '--show=images']), null);
});

test('the list joins the catalog and installed services, by name, without broken installs', async () => {
  const list = await listServices(lay, files, 'images');
  assert.deepEqual(list, [
    { id: 'dummy', name: 'Dummy', description: '', installed: true, running: true, current: false },
    { id: 'images', name: 'Images', description: 'Image generation', installed: true, running: false, current: true },
    { id: 'voice', name: 'Voice', description: '', installed: false, running: false, current: false },
  ]);
});

test('opening focuses a running service, starts an installed one and shows the rest in the launcher', async () => {
  const started = [];
  const start = async (what) => started.push(what);
  assert.equal(await openService(lay, files, 'dummy', start), 'focused');
  assert.equal(focused, 1);
  assert.equal(await openService(lay, files, 'images', start), 'started');
  assert.equal(await openService(lay, files, 'voice', start), 'launcher');
  // A broken install is repaired in the launcher.
  assert.equal(await openService(lay, files, 'broken', start), 'launcher');
  assert.deepEqual(started, [{ service: 'images' }, { show: 'voice' }, { show: 'broken' }]);
  for (const id of ['nope', '../x', 'Bad']) {
    await assert.rejects(openService(lay, files, id, start), (err) => err instanceof ServiceError && err.code === 'unknown_service', id);
  }
  assert.equal(started.length, 3);
});

test('host API: GET /v1/services and POST /v1/services/<id>/open', async () => {
  const calls = [];
  const api = createLauncherApi({
    getSession: async () => ({}),
    getPaths: async () => ({}),
    services: {
      list: async (sid) => [{ id: 'dummy', current: sid === 'dummy' }],
      open: async (sid, id) => {
        calls.push([sid, id]);
        if (id === 'nope') throw new ServiceError('unknown_service', 'unknown service');
        return 'started';
      },
    },
  });
  const url = await api.start();
  api.register('tok', 'dummy');
  const req = (p, method = 'GET', token = 'tok') => fetch(url + p, { method, headers: { authorization: `Bearer ${token}` } });
  try {
    assert.deepEqual(await (await req('/v1/services')).json(), { services: [{ id: 'dummy', current: true }] });
    assert.deepEqual(await (await req('/v1/services/images/open', 'POST')).json(), { result: 'started' });
    const missing = await req('/v1/services/nope/open', 'POST');
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'unknown_service');
    assert.equal((await req('/v1/services/images/open')).status, 405);
    assert.equal((await req('/v1/services', 'GET', 'wrong')).status, 401);
    assert.deepEqual(calls, [['dummy', 'images'], ['dummy', 'nope']]);
  } finally {
    await api.close();
  }
});

test('Linux windows run under XWayland when it is there, with ANGLE on Vulkan for NVIDIA', async () => {
  const { displayArgs } = await import('../launcher/core/display.js');
  const env = { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' };
  const argv = ['electron', '.'];
  const linux = (over) => displayArgs({ platform: 'linux', env, argv, nvidia: false, ...over });
  assert.deepEqual(linux(), ['--ozone-platform=x11']);
  assert.deepEqual(linux({ nvidia: true }), ['--ozone-platform=x11', '--use-angle=vulkan']);
  assert.deepEqual(linux({ nvidia: true, argv: [...argv, '--use-angle=gl'] }), ['--ozone-platform=x11']);
  assert.deepEqual(linux({ nvidia: true, argv: [...argv, '--ozone-platform=x11', '--use-angle=vulkan'] }), [], 'started with them: nothing to add');
  assert.deepEqual(linux({ argv: [...argv, '--ozone-platform=wayland'] }), []);
  assert.deepEqual(linux({ env: { ...env, CREALIKA_DESKTOP_WAYLAND: '1' } }), []);
  assert.deepEqual(linux({ env: { WAYLAND_DISPLAY: 'wayland-0' } }), [], 'no XWayland');
  assert.deepEqual(linux({ env: { DISPLAY: ':0' } }), [], 'an X11 session needs nothing');
  assert.deepEqual(displayArgs({ platform: 'win32', env, argv }), []);
});

test('a packaged AppImage starts other processes from the AppImage file', async () => {
  const { selfCommand } = await import('../launcher/core/services.js');
  const env = { APPIMAGE: '/home/u/Crealika-Desktop-x86_64.AppImage' };
  const execPath = '/tmp/.mount_Crea1/crealika-desktop';
  assert.equal(selfCommand({ packaged: true, env, execPath }), env.APPIMAGE);
  assert.equal(selfCommand({ packaged: false, env, execPath }), execPath, 'from source: the AppImage is some other app');
  assert.equal(selfCommand({ packaged: true, env: {}, execPath }), execPath);
});

test('updates run in the Windows installer and the AppImage only', async () => {
  const { updatesSupported } = await import('../launcher/core/updates.js');
  const appimage = { APPIMAGE: '/home/u/Crealika-Desktop-x86_64.AppImage' };
  assert.equal(updatesSupported({ packaged: true, platform: 'win32', env: {} }), true);
  assert.equal(updatesSupported({ packaged: true, platform: 'linux', env: appimage }), true);
  assert.equal(updatesSupported({ packaged: true, platform: 'linux', env: {} }), false, '.deb');
  assert.equal(updatesSupported({ packaged: true, platform: 'darwin', env: {} }), false, 'not signed yet');
  assert.equal(updatesSupported({ packaged: false, platform: 'win32', env: {} }), false);
  assert.equal(updatesSupported({ packaged: true, platform: 'win32', env: { CREALIKA_DESKTOP_NO_UPDATES: '1' } }), false);
});
