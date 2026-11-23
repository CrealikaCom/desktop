// Shared Crealika home directory on the user's disk.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const SUBDIRS = ['services', 'engines', 'models', 'output', 'data', 'cache', 'logs', 'config', 'run'];

export function resolveHome(env = process.env) {
  return path.resolve(env.CREALIKA_HOME || path.join(os.homedir(), 'Crealika'));
}

export function layout(home) {
  return Object.fromEntries([['home', home], ...SUBDIRS.map((d) => [d, path.join(home, d)])]);
}

export async function ensureHome(home) {
  const lay = layout(home);
  for (const d of SUBDIRS) await fs.mkdir(lay[d], { recursive: true });
  return lay;
}

// Per-service directories: private data and a subdirectory of the shared output.
export async function ensureServiceDirs(lay, id) {
  const dirs = { data: path.join(lay.data, id), output: path.join(lay.output, id) };
  for (const d of Object.values(dirs)) await fs.mkdir(d, { recursive: true });
  return dirs;
}
