// Engines the user runs themselves. The default local addresses of Ollama, LM Studio and ComfyUI
// are probed, plus the addresses from "external" in config/engines.json. Only the ones that answer
// are reported; Crealika Desktop never starts or stops them.
const DEFAULTS = [
  { kind: 'ollama', url: 'http://127.0.0.1:11434' },
  { kind: 'lmstudio', url: 'http://127.0.0.1:1234' },
  { kind: 'comfyui', url: 'http://127.0.0.1:8188' },
];

const KINDS = {
  ollama: { name: 'Ollama', probe: '/api/version', api: 'ollama' },
  lmstudio: { name: 'LM Studio', probe: '/v1/models', api: 'openai' },
  comfyui: { name: 'ComfyUI', probe: '/system_stats', api: 'comfyui' },
  openai: { name: 'OpenAI-compatible server', probe: '/v1/models', api: 'openai' },
};

/** Returns [{ kind, name, url, api }] for the engines that answered. */
export async function findExternalEngines(configured = [], { timeoutMs = 800, fetchImpl = fetch } = {}) {
  const seen = new Set();
  const candidates = [...configured, ...DEFAULTS].filter((c) => {
    const key = `${c.kind} ${c.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const found = await Promise.all(candidates.map(async (c) => {
    const kind = KINDS[c.kind];
    try {
      const res = await fetchImpl(new URL(kind.probe, c.url), { signal: AbortSignal.timeout(timeoutMs) });
      await res.body?.cancel();
      return res.ok ? { kind: c.kind, name: c.name ?? kind.name, url: c.url, api: kind.api } : null;
    } catch {
      return null;
    }
  }));
  return found.filter(Boolean);
}
