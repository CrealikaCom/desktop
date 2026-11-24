// Shared, encrypted Crealika ID session file used by the launcher and every service host.
// Encryption is injected (Electron safeStorage in the app, identity in tests). A lock file
// serializes token refreshes across processes: two processes must never present the same
// refresh token, because Crealika ID treats reuse as theft and revokes the sign-in.
import fs from 'node:fs/promises';
import path from 'node:path';

export class SessionStore {
  constructor({ file, lockFile, encrypt, decrypt, staleLockMs = 60000, lockTimeoutMs = 15000 }) {
    this.file = file;
    this.lockFile = lockFile;
    this.encrypt = encrypt;
    this.decrypt = decrypt;
    this.staleLockMs = staleLockMs;
    this.lockTimeoutMs = lockTimeoutMs;
  }

  async read() {
    let raw;
    try {
      raw = await fs.readFile(this.file);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    try {
      return JSON.parse(this.decrypt(raw));
    } catch {
      // Unreadable (other OS user, keyring changed): treat as signed out.
      return null;
    }
  }

  async write(data) {
    if (data === null) {
      await fs.rm(this.file, { force: true });
      return;
    }
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, this.encrypt(JSON.stringify(data)), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  async withLock(fn) {
    const deadline = Date.now() + this.lockTimeoutMs;
    for (;;) {
      try {
        const handle = await fs.open(this.lockFile, 'wx', 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
        await handle.close();
        break;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        await this.#breakStaleLock();
        if (Date.now() > deadline) throw new Error('session lock timeout');
        await new Promise((resolve) => setTimeout(resolve, 50 + Math.random() * 100));
      }
    }
    try {
      return await fn();
    } finally {
      await fs.rm(this.lockFile, { force: true });
    }
  }

  async #breakStaleLock() {
    try {
      const { mtimeMs } = await fs.stat(this.lockFile);
      if (Date.now() - mtimeMs > this.staleLockMs) await fs.rm(this.lockFile, { force: true });
    } catch {
      // Lock disappeared meanwhile.
    }
  }
}
