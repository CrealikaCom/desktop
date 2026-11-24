// Crealika ID as a public OAuth client for an installed app (RFC 8252): the system browser
// signs in, the code comes back to a one-shot loopback listener, PKCE protects the exchange.
import http from 'node:http';
import * as oidc from 'openid-client';

export const DEFAULT_ISSUER = 'https://crealika.com/auth';
export const CLIENT_ID = 'desktop';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export class SignInError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code; // 'denied' | 'cancelled' | 'timeout' | 'failed'
  }
}

export function resolveIssuer(env = process.env) {
  return (env.CREALIKA_ID_ISSUER || DEFAULT_ISSUER).replace(/\/+$/, '');
}

export function createCrealikaId({ issuer, clientId = CLIENT_ID }) {
  const url = new URL(issuer);
  const insecure = url.protocol === 'http:';
  if (insecure && !LOOPBACK.has(url.hostname)) throw new Error(`Crealika ID issuer must use https: ${issuer}`);
  let configPromise = null;
  const config = () => {
    configPromise ??= oidc
      .discovery(url, clientId, undefined, oidc.None(), insecure ? { execute: [oidc.allowInsecureRequests] } : undefined)
      .catch((err) => {
        configPromise = null;
        throw err;
      });
    return configPromise;
  };

  return {
    issuer,

    async authorizationRequest(redirectUri) {
      const verifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const target = oidc.buildAuthorizationUrl(await config(), {
        redirect_uri: redirectUri,
        scope: 'openid profile offline_access',
        prompt: 'consent',
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        state,
        nonce,
      });
      return { url: target.href, verifier, state, nonce };
    },

    async exchange(callbackUrl, request) {
      const tokens = await oidc.authorizationCodeGrant(await config(), callbackUrl, {
        pkceCodeVerifier: request.verifier,
        expectedState: request.state,
        expectedNonce: request.nonce,
        idTokenExpected: true,
      });
      const claims = tokens.claims();
      return {
        tokens,
        user: {
          sub: claims.sub,
          username: claims.preferred_username ?? null,
          locale: claims.locale ?? null,
          theme: claims.theme ?? null,
        },
      };
    },

    async refresh(session) {
      return oidc.refreshTokenGrant(await config(), session.refreshToken);
    },

    async revoke(session) {
      await oidc.tokenRevocation(await config(), session.refreshToken, { token_type_hint: 'refresh_token' });
    },
  };
}

/**
 * Runs one browser sign-in: listens on 127.0.0.1 (free port), opens the authorization URL,
 * waits for the redirect and exchanges the code. onUrl receives the URL so the UI can offer
 * to open it again.
 */
export async function signInWithBrowser({ idp, openBrowser, onUrl, signal, timeoutMs = 10 * 60 * 1000 }) {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  let timer;
  let onAbort;
  try {
    const request = await idp.authorizationRequest(redirectUri);
    const callback = new Promise((resolve, reject) => {
      server.on('request', (req, res) => {
        const got = new URL(req.url, redirectUri);
        if (req.method !== 'GET' || got.pathname !== '/callback') {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(callbackPage(!got.searchParams.has('error')));
        resolve(got);
      });
      timer = setTimeout(() => reject(new SignInError('timeout', 'sign-in timed out')), timeoutMs);
      onAbort = () => reject(new SignInError('cancelled', 'sign-in was cancelled'));
      if (signal?.aborted) onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    onUrl?.(request.url);
    await openBrowser(request.url);
    const got = await callback;
    const error = got.searchParams.get('error');
    if (error) {
      throw new SignInError(error === 'access_denied' ? 'denied' : 'failed', got.searchParams.get('error_description') ?? error);
    }
    return await idp.exchange(got, request);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    server.closeAllConnections();
    server.close();
  }
}

function callbackPage(ok) {
  const text = ok
    ? 'You are signed in to Crealika Desktop. You can close this tab.'
    : 'Sign-in to Crealika Desktop was not completed. You can close this tab.';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Crealika Desktop</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh"><p>${text}</p></body></html>`;
}
