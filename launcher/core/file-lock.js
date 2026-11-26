// Cross-process lock on a file created with O_EXCL. Used by the Crealika ID session store and
// by shared engines: the launcher and every service host are separate processes.
// A lock older than staleMs belongs to a crashed process and is removed.
import fs from 'node:fs/promises';

export async function withFileLock(lockFile, fn, { staleMs = 60000, timeoutMs = 15000, what = 'lock' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const handle = await fs.open(lockFile, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      await handle.close();
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      await breakStaleLock(lockFile, staleMs);
      if (Date.now() > deadline) throw new Error(`${what} timeout`);
      await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockFile, { force: true });
  }
}

async function breakStaleLock(lockFile, staleMs) {
  try {
    const { mtimeMs } = await fs.stat(lockFile);
    if (Date.now() - mtimeMs > staleMs) await fs.rm(lockFile, { force: true });
  } catch {
    // The lock disappeared meanwhile.
  }
}
