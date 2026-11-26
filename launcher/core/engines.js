// What the launcher window and the service hosts know about shared engines: the catalog for this
// computer, what is installed and running, and engines the user runs themselves.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildsFor, currentPlatform, detectAccelerators, loadEngineCatalogs, recommendedBuild } from './engine-catalog.js';
import { readInstalledEngine } from './engine-installer.js';
import { acquireEngine, EngineError, engineInstance, heldInstances, listRunningEngines, releaseEngine } from './engine-runner.js';
import { findExternalEngines } from './external-engines.js';

const BUILTIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'engines.json');

export function engineCatalogFiles(lay, builtin = BUILTIN) {
  return [builtin, path.join(lay.config, 'engines.json')];
}

/**
 * Engines for this computer:
 * [{ id, name, description, version, models, perModel, builds: [{accel, size}], recommended, installed, running }]
 * plus the accelerators found and the external engines that answered.
 */
export async function engineOverview(lay, { files = engineCatalogFiles(lay), platform = currentPlatform(), external = true } = {}) {
  const catalog = await loadEngineCatalogs(files);
  const detected = await detectAccelerators({ platform });
  const running = await listRunningEngines(lay);
  const engines = await Promise.all(catalog.engines.map(async (e) => {
    const builds = buildsFor(e, platform);
    const installed = await readInstalledEngine(lay, e.id);
    return {
      id: e.id,
      name: e.name,
      description: e.description,
      version: e.version,
      models: path.join(lay.models, e.models),
      perModel: e.perModel,
      builds: builds.map((b) => ({ accel: b.accel, size: b.files.every((f) => f.size) ? b.files.reduce((s, f) => s + f.size, 0) : null })),
      recommended: recommendedBuild(builds, detected)?.accel ?? null,
      installed: installed ? { version: installed.version, accel: installed.accel } : null,
      running: running.get(e.id) ?? null,
    };
  }));
  return {
    platform,
    detected,
    engines,
    external: external ? await findExternalEngines(catalog.external) : [],
  };
}

/**
 * Engine requests of one service host: the service may use the engines its manifest declares.
 * Leases are held by this host process and released when it exits (releaseAll). Engines with
 * perModel need { model }: a file in their models folder; each model runs as its own instance.
 */
export function createHostEngines({ lay, manifest, files = engineCatalogFiles(lay), hostPid = process.pid }) {
  const held = new Set(); // instance keys
  const holder = { pid: hostPid, service: manifest.id };

  async function engineFor(id) {
    const { engines } = await loadEngineCatalogs(files);
    const engine = engines.find((e) => e.id === id);
    if (!engine) throw new EngineError('unknown_engine', `unknown engine ${id}`);
    if (!manifest.engines.includes(id)) {
      throw new EngineError('not_declared', `${manifest.id} does not list ${id} in "engines" of its manifest`);
    }
    return engine;
  }

  return {
    async list() {
      const overview = await engineOverview(lay, { files });
      return {
        engines: overview.engines.map((e) => ({
          id: e.id,
          name: e.name,
          version: e.installed?.version ?? null,
          accel: e.installed?.accel ?? null,
          installed: Boolean(e.installed),
          running: Boolean(e.running),
          declared: manifest.engines.includes(e.id),
          perModel: e.perModel,
          models: e.models,
        })),
        external: overview.external,
      };
    },
    async acquire(_serviceId, id, { model = null } = {}) {
      const engine = await engineFor(id);
      const info = await acquireEngine(lay, engine, holder, { model });
      held.add(info.instance);
      return info;
    },
    // Without a model, releases every instance of the engine this service holds.
    async release(_serviceId, id, { model = null } = {}) {
      const engine = await engineFor(id);
      const keys = engine.perModel && model
        ? [(await engineInstance(lay, engine, model, { mustExist: false })).key]
        : await heldInstances(lay, id, holder);
      for (const key of keys) {
        await releaseEngine(lay, key, holder);
        held.delete(key);
      }
      return { ok: true };
    },
    async releaseAll() {
      await Promise.allSettled([...held].map((key) => releaseEngine(lay, key, { pid: hostPid })));
      held.clear();
    },
  };
}
