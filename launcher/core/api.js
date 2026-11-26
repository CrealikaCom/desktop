// Local API of the service host process.
// Listens on 127.0.0.1 only. Two kinds of tokens:
// - service token: the service backend asks for the session, an access token, paths, the
//   interface preferences and shared engines (/v1/...);
// - control token: the launcher pings, focuses and stops the service (/control/...).
import http from 'node:http';

const TOKEN_ERRORS = { signed_out: 401, expired: 401, not_granted: 403, unavailable: 503 };
const ENGINE_ERRORS = { unknown_engine: 404, not_declared: 403, not_installed: 409, start_failed: 503 };
const ENGINE_PATH = /^\/v1\/engines\/([a-z][a-z0-9-]{1,31})\/(acquire|release)$/;

export function createLauncherApi({
  getSession, getPaths, getToken = null, getPreferences = null, setPreferences = null, controlToken = null, onControl = null,
  engines = null,
}) {
  const tokens = new Map(); // token -> service id
  let server = null;
  let url = null;

  async function handle(req, res) {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '');
    const { pathname, searchParams } = new URL(req.url, 'http://127.0.0.1');

    if (pathname.startsWith('/control/')) {
      if (!controlToken || !onControl || !m || m[1] !== controlToken) return send(res, 401, { error: 'unauthorized' });
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      const action = pathname.slice('/control/'.length);
      if (!['ping', 'focus', 'quit'].includes(action)) return send(res, 404, { error: 'not_found' });
      send(res, 200, { ok: true });
      // Reply before acting: after quit the server closes.
      setImmediate(() => onControl(action));
      return;
    }

    const serviceId = m && tokens.get(m[1]);
    if (!serviceId) return send(res, 401, { error: 'unauthorized' });
    if (pathname === '/v1/preferences' && getPreferences) {
      if (req.method === 'GET') return send(res, 200, await getPreferences(serviceId));
      if (req.method === 'PUT' && setPreferences) {
        let body;
        try {
          body = await readJson(req);
        } catch {
          return send(res, 400, { error: 'bad_request' });
        }
        return send(res, 200, await setPreferences(serviceId, body));
      }
      return send(res, 405, { error: 'method_not_allowed' });
    }
    const engineAction = ENGINE_PATH.exec(pathname);
    if (engineAction && engines) {
      if (req.method !== 'POST') return send(res, 405, { error: 'method_not_allowed' });
      const [, engineId, action] = engineAction;
      try {
        return send(res, 200, action === 'acquire' ? await engines.acquire(serviceId, engineId) : await engines.release(serviceId, engineId));
      } catch (err) {
        const status = ENGINE_ERRORS[err.code];
        if (!status) throw err;
        return send(res, status, { error: err.code, message: err.message });
      }
    }
    if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
    if (pathname === '/v1/engines' && engines) return send(res, 200, await engines.list(serviceId));
    if (pathname === '/v1/session') return send(res, 200, await getSession(serviceId));
    if (pathname === '/v1/paths') return send(res, 200, await getPaths(serviceId));
    if (pathname === '/v1/token') {
      if (!getToken) return send(res, 401, { error: 'signed_out' });
      try {
        return send(res, 200, await getToken(serviceId, searchParams.get('resource') || undefined));
      } catch (err) {
        const status = TOKEN_ERRORS[err.code];
        if (!status) throw err;
        return send(res, status, { error: err.code, message: err.message });
      }
    }
    return send(res, 404, { error: 'not_found' });
  }

  return {
    get url() {
      return url;
    },
    async start() {
      server = http.createServer((req, res) => {
        handle(req, res).catch((err) => send(res, 500, { error: 'internal', message: String(err.message ?? err) }));
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      url = `http://127.0.0.1:${server.address().port}`;
      return url;
    },
    register(token, serviceId) {
      tokens.set(token, serviceId);
    },
    unregister(token) {
      tokens.delete(token);
    },
    async close() {
      if (server) {
        const closed = new Promise((resolve) => server.close(resolve));
        server.closeAllConnections();
        await closed;
      }
      server = null;
    },
  };
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = 16 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
