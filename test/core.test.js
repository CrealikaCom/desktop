// Launcher core without Electron or network: catalog, manifest, install, run, API.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLauncherApi } from '../launcher/core/api.js';
import { parseServiceArg } from '../launcher/core/args.js';
import { loadCatalogs } from '../launcher/core/catalog.js';
import { ensureHome, SUBDIRS } from '../launcher/core/home.js';
import { install, listInstalled, uninstall } from '../launcher/core/installer.js';
import { validateManifest } from '../launcher/core/manifest.js';
import { control, listRunning, readRun, removeRun, writeRun } from '../launcher/core/registry.js';
import { ServiceRunner } from '../launcher/core/runner.js';

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'echo');
let tmp, lay;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'crealika-desktop-test-'));
  lay = await ensureHome(path.join(tmp, 'home'));
});
after(() => fs.rm(tmp, { recursive: true, force: true }));

const entry = (source) => ({ id: 'echo', name: 'Echo', source });

test('home directory is created with all subdirectories', async () => {
  for (const d of SUBDIRS) assert.ok((await fs.stat(lay[d])).isDirectory(), d);
});

test('manifest: id, runtime and entry validation', () => {
  const ok = { id: 'echo', name: 'Echo', version: '1', runtime: 'node', entry: 'server.js' };
  assert.equal(validateManifest(ok).engines.length, 0);
  assert.throws(() => validateManifest({ ...ok, id: 'Echo' }), /id/);
  assert.throws(() => validateManifest({ ...ok, runtime: 'python' }), /runtime/);
  for (const bad of ['../x.js', '/abs.js', 'C:\\x.js', 'a/../../x.js']) {
    assert.throws(() => validateManifest({ ...ok, entry: bad }), /entry/, bad);
  }
});

test('user catalog overrides the built-in one by id', async () => {
  const builtin = path.join(tmp, 'builtin.json');
  const user = path.join(tmp, 'user', 'catalog.json');
  await fs.mkdir(path.dirname(user));
  await fs.writeFile(builtin, JSON.stringify({ services: [
    { id: 'echo', source: { type: 'git', url: 'ssh://git@example.com/echo.git' } },
    { id: 'other', source: { type: 'git', url: 'git@example.com:other.git', ref: 'v1.0' } },
  ] }));
  await fs.writeFile(user, JSON.stringify({ services: [{ id: 'echo', source: { type: 'dir', path: '../echo-src' } }] }));
  const list = await loadCatalogs([builtin, user, path.join(tmp, 'missing.json')]);
  assert.deepEqual(list.map((e) => [e.id, e.source.type]), [['echo', 'dir'], ['other', 'git']]);
  assert.equal(list[0].source.path, path.join(tmp, 'echo-src'));
  assert.equal(list[1].source.ref, 'v1.0');
  assert.equal(list[0].name, 'echo');
});

test('catalog rejects an unsafe ref and an archive without sha256', async () => {
  const f = path.join(tmp, 'bad.json');
  await fs.writeFile(f, JSON.stringify({ services: [{ id: 'x1', source: { type: 'git', url: 'x', ref: '--upload-pack=evil' } }] }));
  await assert.rejects(loadCatalogs([f]), /ref/);
  await fs.writeFile(f, JSON.stringify({ services: [{ id: 'x1', source: { type: 'archive', url: 'https://x/a.tgz' } }] }));
  await assert.rejects(loadCatalogs([f]), /sha256/);
});

test('install from a folder, reinstall and uninstall', async () => {
  assert.equal((await install(entry({ type: 'dir', path: fixture }), lay)).version, '1.0.0');
  assert.equal((await install(entry({ type: 'dir', path: fixture }), lay)).version, '1.0.0');
  assert.deepEqual([...(await listInstalled(lay)).keys()], ['echo']);
  await fs.writeFile(path.join(lay.data, 'keep.txt'), 'x');
  await uninstall('echo', lay);
  assert.equal((await listInstalled(lay)).size, 0);
  assert.equal(await fs.readFile(path.join(lay.data, 'keep.txt'), 'utf8'), 'x');
  assert.deepEqual(await fs.readdir(lay.cache), []);
});

test('install from a git repository by ref', async () => {
  const repo = path.join(tmp, 'echo-repo');
  await fs.cp(fixture, repo, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'empty');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'echo');
  git('tag', 'v1');
  const m = await install(entry({ type: 'git', url: repo, ref: 'v1' }), lay);
  assert.equal(m.id, 'echo');
  await assert.rejects(fs.access(path.join(lay.services, 'echo', '.git')));
  await assert.rejects(install(entry({ type: 'git', url: repo, ref: 'nope' }), lay), /git/);
  assert.equal((await listInstalled(lay)).get('echo').version, '1.0.0', 'a failed install keeps the previous one');
});

test('install from an archive verified by sha256', async () => {
  const tgz = path.join(tmp, 'echo.tar.gz');
  execFileSync('tar', ['-czf', tgz, '-C', path.dirname(fixture), 'echo']);
  const sha256 = createHash('sha256').update(await fs.readFile(tgz)).digest('hex');
  const url = new URL(`file://${tgz.replaceAll('\\', '/')}`).href;
  await assert.rejects(install(entry({ type: 'archive', url, sha256: '0'.repeat(64) }), lay), /sha256/);
  assert.equal((await install(entry({ type: 'archive', url, sha256 }), lay)).id, 'echo');
});

test('run: environment, host API token, log and stop', async () => {
  await install(entry({ type: 'dir', path: fixture }), lay);
  const api = createLauncherApi({
    getSession: async (id) => ({ mode: 'guest', user: null, asked: id }),
    getPaths: async () => ({}),
  });
  await api.start();
  const runner = new ServiceRunner({ layout: lay, api });
  try {
    const info = await runner.start('echo');
    assert.equal(info, await runner.start('echo'), 'starting again returns the same process');
    const body = await (await fetch(info.url)).json();
    assert.equal(body.sessionStatus, 200);
    assert.deepEqual(body.session, { mode: 'guest', user: null, asked: 'echo' });
    assert.equal(body.env.CREALIKA_OUTPUT_DIR, path.join(lay.output, 'echo'));
    assert.equal(body.env.CREALIKA_MODELS_DIR, lay.models);
    assert.ok((await fs.stat(path.join(lay.data, 'echo'))).isDirectory());
    assert.match(info.launchUrl, /\/crealika\/launch\?secret=/);

    const token = runner.get('echo').token;
    const asService = () => fetch(`${api.url}/v1/session`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal((await asService()).status, 200);
    assert.equal((await fetch(`${api.url}/v1/session`)).status, 401);

    await runner.stop('echo');
    assert.equal(runner.get('echo'), undefined);
    assert.equal((await asService()).status, 401, 'token of a stopped service is no longer valid');
    assert.match(await fs.readFile(path.join(lay.logs, 'echo.log'), 'utf8'), /starting…/);
  } finally {
    await runner.stopAll();
    await api.close();
  }
});

test('a service that dies before ready gives a clear error', async () => {
  const broken = path.join(tmp, 'broken');
  await fs.mkdir(broken);
  await fs.writeFile(path.join(broken, 'crealika-service.json'), JSON.stringify({ id: 'broken', name: 'B', version: '1', runtime: 'node', entry: 'main.js' }));
  await fs.writeFile(path.join(broken, 'main.js'), 'process.exit(3)');
  await install({ id: 'broken', source: { type: 'dir', path: broken } }, lay);
  const api = createLauncherApi({ getSession: async () => ({}), getPaths: async () => ({}) });
  await api.start();
  const runner = new ServiceRunner({ layout: lay, api });
  await assert.rejects(runner.start('broken'), /exited \(3\)/);
  assert.equal(runner.get('broken'), undefined);
  await api.close();
});

test('registry: host entry, ping, focus and stop through the control API', async () => {
  const actions = [];
  const api = createLauncherApi({
    getSession: async () => ({}),
    getPaths: async () => ({}),
    controlToken: 'ctl',
    onControl: (a) => actions.push(a),
  });
  await api.start();
  try {
    const info = { id: 'echo', hostPid: 4242, controlUrl: api.url, controlToken: 'ctl' };
    await writeRun(lay, info);
    assert.deepEqual([...(await listRunning(lay)).keys()], ['echo']);
    assert.equal(await control(info, 'focus'), true);
    assert.equal(await control({ ...info, controlToken: 'wrong' }, 'quit'), false);
    assert.equal(await control(info, 'nope'), false);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(actions.filter((a) => a !== 'ping'), ['focus']);

    // The control token does not open the service API, and vice versa.
    assert.equal((await fetch(`${api.url}/v1/session`, { headers: { authorization: 'Bearer ctl' } })).status, 401);

    await removeRun(lay, 'echo', 1);
    assert.ok(await readRun(lay, 'echo'), 'another host cannot remove the entry');
    await removeRun(lay, 'echo', 4242);
    assert.equal(await readRun(lay, 'echo'), null);
  } finally {
    await api.close();
  }
});

test('registry: entry of a dead host is removed on check', async () => {
  await writeRun(lay, { id: 'gone', hostPid: 1, controlUrl: 'http://127.0.0.1:9', controlToken: 'x' });
  assert.equal((await listRunning(lay)).size, 0);
  assert.equal(await readRun(lay, 'gone'), null);
});

test('startup mode comes from the --service argument', () => {
  const parse = parseServiceArg;
  assert.equal(parse(['electron', '.']), null);
  assert.equal(parse(['electron', '.', '--service', 'dummy']), 'dummy');
  assert.equal(parse(['app', '--service=dummy']), 'dummy');
});
