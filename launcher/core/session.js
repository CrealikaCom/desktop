// Crealika ID session shared by the launcher and service hosts on top of SessionStore.
// The provider calls (refresh, revoke) are injected so the logic is testable offline.
//
// Access tokens are kept per resource: '' is the token for Crealika ID itself (UserInfo), and
// each Crealika service API granted at sign-in (RFC 8707) gets its own token with that audience.

export class SessionError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code; // 'signed_out' | 'expired' | 'not_granted' | 'unavailable'
  }
}

export const GUEST = Object.freeze({ mode: 'guest', user: null, resources: [] });

export function createSession({ store, refresh, revoke, now = Date.now, skewMs = 60000 }) {
  const entry = (d, resource) =>
    d.tokens?.[resource] ?? (resource === '' && d.accessToken ? { accessToken: d.accessToken, expiresAt: d.accessExpiresAt } : null);
  const fresh = (e) => e && e.expiresAt - skewMs > now();
  const token = (e) => ({ access_token: e.accessToken, expires_at: e.expiresAt });
  const granted = (d, resource) => resource === '' || (d.resources ?? []).includes(resource);

  return {
    /** What services see: guest, or the signed-in user identified by (issuer, sub). */
    async state() {
      const d = await store.read();
      return d ? { mode: 'signed-in', issuer: d.issuer, user: d.user, resources: d.resources ?? [] } : GUEST;
    },

    /**
     * A valid access token for a resource ('' for Crealika ID itself), refreshing it under the
     * cross-process lock when needed.
     */
    async accessToken(resource = '') {
      const cached = await store.read();
      if (!cached) throw new SessionError('signed_out');
      if (!granted(cached, resource)) {
        throw new SessionError('not_granted', `this sign-in has no access to ${resource}; sign in again`);
      }
      if (fresh(entry(cached, resource))) return token(entry(cached, resource));
      return store.withLock(async () => {
        const d = await store.read();
        if (!d) throw new SessionError('signed_out');
        if (fresh(entry(d, resource))) return token(entry(d, resource)); // another process refreshed meanwhile
        let t;
        try {
          t = await refresh(d, resource || undefined);
        } catch (err) {
          if (err?.error === 'invalid_grant') {
            await store.write(null);
            throw new SessionError('expired', 'the Crealika ID sign-in has expired or was revoked');
          }
          if (err?.error === 'invalid_target') {
            throw new SessionError('not_granted', `Crealika ID refused a token for ${resource}; sign in again`);
          }
          throw new SessionError('unavailable', `Crealika ID is unavailable: ${err?.message ?? err}`);
        }
        const e = { accessToken: t.access_token, expiresAt: now() + (t.expires_in ?? 0) * 1000 };
        const { accessToken: _a, accessExpiresAt: _b, ...rest } = d;
        const next = {
          ...rest,
          refreshToken: t.refresh_token ?? d.refreshToken,
          tokens: { ...legacyTokens(d), ...d.tokens, [resource]: e },
        };
        await store.write(next);
        return token(e);
      }).catch((err) => {
        // A lock that never frees up (another process stuck refreshing) is an outage, not a bug.
        throw err instanceof SessionError ? err : new SessionError('unavailable', err.message);
      });
    },

    /** Stores a completed sign-in, replacing any previous account. */
    async signIn({ issuer, user, tokens, resources = [] }) {
      const data = {
        issuer,
        user,
        resources,
        refreshToken: tokens.refresh_token,
        tokens: { '': { accessToken: tokens.access_token, expiresAt: now() + (tokens.expires_in ?? 0) * 1000 } },
        signedInAt: new Date(now()).toISOString(),
      };
      const previous = await store.withLock(async () => {
        const old = await store.read();
        await store.write(data);
        return old;
      });
      if (previous && previous.refreshToken !== data.refreshToken) await revoke(previous).catch(() => {});
      return { mode: 'signed-in', issuer, user, resources };
    },

    /** Forgets the session everywhere and revokes the refresh token (best effort, offline-safe). */
    async signOut() {
      const previous = await store.withLock(async () => {
        const old = await store.read();
        await store.write(null);
        return old;
      });
      if (previous) await revoke(previous).catch(() => {});
      return GUEST;
    },
  };
}

// Sessions written before per-resource tokens kept a single token at the top level.
function legacyTokens(d) {
  return d.accessToken ? { '': { accessToken: d.accessToken, expiresAt: d.accessExpiresAt } } : {};
}
