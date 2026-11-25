// Interface preferences shared through <home>/config/preferences.json and the host API.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createLauncherApi } from '../launcher/core/api.js';
import { createPreferences, DEFAULTS, normalizePreferences, themeSource } from '../launcher/core/preferences.js';

test('normalizePreferences keeps valid values and falls back for the rest', () => {
  assert.deepEqual(normalizePreferences({ locale: 'en', theme: 'dark' }), { locale: 'en', theme: 'dark' });
  assert.deepEqual(normalizePreferences({ locale: 'xx', theme: 'Bad Theme' }), DEFAULTS);
  assert.deepEqual(normalizePreferences(null), DEFAULTS);
  assert.deepEqual(normalizePreferences({ theme: 'light' }, { locale: 'en', theme: 'dark' }), { locale: 'en', theme: 'light' });
});

test('themeSource maps a theme choice to Electron nativeTheme', () => {
  assert.equal(themeSource('light'), 'light');
  assert.equal(themeSource('dark'), 'dark');
  assert.equal(themeSource('system'), 'system');
  assert.equal(themeSource('sepia'), 'system', 'unknown themes follow the system');
});

test('preferences file: defaults, partial updates, broken file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crealika-prefs-'));
  try {
    const prefs = createPreferences({ config: dir });
    assert.deepEqual(await prefs.read(), DEFAULTS);
    assert.deepEqual(await prefs.write({ theme: 'dark' }), { locale: 'en', theme: 'dark' });
    assert.deepEqual(await prefs.write({ locale: 'en' }), { locale: 'en', theme: 'dark' }, 'a partial update keeps the theme');
    assert.deepEqual(JSON.parse(await fs.readFile(prefs.file, 'utf8')), { locale: 'en', theme: 'dark' });
    await fs.writeFile(prefs.file, '{oops');
    assert.deepEqual(await prefs.read(), DEFAULTS);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('host API: GET and PUT /v1/preferences', async () => {
  let stored = { locale: 'en', theme: 'system' };
  const api = createLauncherApi({
    getSession: async () => ({}),
    getPaths: async () => ({}),
    getPreferences: async () => stored,
    setPreferences: async (_id, update) => {
      stored = normalizePreferences(update, stored);
      return stored;
    },
  });
  await api.start();
  api.register('svc', 'echo');
  const auth = { authorization: 'Bearer svc' };
  try {
    assert.deepEqual(await (await fetch(`${api.url}/v1/preferences`, { headers: auth })).json(), stored);
    const put = await fetch(`${api.url}/v1/preferences`, { method: 'PUT', headers: { ...auth, 'content-type': 'application/json' }, body: '{"theme":"dark"}' });
    assert.deepEqual(await put.json(), { locale: 'en', theme: 'dark' });
    assert.equal((await fetch(`${api.url}/v1/preferences`, { method: 'PUT', headers: auth, body: '{oops' })).status, 400);
    assert.equal((await fetch(`${api.url}/v1/preferences`, { method: 'DELETE', headers: auth })).status, 405);
    assert.equal((await fetch(`${api.url}/v1/preferences`)).status, 401);
  } finally {
    await api.close();
  }
});
