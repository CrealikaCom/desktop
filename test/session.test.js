// Crealika ID session without Electron or network: shared store, cross-process refresh,
// browser sign-in over loopback and the host API token route.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createLauncherApi } from '../launcher/core/api.js';
import { SignInError, signInWithBrowser } from '../launcher/core/crealika-id.js';
import { createSession, GUEST, SessionError } from '../launcher/core/session.js';
import { SessionStore } from '../launcher/core/session-store.js';

let tmp;
before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'crealika-session-test-'));
});
after(() => fs.rm(tmp, { recursive: true, force: true }));

// "Encryption" that is visibly not plain text, so tests notice a missing encrypt call.
const codec = {
  encrypt: (text) => Buffer.from(text).reverse(),
  decrypt: (buf) => Buffer.from(buf).reverse().toString(),
};

async function stores(name, count = 1) {
  const dir = path.join(tmp, name);
  await fs.mkdir(dir);
  const opts = { file: path.join(dir, 'session'), lockFile: path.join(dir, 'lock'), ...codec };
  return Array.from({ length: count }, () => new SessionStore(opts));
}

const USER = { sub: 'u-1', username: 'artist', locale: 'en', theme: null };
const ISSUER = 'https://id.example.test/auth';

test('store: encrypted round trip, unreadable file means signed out', async () => {
  const [store] = await stores('roundtrip');
  assert.equal(await store.read(), null);
  await store.write({ a: 1 });
  assert.deepEqual(await store.read(), { a: 1 });
  assert.doesNotMatch(await fs.readFile(store.file, 'utf8'), /"a":1/);
  if (process.platform !== 'win32') assert.equal((await fs.stat(store.file)).mode & 0o777, 0o600);
  await fs.writeFile(store.file, 'garbage');
  assert.equal(await store.read(), null);
  await store.write(null);
  await assert.rejects(fs.access(store.file));
});

test('store: the lock serializes work across store instances and breaks stale locks', async () => {
  const [a, b] = await stores('lock', 2);
  let inside = 0;
  let overlap = false;
  const work = (s) => s.withLock(async () => {
    inside += 1;
    if (inside > 1) overlap = true;
    await new Promise((r) => setTimeout(r, 20));
    inside -= 1;
  });
  await Promise.all([work(a), work(b), work(a), work(b)]);
  assert.equal(overlap, false);

  await fs.writeFile(a.lockFile, '{}');
  const old = new Date(Date.now() - 60000);
  await fs.utimes(a.lockFile, old, old);
  assert.equal(await b.withLock(async () => 'ok'), 'ok');
});

test('session: two processes refresh an expired token once and share the result', async () => {
  const [a, b] = await stores('refresh', 2);
  let clock = 1_000_000;
  const presented = [];
  const refresh = async (d) => {
    presented.push(d.refreshToken);
    await new Promise((r) => setTimeout(r, 30));
    return { access_token: `at-${presented.length}`, refresh_token: `rt-${presented.length}`, expires_in: 600 };
  };
  const make = (store) => createSession({ store, refresh, revoke: async () => {}, now: () => clock });
  const one = make(a);
  const two = make(b);

  assert.deepEqual(await one.state(), GUEST);
  await assert.rejects(one.accessToken(), (e) => e instanceof SessionError && e.code === 'signed_out');

  await one.signIn({ issuer: ISSUER, user: USER, tokens: { access_token: 'at-0', refresh_token: 'rt-0', expires_in: 600 } });
  assert.deepEqual(await two.state(), { mode: 'signed-in', issuer: ISSUER, user: USER });
  assert.equal((await two.accessToken()).access_token, 'at-0', 'fresh token is reused');

  clock += 600 * 1000; // expired
  const [x, y] = await Promise.all([one.accessToken(), two.accessToken()]);
  assert.deepEqual(presented, ['rt-0'], 'the refresh token is presented exactly once');
  assert.equal(x.access_token, 'at-1');
  assert.equal(y.access_token, 'at-1');
  assert.equal((await a.read()).refreshToken, 'rt-1', 'the rotated refresh token is stored');
});

test('session: a revoked sign-in signs everyone out; an outage keeps the session', async () => {
  const [store] = await stores('revoked');
  let failure = { error: 'temporarily_unavailable', message: 'network down' };
  const session = createSession({
    store,
    refresh: async () => {
      throw failure;
    },
    revoke: async () => {},
    now: () => 0,
    skewMs: 0,
  });
  await session.signIn({ issuer: ISSUER, user: USER, tokens: { access_token: 'at', refresh_token: 'rt', expires_in: 0 } });
  await assert.rejects(session.accessToken(), (e) => e.code === 'unavailable');
  assert.equal((await session.state()).mode, 'signed-in', 'offline is not signed out');

  failure = { error: 'invalid_grant', message: 'revoked' };
  await assert.rejects(session.accessToken(), (e) => e.code === 'expired');
  assert.deepEqual(await session.state(), GUEST);
});

test('session: sign-out and account switch revoke the previous refresh token', async () => {
  const [store] = await stores('signout');
  const revoked = [];
  const session = createSession({
    store,
    refresh: async () => ({}),
    revoke: async (d) => {
      revoked.push(d.refreshToken);
      if (d.refreshToken === 'rt-b') throw new Error('offline');
    },
  });
  await session.signIn({ issuer: ISSUER, user: USER, tokens: { access_token: 'a', refresh_token: 'rt-a', expires_in: 60 } });
  await session.signIn({ issuer: ISSUER, user: { ...USER, sub: 'u-2' }, tokens: { access_token: 'b', refresh_token: 'rt-b', expires_in: 60 } });
  assert.deepEqual(revoked, ['rt-a']);
  assert.equal((await session.state()).user.sub, 'u-2');
  assert.deepEqual(await session.signOut(), GUEST, 'sign-out works even when revocation fails');
  assert.deepEqual(revoked, ['rt-a', 'rt-b']);
  assert.equal(await store.read(), null);
});

// Fake provider: the "browser" follows the authorization URL straight back to the app.
function fakeIdp({ error = null } = {}) {
  const calls = { exchanged: null };
  return {
    calls,
    idp: {
      issuer: ISSUER,
      async authorizationRequest(redirectUri) {
        const url = new URL('https://id.example.test/auth/authorize');
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('state', 'st-1');
        return { url: url.href, state: 'st-1' };
      },
      async exchange(callbackUrl, request) {
        calls.exchanged = { callbackUrl: callbackUrl.href, state: request.state };
        return { tokens: { access_token: 'at' }, user: USER };
      },
    },
    browser: async (authUrl) => {
      const redirect = new URL(new URL(authUrl).searchParams.get('redirect_uri'));
      assert.equal(redirect.hostname, '127.0.0.1');
      assert.equal((await fetch(new URL('/favicon.ico', redirect))).status, 404);
      if (error) redirect.searchParams.set('error', error);
      else redirect.searchParams.set('code', 'code-1');
      redirect.searchParams.set('state', 'st-1');
      const page = await fetch(redirect);
      assert.match(await page.text(), /close this tab/);
    },
  };
}

test('browser sign-in: code comes back to the loopback listener and is exchanged', async () => {
  const fake = fakeIdp();
  let shown = null;
  const result = await signInWithBrowser({
    idp: fake.idp,
    openBrowser: (url) => fake.browser(url),
    onUrl: (url) => {
      shown = url;
    },
  });
  assert.deepEqual(result.user, USER);
  assert.match(shown, /authorize/);
  const back = new URL(fake.calls.exchanged.callbackUrl);
  assert.equal(back.searchParams.get('code'), 'code-1');
  assert.equal(back.pathname, '/callback');
});

test('browser sign-in: denial, cancellation and timeout', async () => {
  const denied = fakeIdp({ error: 'access_denied' });
  await assert.rejects(
    signInWithBrowser({ idp: denied.idp, openBrowser: (url) => denied.browser(url) }),
    (e) => e instanceof SignInError && e.code === 'denied',
  );

  const abort = new AbortController();
  const pending = signInWithBrowser({ idp: fakeIdp().idp, openBrowser: async () => abort.abort(), signal: abort.signal });
  await assert.rejects(pending, (e) => e.code === 'cancelled');

  await assert.rejects(
    signInWithBrowser({ idp: fakeIdp().idp, openBrowser: async () => {}, timeoutMs: 50 }),
    (e) => e.code === 'timeout',
  );
});

test('host API: /v1/token maps session errors to status codes', async () => {
  let failure = null;
  const api = createLauncherApi({
    getSession: async () => GUEST,
    getPaths: async () => ({}),
    getToken: async () => {
      if (failure) throw new SessionError(failure);
      return { access_token: 'at', expires_at: 1 };
    },
  });
  await api.start();
  api.register('svc', 'echo');
  const get = () => fetch(`${api.url}/v1/token`, { headers: { authorization: 'Bearer svc' } });
  try {
    assert.deepEqual(await (await get()).json(), { access_token: 'at', expires_at: 1 });
    for (const [code, status] of [['signed_out', 401], ['expired', 401], ['unavailable', 503]]) {
      failure = code;
      const res = await get();
      assert.equal(res.status, status, code);
      assert.equal((await res.json()).error, code);
    }
  } finally {
    await api.close();
  }
});

test('session: a lock held by a stuck process reads as unavailable', async () => {
  const dir = path.join(tmp, 'stuck');
  await fs.mkdir(dir);
  const store = new SessionStore({ file: path.join(dir, 'session'), lockFile: path.join(dir, 'lock'), lockTimeoutMs: 100, ...codec });
  const session = createSession({ store, refresh: async () => ({}), revoke: async () => {}, now: () => 0, skewMs: 0 });
  await store.write({ issuer: ISSUER, user: USER, refreshToken: 'rt', accessToken: 'at', accessExpiresAt: 0 });
  await fs.writeFile(store.lockFile, '{}');
  await assert.rejects(session.accessToken(), (e) => e instanceof SessionError && e.code === 'unavailable');
});
