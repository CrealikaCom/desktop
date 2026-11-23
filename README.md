# Crealika Desktop

A launcher for local Crealika tools: pick a service, and the launcher installs and runs it.
Each service is a standalone app with its own window, so you can close the launcher and the
service keeps running. All services share one home directory, `~/Crealika`, for engines,
models and results. You can work without signing in, using local models.

Status: early prototype. Sign-in with Crealika ID, installers and shared engines
(llama.cpp, stable-diffusion.cpp) are planned.

## Running from source

Requires Node.js 22.13+.

```bash
npm ci        # Electron is downloaded on first start
npm test      # launcher core, no Electron and no network
npm start     # the launcher; home directory is ~/Crealika or $CREALIKA_HOME
npm start -- --service=<id>   # an installed service without the launcher
```

The built-in service catalog is empty for now. To install a service from your own checkout,
create `<home>/config/catalog.json`:

```json
{ "services": [ { "id": "dummy", "source": { "type": "dir", "path": "/path/to/crealika-desktop-dummy" } } ] }
```

A source can also be a git repository (`{"type": "git", "url": "…", "ref": "main"}`) or a
`.tar.gz` archive (`{"type": "archive", "url": "…", "sha256": "…"}`).

Debugging: `npm start -- --remote-debugging-port=9333`. Services started from such a launcher
inherit its open debugging socket, so the port stays taken while they run.

## Home directory

```
~/Crealika/
  services/<id>/   installed services
  engines/         shared engines
  models/          shared models
  output/<id>/     service results
  data/<id>/       private service data
  cache/  logs/  config/  run/
```

## Layout

```
launcher/
  main.js          entry point: the launcher, or --service=<id>
  launcher-app.js  launcher window: catalog, install, start and stop services
  service-host.js  service process: backend, window, registry, control
  preload.cjs      launcher window bridge
  ui/              launcher window
  core/            Electron-free, covered by tests
catalog.json       built-in catalog
test/              node --test; fixtures/echo is a test service
```

A sample service lives in the `crealika-desktop-dummy` repository.

## License

Not chosen yet.
