// Registry of running services: the service host writes run/<id>.json, the launcher reads it.
// Through the control address in that file the launcher checks that the service is alive,
// focuses its window and stops it, including after the launcher itself restarts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { ID_RE } from './manifest.js';

const file = (lay, id) => path.join(lay.run, `${id}.json`);

export async function writeRun(lay, info) {
  const tmp = `${file(lay, info.id)}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file(lay, info.id));
}

// Removes the entry only if it belongs to this host.
export async function removeRun(lay, id, hostPid) {
  const cur = await readRun(lay, id);
  if (cur && cur.hostPid === hostPid) await fs.rm(file(lay, id), { force: true });
}

export async function readRun(lay, id) {
  try {
    const info = JSON.parse(await fs.readFile(file(lay, id), 'utf8'));
    return info && info.id === id && typeof info.controlUrl === 'string' ? info : null;
  } catch {
    return null;
  }
}

// Live services; entries of dead hosts are removed.
export async function listRunning(lay) {
  const out = new Map();
  for (const name of await fs.readdir(lay.run)) {
    const id = name.endsWith('.json') ? name.slice(0, -5) : null;
    if (!id || !ID_RE.test(id)) continue;
    const info = await readRun(lay, id);
    if (info && (await control(info, 'ping', { timeoutMs: 1000 }))) out.set(id, info);
    else await fs.rm(file(lay, id), { force: true });
  }
  return out;
}

// POST /control/<action> to the host. true when the host answered 200.
export async function control(info, action, { timeoutMs = 3000 } = {}) {
  try {
    const res = await fetch(new URL(`/control/${action}`, info.controlUrl), {
      method: 'POST',
      headers: { authorization: `Bearer ${info.controlToken}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}
