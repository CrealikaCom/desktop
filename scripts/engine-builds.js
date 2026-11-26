// Prints the builds of an engine release for engines.json, with sizes and sha256 digests taken
// from the GitHub releases:
//   node scripts/engine-builds.js llama b12751
//   node scripts/engine-builds.js sd master-1133-52491bd
//   node scripts/engine-builds.js whisper b5907
// Only the platforms and accelerators the launcher offers are listed. Builds come from the
// engine's own releases where they fit, and from CrealikaCom/engine-builds where they do not
// (stable-diffusion.cpp for Linux, whisper.cpp everywhere).
const OURS = 'CrealikaCom/engine-builds';

// sd.cpp tags look like master-1133-52491bd, its file names like sd-master-52491bd-bin-...
const sdName = (v) => v.replace(/^master-\d+-/, 'master-');

const RULES = {
  llama: {
    releases: { upstream: ['ggml-org/llama.cpp', (v) => v] },
    builds: [
      ['linux', 'x64', 'cpu', [['upstream', (v) => `llama-${v}-bin-ubuntu-x64.tar.gz`]]],
      ['linux', 'x64', 'vulkan', [['upstream', (v) => `llama-${v}-bin-ubuntu-vulkan-x64.tar.gz`]]],
      ['linux', 'x64', 'cuda', [
        ['upstream', (v) => `llama-${v}-bin-ubuntu-cuda-12.8-x64.tar.gz`],
        ['upstream', (v) => `cudart-llama-${v}-bin-ubuntu-cuda-12.8-x64.tar.gz`],
      ]],
      ['linux', 'arm64', 'cpu', [['upstream', (v) => `llama-${v}-bin-ubuntu-arm64.tar.gz`]]],
      ['linux', 'arm64', 'vulkan', [['upstream', (v) => `llama-${v}-bin-ubuntu-vulkan-arm64.tar.gz`]]],
      ['win32', 'x64', 'cpu', [['upstream', (v) => `llama-${v}-bin-win-cpu-x64.zip`]]],
      ['win32', 'x64', 'vulkan', [['upstream', (v) => `llama-${v}-bin-win-vulkan-x64.zip`]]],
      ['win32', 'x64', 'cuda', [
        ['upstream', (v) => `llama-${v}-bin-win-cuda-12.4-x64.zip`],
        ['upstream', () => 'cudart-llama-bin-win-cuda-12.4-x64.zip'],
      ]],
      ['win32', 'arm64', 'cpu', [['upstream', (v) => `llama-${v}-bin-win-cpu-arm64.zip`]]],
      ['win32', 'arm64', 'vulkan', [['upstream', (v) => `llama-${v}-bin-win-vulkan-arm64.zip`]]],
      ['darwin', 'arm64', 'metal', [['upstream', (v) => `llama-${v}-bin-macos-arm64.tar.gz`]]],
      ['darwin', 'x64', 'cpu', [['upstream', (v) => `llama-${v}-bin-macos-x64.tar.gz`]]],
    ],
  },
  sd: {
    releases: { upstream: ['leejet/stable-diffusion.cpp', (v) => v], ours: [OURS, (v) => `sd-${v}`] },
    builds: [
      ['linux', 'x64', 'cpu', [['ours', (v) => `sd-${v}-linux-x64-cpu.tar.gz`]]],
      ['linux', 'x64', 'vulkan', [['ours', (v) => `sd-${v}-linux-x64-vulkan.tar.gz`]]],
      ['win32', 'x64', 'cpu', [['upstream', (v) => `sd-${sdName(v)}-bin-win-cpu-x64.zip`]]],
      ['win32', 'x64', 'vulkan', [['upstream', (v) => `sd-${sdName(v)}-bin-win-vulkan-x64.zip`]]],
      ['win32', 'x64', 'cuda', [
        ['upstream', (v) => `sd-${sdName(v)}-bin-win-cuda12-x64.zip`],
        ['upstream', () => 'cudart-sd-bin-win-cu12-x64.zip'],
      ]],
    ],
  },
  whisper: {
    releases: { ours: [OURS, (v) => `whisper-${v}`] },
    builds: [
      ['linux', 'x64', 'cpu', [['ours', (v) => `whisper-${v}-linux-x64-cpu.tar.gz`]]],
      ['win32', 'x64', 'cpu', [['ours', (v) => `whisper-${v}-win-x64-cpu.zip`]]],
    ],
  },
};

const [engine, version] = process.argv.slice(2);
const rule = RULES[engine];
if (!rule || !version) {
  console.error(`usage: node scripts/engine-builds.js <${Object.keys(RULES).join('|')}> <version>`);
  process.exit(2);
}

const assets = {};
for (const [key, [repo, tagOf]] of Object.entries(rule.releases)) {
  const tag = tagOf(version);
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`${repo} ${tag}: HTTP ${res.status}`);
  assets[key] = new Map((await res.json()).assets.map((a) => [a.name, a]));
}

const builds = rule.builds.map(([os, arch, accel, files]) => ({
  os,
  arch,
  accel,
  files: files.map(([key, nameOf]) => {
    const name = nameOf(version);
    const a = assets[key].get(name);
    if (!a) throw new Error(`${rule.releases[key][0]}: no asset ${name}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(a.digest ?? '')) throw new Error(`${name}: no sha256 digest`);
    return { url: a.browser_download_url, size: a.size, sha256: a.digest.slice('sha256:'.length) };
  }),
}));
console.log(JSON.stringify(builds, null, 2));
