// Catalog of shared engines (llama.cpp and later others): pinned versions and prebuilt archives
// per operating system, CPU architecture and accelerator. The built-in engines.json is extended
// by <home>/config/engines.json: an engine with the same id replaces the built-in one, and
// "external" lists addresses of engines the user runs themselves (Ollama, LM Studio, ComfyUI).
import fs from 'node:fs/promises';
import path from 'node:path';
import { ID_RE } from './manifest.js';

export const ACCELERATORS = ['cpu', 'vulkan', 'cuda', 'metal'];
export const ACCEL_NAMES = { cpu: 'CPU', vulkan: 'Vulkan (GPU)', cuda: 'CUDA (NVIDIA)', metal: 'Metal (Apple GPU)' };
const OS = new Set(['linux', 'win32', 'darwin']);
const ARCH = new Set(['x64', 'arm64']);
const SHA256_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PLACEHOLDERS = new Set(['host', 'port', 'apiKey', 'models']);

export function validateEngine(e, where) {
  if (!ID_RE.test(e?.id ?? '')) throw new Error(`${where}: invalid engine id ${JSON.stringify(e?.id)}`);
  where = `${where}: ${e.id}`;
  if (!VERSION_RE.test(e.version ?? '')) throw new Error(`${where}: invalid version`);
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(e.server ?? '')) throw new Error(`${where}: invalid server name`);
  if (!ID_RE.test(e.models ?? '')) throw new Error(`${where}: invalid models folder`);
  if (typeof e.health !== 'string' || !e.health.startsWith('/')) throw new Error(`${where}: health must be a path`);
  if (!Array.isArray(e.args) || !e.args.every((a) => typeof a === 'string')) throw new Error(`${where}: args must be strings`);
  for (const a of e.args) {
    for (const [, name] of a.matchAll(/\{(\w+)\}/g)) {
      if (!PLACEHOLDERS.has(name)) throw new Error(`${where}: unknown placeholder {${name}}`);
    }
  }
  if (!e.args.some((a) => a.includes('{apiKey}'))) throw new Error(`${where}: args must pass {apiKey}`);
  if (!Array.isArray(e.builds)) throw new Error(`${where}: missing builds`);
  const seen = new Set();
  const builds = e.builds.map((b) => {
    if (!OS.has(b?.os) || !ARCH.has(b.arch) || !ACCELERATORS.includes(b.accel)) {
      throw new Error(`${where}: invalid build ${JSON.stringify([b?.os, b?.arch, b?.accel])}`);
    }
    const key = `${b.os}-${b.arch}-${b.accel}`;
    if (seen.has(key)) throw new Error(`${where}: duplicate build ${key}`);
    seen.add(key);
    if (!Array.isArray(b.files) || !b.files.length) throw new Error(`${where}: build ${key} has no files`);
    const files = b.files.map((f) => {
      const url = new URL(f?.url ?? '');
      if (!['https:', 'file:'].includes(url.protocol)) throw new Error(`${where}: ${key}: unsupported protocol ${url.protocol}`);
      if (!/\.(tar\.gz|tgz|zip)$/.test(url.pathname)) throw new Error(`${where}: ${key}: expected a .tar.gz or .zip archive`);
      if (!SHA256_RE.test(f.sha256 ?? '')) throw new Error(`${where}: ${key}: sha256 required`);
      return { url: url.href, sha256: f.sha256, size: Number.isInteger(f.size) && f.size > 0 ? f.size : null };
    });
    return { os: b.os, arch: b.arch, accel: b.accel, files };
  });
  return {
    id: e.id,
    name: typeof e.name === 'string' && e.name ? e.name : e.id,
    description: typeof e.description === 'string' ? e.description : '',
    version: e.version,
    server: e.server,
    models: e.models,
    health: e.health,
    args: [...e.args],
    builds,
  };
}

// Built-in file first, then the user's; missing files are skipped.
export async function loadEngineCatalogs(files) {
  const byId = new Map();
  const external = [];
  for (const file of files) {
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw new Error(`${file}: ${err.message}`);
    }
    for (const e of raw.engines ?? []) byId.set(e?.id, validateEngine(e, file));
    for (const x of raw.external ?? []) external.push(validateExternal(x, file));
  }
  return { engines: [...byId.values()], external };
}

function validateExternal(x, where) {
  if (!['ollama', 'lmstudio', 'comfyui', 'openai'].includes(x?.kind)) throw new Error(`${where}: external kind must be ollama, lmstudio, comfyui or openai`);
  const url = new URL(x.url ?? '');
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${where}: external url must be http or https`);
  return { kind: x.kind, url: url.origin, name: typeof x.name === 'string' && x.name ? x.name : null };
}

export function currentPlatform() {
  return { os: process.platform, arch: process.arch };
}

export function buildsFor(engine, platform) {
  return engine.builds.filter((b) => b.os === platform.os && b.arch === platform.arch);
}

// The build to install when the user has not chosen one: the GPU build that should work without
// extra downloads (Metal, else Vulkan), else CPU. CUDA is large and only installed when chosen.
export function recommendedBuild(builds, detected) {
  for (const accel of ['metal', 'vulkan', 'cpu']) {
    const b = builds.find((x) => x.accel === accel);
    if (b && (accel === 'cpu' || detected[accel])) return b;
  }
  return builds[0] ?? null;
}

// What this computer offers. Vulkan: the system loader is present (GPU drivers ship it);
// CUDA: an NVIDIA driver is installed; Metal: Apple Silicon.
export async function detectAccelerators({ platform = currentPlatform(), env = process.env, exists = fileExists } = {}) {
  const out = { cpu: true, vulkan: false, cuda: false, metal: false };
  if (platform.os === 'darwin') {
    out.metal = platform.arch === 'arm64';
    return out;
  }
  if (platform.os === 'win32') {
    const sys = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32');
    out.vulkan = await exists(path.win32.join(sys, 'vulkan-1.dll'));
    out.cuda = await exists(path.win32.join(sys, 'nvcuda.dll'));
    return out;
  }
  const libDirs = ['/usr/lib/x86_64-linux-gnu', '/usr/lib/aarch64-linux-gnu', '/usr/lib64', '/usr/lib', '/lib/x86_64-linux-gnu', '/lib64'];
  for (const dir of libDirs) {
    if (await exists(path.join(dir, 'libvulkan.so.1'))) {
      out.vulkan = true;
      break;
    }
  }
  out.cuda = await exists('/proc/driver/nvidia/version');
  return out;
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
