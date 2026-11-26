// Stand-in for an engine server in tests: answers /health without a key and /v1/models with it,
// and starts a child process like llama.cpp does in router mode, to check that stopping the engine
// stops its children too. Writes the child's pid to <models>/child.pid.
// Takes the key as --api-key or --api-key-file, and either --models-dir (models on request) or
// -m <model file> (one model per process, like whisper.cpp).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const port = Number(arg('--port'));
const key = arg('--api-key') ?? fs.readFileSync(arg('--api-key-file'), 'utf8').trim();
const model = arg('-m');
const models = arg('--models-dir') ?? path.dirname(model);

const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
fs.writeFileSync(path.join(models, model ? `child-${path.basename(model)}.pid` : 'child.pid'), String(child.pid));

http.createServer((req, res) => {
  if (req.url === '/health') return res.end('{"status":"ok"}');
  if (req.headers.authorization !== `Bearer ${key}`) {
    res.writeHead(401);
    return res.end();
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ data: [{ id: model ? path.basename(model) : 'fake-model' }], pid: process.pid, argv: process.argv.slice(2) }));
}).listen(port, '127.0.0.1');
