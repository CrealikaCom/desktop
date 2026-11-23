// Test service: returns the environment it received and the host API response.
import http from 'node:http';

const server = http.createServer(async (req, res) => {
  const r = await fetch(new URL('/v1/session', process.env.CREALIKA_LAUNCHER_URL), {
    headers: { authorization: `Bearer ${process.env.CREALIKA_LAUNCHER_TOKEN}` },
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('CREALIKA_')));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ env, sessionStatus: r.status, session: await r.json() }));
});
server.listen(0, '127.0.0.1', () => {
  console.log('starting…');
  console.log(`CREALIKA_READY ${JSON.stringify({ port: server.address().port })}`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
