// Crealika ID session shared by the launcher and service hosts on top of SessionStore.
// The provider calls (refresh, revoke) are injected so the logic is testable offline.

export class SessionError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code; // 'signed_out' | 'expired' | 'unavailable'
  }
}

export const GUEST = Object.freeze({ mode: 'guest', user: null });

export function createSession({ store, refresh, revoke, now = Date.now, skewMs = 60000 }) {
  const fresh = (d) => d.accessToken && d.accessExpiresAt - skewMs > now();
  const token = (d) => ({ access_token: d.accessToken, expires_at: d.accessExpiresAt });

  return {
    /** What services see: guest, or the signed-in user identified by (issuer, sub). */
    async state() {
      const d = await store.read();
      return d ? { mode: 'signed-in', issuer: d.issuer, user: d.user } : GUEST;
    },

    /** A valid access token, refreshing it under the cross-process lock when needed. */
    async accessToken() {
      const cached = await store.read();
      if (!cached) throw new SessionError('signed_out');
      if (fresh(cached)) return token(cached);
      return store.withLock(async () => {
        const d = await store.read();
        if (!d) throw new SessionError('signed_out');
        if (fresh(d)) return token(d); // another process refreshed while we waited
        let t;
        try {
          t = await refresh(d);
        } catch (err) {
          if (err?.error === 'invalid_grant') {
            await store.write(null);
            throw new SessionError('expired', 'the Crealika ID sign-in has expired or was revoked');
          }
          throw new SessionError('unavailable', `Crealika ID is unavailable: ${err?.message ?? err}`);
        }
        const next = {
          ...d,
          refreshToken: t.refresh_token ?? d.refreshToken,
          accessToken: t.access_token,
          accessExpiresAt: now() + (t.expires_in ?? 0) * 1000,
        };
        await store.write(next);
        return token(next);
      }).catch((err) => {
        // A lock that never frees up (another process stuck refreshing) is an outage, not a bug.
        throw err instanceof SessionError ? err : new SessionError('unavailable', err.message);
      });
    },

    /** Stores a completed sign-in, replacing any previous account. */
    async signIn({ issuer, user, tokens }) {
      const data = {
        issuer,
        user,
        refreshToken: tokens.refresh_token,
        accessToken: tokens.access_token,
        accessExpiresAt: now() + (tokens.expires_in ?? 0) * 1000,
        signedInAt: new Date(now()).toISOString(),
      };
      const previous = await store.withLock(async () => {
        const old = await store.read();
        await store.write(data);
        return old;
      });
      if (previous && previous.refreshToken !== data.refreshToken) await revoke(previous).catch(() => {});
      return { mode: 'signed-in', issuer, user };
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
