// Shared engines without Electron or network: catalog, accelerator choice, install from local
// archives, the shared process with leases, and the host API endpoints.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLauncherApi } from '../launcher/core/api.js';
import { buildsFor, detectAccelerators, loadEngineCatalogs, recommendedBuild, validateEngine } from '../launcher/core/engine-catalog.js';
import { installEngine, readInstalledEngine, uninstallEngine } from '../launcher/core/engine-installer.js';
import { acquireEngine, EngineError, isAlive, listRunningEngines, reapEngines, releaseEngine, stopProcess } from '../launcher/core/engine-runner.js';
import { createHostEngines } from '../launcher/core/engines.js';
import { ensureHome } from '../launcher/core/home.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_SERVER = path.join(here, 'fixtures', 'engine', 'fake-server.mjs');
const BUILTIN = path.join(here, '..', 'engines.json');
// The installer looks for <server>.exe on Windows.
const SERVER_FILE = process.platform === 'win32' ? 'fake-server.exe' : 'fake-server';
let tmp, lay;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'crealika-engines-test-'));
  lay = await ensureHome(path.join(tmp, 'home'));
});
after(() => fs.rm(tmp, { recursive: true, force: true }));

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

function engineDef(files, extra = {}) {
  return validateEngine({
    id: 'fake',
    name: 'Fake engine',
    version: 'v1',
    server: 'fake-server',
    models: 'fake',
    health: '/health',
    args: ['--host', '{host}', '--port', '{port}', '--api-key', '{apiKey}', '--models-dir', '{models}'],
    builds: [{ os: process.platform, arch: process.arch, accel: 'cpu', files }],
    ...extra,
  }, 'test');
}

// A .tar.gz whose single top-level folder holds the given files.
async function makeArchive(name, files) {
  const src = path.join(tmp, `src-${name}`);
  await fs.mkdir(path.join(src, 'top'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(src, 'top', rel)), { recursive: true });
    await fs.writeFile(path.join(src, 'top', rel), body);
  }
  const file = path.join(tmp, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', file, '-C', src, 'top']);
  const bytes = await fs.readFile(file);
  return { url: pathToFileURL(file).href, sha256: sha(bytes), size: bytes.length };
}

// Runs the JavaScript "server" of the fake engine with Node. Node does not run an ES module file
// named .exe, so on Windows the fixture runs in place of its installed copy.
const launchNode = (exe, args, options) => {
  assert.equal(path.basename(exe), SERVER_FILE);
  return spawn(process.execPath, [process.platform === 'win32' ? FAKE_SERVER : exe, ...args], options);
};

async function installFake() {
  const archive = await makeArchive('fake', { [SERVER_FILE]: await fs.readFile(FAKE_SERVER) });
  const engine = engineDef([archive]);
  await installEngine(engine, engine.builds[0], lay);
  return engine;
}

async function installFakePerModel() {
  const archive = await makeArchive('fake-model', { [SERVER_FILE]: await fs.readFile(FAKE_SERVER) });
  const engine = validateEngine({
    id: 'fakem',
    name: 'Fake per-model engine',
    version: 'v1',
    server: 'fake-server',
    models: 'fakem',
    health: '/health',
    args: ['--host', '{host}', '--port', '{port}', '--api-key-file', '{apiKeyFile}', '-m', '{model}'],
    builds: [{ os: process.platform, arch: process.arch, accel: 'cpu', files: [archive] }],
  }, 'test');
  await installEngine(engine, engine.builds[0], lay);
  return engine;
}

test('built-in engine catalog is valid and has a build for every desktop platform', async () => {
  const { engines } = await loadEngineCatalogs([BUILTIN]);
  const llama = engines.find((e) => e.id === 'llama');
  assert.ok(llama);
  for (const [os_, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['win32', 'x64'], ['win32', 'arm64'], ['darwin', 'arm64'], ['darwin', 'x64']]) {
    assert.ok(buildsFor(llama, { os: os_, arch }).length, `${os_} ${arch}`);
  }
  for (const b of llama.builds) for (const f of b.files) assert.match(f.url, /^https:\/\/github\.com\/ggml-org\/llama\.cpp\/releases\/download\//);
  assert.equal(llama.perModel, false);

  // stable-diffusion.cpp and whisper.cpp: Windows x64 and Linux x64 for now.
  const sd = engines.find((e) => e.id === 'sd');
  const whisper = engines.find((e) => e.id === 'whisper');
  assert.ok(sd && whisper);
  for (const engine of [sd, whisper]) {
    for (const [os_, arch] of [['linux', 'x64'], ['win32', 'x64']]) {
      assert.ok(buildsFor(engine, { os: os_, arch }).some((b) => b.accel === 'cpu'), `${engine.id} ${os_} ${arch}`);
    }
  }
  assert.equal(sd.perModel, false);
  assert.equal(whisper.perModel, true);
  const own = /^https:\/\/github\.com\/CrealikaCom\/engine-builds\/releases\/download\//;
  for (const b of whisper.builds) for (const f of b.files) assert.match(f.url, own);
  for (const b of sd.builds.filter((x) => x.os === 'linux')) for (const f of b.files) assert.match(f.url, own);
});

test('engine catalog: placeholders, api key, protocols and checksums are checked', () => {
  const file = { url: 'https://example.com/a.tar.gz', sha256: 'a'.repeat(64) };
  assert.ok(engineDef([file]));
  assert.throws(() => engineDef([file], { args: ['--port', '{port}'] }), /apiKey/);
  assert.equal(engineDef([file], { args: ['--api-key-file', '{apiKeyFile}'] }).perModel, false);
  assert.equal(engineDef([file], { args: ['--api-key-file', '{apiKeyFile}', '-m', '{model}'] }).perModel, true);
  assert.throws(() => engineDef([file], { args: ['--api-key', '{apiKey}', '{secret}'] }), /placeholder/);
  assert.throws(() => engineDef([{ ...file, url: 'http://example.com/a.tar.gz' }]), /protocol/);
  assert.throws(() => engineDef([{ ...file, sha256: 'x' }]), /sha256/);
  assert.throws(() => engineDef([{ ...file, url: 'https://example.com/a.exe' }]), /archive/);
});

test('user engine catalog replaces a built-in engine and lists external engines', async () => {
  const user = path.join(tmp, 'user-engines.json');
  const file = { url: 'https://example.com/a.tar.gz', sha256: 'b'.repeat(64) };
  await fs.writeFile(user, JSON.stringify({
    engines: [{ id: 'llama', name: 'Custom llama', version: 'x1', server: 'llama-server', models: 'llm', health: '/health', args: ['--api-key', '{apiKey}'], builds: [{ os: 'linux', arch: 'x64', accel: 'cpu', files: [file] }] }],
    external: [{ kind: 'ollama', url: 'http://192.168.1.5:11434/' }],
  }));
  const { engines, external } = await loadEngineCatalogs([BUILTIN, user, path.join(tmp, 'missing.json')]);
  assert.equal(engines.find((e) => e.id === 'llama').version, 'x1');
  assert.deepEqual(external, [{ kind: 'ollama', url: 'http://192.168.1.5:11434', name: null }]);
});

test('recommended build: Metal, then Vulkan when present, else CPU; never CUDA by default', () => {
  const b = (accel) => ({ accel });
  assert.equal(recommendedBuild([b('cpu'), b('vulkan'), b('cuda')], { vulkan: true, cuda: true }).accel, 'vulkan');
  assert.equal(recommendedBuild([b('cpu'), b('vulkan'), b('cuda')], { vulkan: false, cuda: true }).accel, 'cpu');
  assert.equal(recommendedBuild([b('metal')], { metal: true }).accel, 'metal');
  assert.equal(recommendedBuild([], {}), null);
});

test('accelerator detection by platform', async () => {
  const has = (files) => async (f) => files.includes(f);
  assert.deepEqual(await detectAccelerators({ platform: { os: 'darwin', arch: 'arm64' } }), { cpu: true, vulkan: false, cuda: false, metal: true });
  const linux = await detectAccelerators({ platform: { os: 'linux', arch: 'x64' }, exists: has(['/usr/lib64/libvulkan.so.1', '/proc/driver/nvidia/version']) });
  assert.equal(linux.vulkan, true);
  assert.equal(linux.cuda, true);
  const win = await detectAccelerators({ platform: { os: 'win32', arch: 'x64' }, env: { SystemRoot: 'D:\\Win' }, exists: has(['D:\\Win\\System32\\vulkan-1.dll']) });
  assert.equal(win.vulkan, true);
  assert.equal(win.cuda, false);
});

test('install merges the archives of a build, records it and keeps the old one on a bad checksum', async () => {
  const main = await makeArchive('main', { [`bin/${SERVER_FILE}`]: 'server', 'bin/lib.so': 'lib' });
  const extra = await makeArchive('extra', { 'bin/cudart.so': 'runtime' });
  const engine = engineDef([main, extra]);
  const progress = [];
  const marker = await installEngine(engine, engine.builds[0], lay, { onProgress: (p) => progress.push(p) });
  assert.equal(marker.server, `bin/${SERVER_FILE}`);
  assert.equal(marker.accel, 'cpu');
  assert.equal(await fs.readFile(path.join(lay.engines, 'fake', 'bin', 'cudart.so'), 'utf8'), 'runtime');
  assert.deepEqual(progress.at(-1), { received: main.size + extra.size, total: main.size + extra.size });
  assert.equal((await readInstalledEngine(lay, 'fake')).version, 'v1');
  assert.ok((await fs.stat(path.join(lay.models, 'fake'))).isDirectory(), 'the models folder is ready for the user');

  const broken = engineDef([{ ...main, sha256: '0'.repeat(64) }], { version: 'v2' });
  await assert.rejects(installEngine(broken, broken.builds[0], lay), /sha256/);
  assert.equal((await readInstalledEngine(lay, 'fake')).version, 'v1');
  assert.deepEqual((await fs.readdir(lay.cache)).filter((n) => n.startsWith('engine-')), []);

  const noServer = engineDef([extra], { version: 'v3' });
  await assert.rejects(installEngine(noServer, noServer.builds[0], lay), /fake-server(\.exe)? not found/);
  await uninstallEngine('fake', lay);
  assert.equal(await readInstalledEngine(lay, 'fake'), null);
});

test('acquire without the engine installed reports not_installed', async () => {
  const engine = engineDef([{ url: 'https://example.com/a.tar.gz', sha256: 'c'.repeat(64) }]);
  await assert.rejects(acquireEngine(lay, engine, { pid: process.pid, service: 'a' }), (err) => err instanceof EngineError && err.code === 'not_installed');
});

test('one engine process is shared by services and stops with its children after the last release', async () => {
  const engine = await installFake();
  const opts = { launch: launchNode, readyTimeoutMs: 15000 };
  const a = await acquireEngine(lay, engine, { pid: process.pid, service: 'alpha' }, opts);
  const b = await acquireEngine(lay, engine, { pid: process.pid, service: 'beta' }, opts);
  assert.equal(a.url, b.url);
  assert.equal(a.apiKey, b.apiKey);
  assert.equal(a.models, path.join(lay.models, 'fake'));

  const unauthorized = await fetch(new URL('/v1/models', a.url));
  assert.equal(unauthorized.status, 401);
  const models = await (await fetch(new URL('/v1/models', a.url), { headers: { authorization: `Bearer ${a.apiKey}` } })).json();
  assert.equal(models.data[0].id, 'fake-model');
  const childPid = Number(await fs.readFile(path.join(lay.models, 'fake', 'child.pid'), 'utf8'));

  const running = await listRunningEngines(lay);
  assert.deepEqual(running.get('fake').services, ['alpha', 'beta']);
  assert.equal('apiKey' in running.get('fake'), false);

  await releaseEngine(lay, 'fake', { pid: process.pid, service: 'alpha' });
  assert.ok(isAlive(models.pid));
  await releaseEngine(lay, 'fake', { pid: process.pid, service: 'beta' });
  assert.equal(isAlive(models.pid), false);
  assert.equal(await waitDead(childPid), true, 'the child of the engine is stopped too');
  assert.equal((await listRunningEngines(lay)).size, 0);
});

test('leases of hosts that died are dropped and the launcher stops the orphaned engine', async () => {
  const engine = await installFake();
  const gone = spawn(process.execPath, ['-e', '0']);
  await new Promise((resolve) => gone.on('exit', resolve));
  const info = await acquireEngine(lay, engine, { pid: gone.pid, service: 'crashed' }, { launch: launchNode, readyTimeoutMs: 15000 });
  const { pid } = await (await fetch(new URL('/v1/models', info.url), { headers: { authorization: `Bearer ${info.apiKey}` } })).json();
  await reapEngines(lay);
  assert.equal(isAlive(pid), false);
  assert.equal((await listRunningEngines(lay)).size, 0);
});

test('a crashed engine is started again on the next acquire', async () => {
  const engine = await installFake();
  const holder = { pid: process.pid, service: 'alpha' };
  const first = await acquireEngine(lay, engine, holder, { launch: launchNode, readyTimeoutMs: 15000 });
  const { pid } = await (await fetch(new URL('/v1/models', first.url), { headers: { authorization: `Bearer ${first.apiKey}` } })).json();
  // A crash of the engine and its children: the process group on Linux and macOS, the process
  // tree on Windows, which has no process groups.
  if (process.platform === 'win32') await stopProcess(pid);
  else process.kill(-pid, 'SIGKILL');
  await waitDead(pid);
  const second = await acquireEngine(lay, engine, holder, { launch: launchNode, readyTimeoutMs: 15000 });
  assert.notEqual(second.apiKey, first.apiKey);
  await releaseEngine(lay, 'fake', holder);
  assert.equal((await listRunningEngines(lay)).size, 0);
});

test('a per-model engine runs one process per model file, with the key in a file', async () => {
  const engine = await installFakePerModel();
  const dirModels = path.join(lay.models, 'fakem');
  await fs.mkdir(path.join(dirModels, 'sub'), { recursive: true });
  await fs.writeFile(path.join(dirModels, 'a.bin'), 'a');
  await fs.writeFile(path.join(dirModels, 'sub', 'b.bin'), 'b');
  const opts = (model) => ({ model, launch: launchNode, readyTimeoutMs: 15000 });
  const alpha = { pid: process.pid, service: 'alpha' };
  const beta = { pid: process.pid, service: 'beta' };

  await assert.rejects(acquireEngine(lay, engine, alpha, opts(null)), (err) => err.code === 'model_required');
  await assert.rejects(acquireEngine(lay, engine, alpha, opts('../../etc/passwd')), (err) => err.code === 'model_not_found');
  await assert.rejects(acquireEngine(lay, engine, alpha, opts('/etc/passwd')), (err) => err.code === 'model_not_found');
  await assert.rejects(acquireEngine(lay, engine, alpha, opts('missing.bin')), (err) => err.code === 'model_not_found');

  const a1 = await acquireEngine(lay, engine, alpha, opts('a.bin'));
  const a2 = await acquireEngine(lay, engine, beta, opts('./a.bin'));
  const b = await acquireEngine(lay, engine, alpha, opts('sub\\b.bin'));
  assert.equal(a1.url, a2.url, 'the same model is shared');
  assert.notEqual(a1.url, b.url, 'another model gets its own process');
  assert.equal(b.model, 'sub/b.bin');
  const ask = async (info) => (await fetch(new URL('/v1/models', info.url), { headers: { authorization: `Bearer ${info.apiKey}` } })).json();
  const ra = await ask(a1);
  const rb = await ask(b);
  assert.equal(ra.data[0].id, 'a.bin');
  assert.equal(rb.data[0].id, 'b.bin');
  assert.equal(ra.argv.includes(a1.apiKey), false, 'the key is not on the command line');
  const keyPath = ra.argv[ra.argv.indexOf('--api-key-file') + 1];
  // Windows has no POSIX modes; the key file stays in the user's own profile there.
  if (process.platform !== 'win32') assert.equal((await fs.stat(keyPath)).mode & 0o777, 0o600);

  const running = (await listRunningEngines(lay)).get('fakem');
  assert.deepEqual(running.instances.map((i) => i.model).sort(), ['a.bin', 'sub/b.bin']);
  assert.deepEqual(running.services.sort(), ['alpha', 'beta']);

  await releaseEngine(lay, a1.instance, alpha);
  assert.ok(isAlive(ra.pid), 'beta still uses a.bin');
  await releaseEngine(lay, a1.instance, beta);
  assert.equal(isAlive(ra.pid), false);
  await assert.rejects(fs.access(keyPath), 'the key file goes with the process');
  await releaseEngine(lay, b.instance, alpha);
  assert.equal(isAlive(rb.pid), false);
  assert.equal((await listRunningEngines(lay)).size, 0);
});

test('host engines: models for per-model engines, release by model or all at once', async () => {
  const engine = await installFakePerModel();
  const files = [path.join(tmp, 'host-engines-m.json')];
  await fs.writeFile(files[0], JSON.stringify({ engines: [{ ...engine, builds: engine.builds }] }));
  await fs.writeFile(path.join(lay.models, 'fakem', 'a.bin'), 'a');
  await fs.writeFile(path.join(lay.models, 'fakem', 'c.bin'), 'c');
  const host = createHostEngines({ lay, manifest: { id: 'svc', engines: ['fakem'] }, files });
  const list = await host.list();
  assert.equal(list.engines[0].perModel, true);
  await assert.rejects(host.acquire('svc', 'fakem'), (err) => err.code === 'model_required');
  // The host launches real processes here, so point the server at Node through a wrapper.
  const wrapper = path.join(lay.engines, 'fakem', SERVER_FILE);
  if (process.platform === 'win32') return;
  await fs.writeFile(wrapper, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_SERVER}" "$@"\n`);
  await fs.chmod(wrapper, 0o755);
  const a = await host.acquire('svc', 'fakem', { model: 'a.bin' });
  const c = await host.acquire('svc', 'fakem', { model: 'c.bin' });
  await host.release('svc', 'fakem', { model: 'a.bin' });
  const running = (await listRunningEngines(lay)).get('fakem');
  assert.deepEqual(running.instances.map((i) => i.model), ['c.bin']);
  await host.release('svc', 'fakem');
  assert.equal((await listRunningEngines(lay)).size, 0);
  assert.notEqual(a.url, c.url);
});

test('host engines: only engines from the manifest, unknown engines rejected', async () => {
  const files = [path.join(tmp, 'host-engines.json')];
  const engine = await installFake();
  await fs.writeFile(files[0], JSON.stringify({ engines: [{ ...engine, builds: engine.builds }] }));
  const host = createHostEngines({ lay, manifest: { id: 'other', engines: [] }, files });
  await assert.rejects(host.acquire('other', 'fake'), (err) => err.code === 'not_declared');
  await assert.rejects(host.acquire('other', 'nope'), (err) => err.code === 'unknown_engine');
  const list = await host.list();
  assert.deepEqual(list.engines.map((e) => [e.id, e.installed, e.declared]), [['fake', true, false]]);
});

test('host API: engine list, acquire and release, errors as statuses', async () => {
  const calls = [];
  const api = createLauncherApi({
    getSession: async () => ({}),
    getPaths: async () => ({}),
    engines: {
      list: async () => ({ engines: [{ id: 'llama' }], external: [] }),
      acquire: async (sid, id, options) => {
        calls.push(['acquire', sid, id, options]);
        if (id === 'missing') throw new EngineError('not_installed', 'install it');
        return { id, url: 'http://127.0.0.1:1', apiKey: 'k' };
      },
      release: async (sid, id, options) => {
        calls.push(['release', sid, id, options]);
        return { ok: true };
      },
    },
  });
  await api.start();
  api.register('tok', 'svc');
  const req = (p, method = 'GET', body = undefined) => fetch(api.url + p, { method, body, headers: { authorization: 'Bearer tok' } });
  try {
    assert.deepEqual(await (await req('/v1/engines')).json(), { engines: [{ id: 'llama' }], external: [] });
    assert.equal((await (await req('/v1/engines/llama/acquire', 'POST')).json()).apiKey, 'k');
    assert.equal((await req('/v1/engines/llama/acquire')).status, 405);
    const missing = await req('/v1/engines/missing/acquire', 'POST');
    assert.equal(missing.status, 409);
    assert.equal((await missing.json()).error, 'not_installed');
    assert.equal((await req('/v1/engines/llama/release', 'POST')).status, 200);
    assert.equal((await req('/v1/engines/Bad/acquire', 'POST')).status, 405);
    assert.equal((await req('/v1/engines/whisper/acquire', 'POST', JSON.stringify({ model: 'tiny.bin' }))).status, 200);
    assert.equal((await req('/v1/engines/whisper/acquire', 'POST', '{bad')).status, 400);
    assert.deepEqual(calls, [
      ['acquire', 'svc', 'llama', {}], ['acquire', 'svc', 'missing', {}], ['release', 'svc', 'llama', {}],
      ['acquire', 'svc', 'whisper', { model: 'tiny.bin' }],
    ]);
  } finally {
    await api.close();
  }
});

async function waitDead(pid, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}
