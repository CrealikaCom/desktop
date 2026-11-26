// Prints the builds of a llama.cpp release for engines.json, with sizes and sha256 digests
// taken from the GitHub release:
//   node scripts/engine-builds.js llama b12751
// Only the platforms and accelerators the launcher offers are listed.
const RULES = {
  llama: {
    repo: 'ggml-org/llama.cpp',
    builds: [
      ['linux', 'x64', 'cpu', ['llama-{tag}-bin-ubuntu-x64.tar.gz']],
      ['linux', 'x64', 'vulkan', ['llama-{tag}-bin-ubuntu-vulkan-x64.tar.gz']],
      ['linux', 'x64', 'cuda', ['llama-{tag}-bin-ubuntu-cuda-12.8-x64.tar.gz', 'cudart-llama-{tag}-bin-ubuntu-cuda-12.8-x64.tar.gz']],
      ['linux', 'arm64', 'cpu', ['llama-{tag}-bin-ubuntu-arm64.tar.gz']],
      ['linux', 'arm64', 'vulkan', ['llama-{tag}-bin-ubuntu-vulkan-arm64.tar.gz']],
      ['win32', 'x64', 'cpu', ['llama-{tag}-bin-win-cpu-x64.zip']],
      ['win32', 'x64', 'vulkan', ['llama-{tag}-bin-win-vulkan-x64.zip']],
      ['win32', 'x64', 'cuda', ['llama-{tag}-bin-win-cuda-12.4-x64.zip', 'cudart-llama-bin-win-cuda-12.4-x64.zip']],
      ['win32', 'arm64', 'cpu', ['llama-{tag}-bin-win-cpu-arm64.zip']],
      ['win32', 'arm64', 'vulkan', ['llama-{tag}-bin-win-vulkan-arm64.zip']],
      ['darwin', 'arm64', 'metal', ['llama-{tag}-bin-macos-arm64.tar.gz']],
      ['darwin', 'x64', 'cpu', ['llama-{tag}-bin-macos-x64.tar.gz']],
    ],
  },
};

const [engine, tag] = process.argv.slice(2);
const rule = RULES[engine];
if (!rule || !tag) {
  console.error(`usage: node scripts/engine-builds.js <${Object.keys(RULES).join('|')}> <release tag>`);
  process.exit(2);
}
const res = await fetch(`https://api.github.com/repos/${rule.repo}/releases/tags/${encodeURIComponent(tag)}`, {
  headers: { accept: 'application/vnd.github+json' },
});
if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
const assets = new Map((await res.json()).assets.map((a) => [a.name, a]));
const builds = rule.builds.map(([os, arch, accel, names]) => ({
  os,
  arch,
  accel,
  files: names.map((pattern) => {
    const name = pattern.replace('{tag}', tag);
    const a = assets.get(name);
    if (!a) throw new Error(`${tag}: no asset ${name}`);
    if (!/^sha256:[0-9a-f]{64}$/.test(a.digest ?? '')) throw new Error(`${name}: no sha256 digest`);
    return { url: a.browser_download_url, size: a.size, sha256: a.digest.slice('sha256:'.length) };
  }),
}));
console.log(JSON.stringify(builds, null, 2));
