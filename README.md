# Crealika Desktop

A launcher for local Crealika tools: pick a service, and the launcher installs and runs it.
Each service is a standalone app with its own window, so you can close the launcher and the
service keeps running. All services share one home directory, `~/Crealika`, for engines,
models and results. You can work without signing in, using local models.

Status: early prototype. Shared engines: llama.cpp, stable-diffusion.cpp and whisper.cpp.

## Installing

Download the build for your system from
[Releases](https://github.com/CrealikaCom/desktop/releases/latest):

| System | File | Updates |
|---|---|---|
| Windows 10/11 x64 | `Crealika-Desktop-Setup-<version>-x64.exe` | automatic |
| Linux x64 | `Crealika-Desktop-x86_64.AppImage` | automatic |
| Linux x64 (Debian, Ubuntu) | `Crealika-Desktop-<version>-linux-amd64.deb` | install the new package |
| macOS, Apple Silicon or Intel | `Crealika-Desktop-<version>-mac-arm64.dmg` / `-x64.dmg` | download the new version |

The builds are not signed yet, so the system warns before the first start:

- Windows: SmartScreen says "Windows protected your PC". Choose **More info**, then **Run anyway**.
- macOS: the first start is blocked. Open **System Settings → Privacy & Security** and choose
  **Open Anyway** next to Crealika Desktop.
- Linux AppImage: make the file executable (`chmod +x Crealika-Desktop-x86_64.AppImage`) and run it.

The launcher checks for a new version when it starts, downloads it in the background and
installs it when you close the launcher. While services are running the update waits, since it
replaces the program they run from. `CREALIKA_DESKTOP_NO_UPDATES=1` turns the check off.

## Running from source

Requires Node.js 22.13+.

```bash
npm ci        # Electron is downloaded on first start
npm test      # launcher core, no Electron and no network
npm start     # the launcher; home directory is ~/Crealika or $CREALIKA_HOME
npm start -- --service=<id>   # an installed service without the launcher
npm start -- --show=<id>      # the launcher with that service's card highlighted
npm run dist  # installers for this system in dist/ (electron-builder)
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

## Signing in

Press **Sign in** in the launcher: your browser opens Crealika ID, you confirm access for
Crealika Desktop, and the browser hands the result back to the launcher on `127.0.0.1`. One
sign-in covers every service, including services started without the launcher. The session
is stored in `<home>/config/crealika-id.session`, encrypted with the system keychain
(Keychain on macOS, DPAPI on Windows, Secret Service or KWallet on Linux). **Sign out**
deletes it and revokes it at Crealika ID.

Services ask their host for the session (`/v1/session`) and short-lived access tokens; they
never see the stored sign-in itself. At sign-in the launcher also asks for access to the Crealika
services it knows (for crealika.com: the media library, `https://media.crealika.com`). A service
gets a token for one of them with `/v1/token?resource=<service address>`; that token is accepted
only by that service.

Environment variables for development: `CREALIKA_ID_ISSUER` points the launcher at another
Crealika ID instance (plain `http` only on localhost), `CREALIKA_ID_RESOURCES` replaces the list
of services (`address=scope,...`, for example `http://localhost:4200=media`), and
`CREALIKA_DESKTOP_NO_BROWSER=1` leaves the browser closed and shows the sign-in link in the
launcher instead.

## Look and theme

The launcher and services use Crealika UI core, the shared look of Crealika apps (tokens, themes,
the Onest font, the app header, dialogs and building blocks). A copy lives in
`vendor/crealika-ui-core`; update it from a checkout of the kit:

```bash
node scripts/sync-ui-core.js /path/to/crealika-ui-core
```

Language and theme are shared by the launcher and every service: they are stored in
`<home>/config/preferences.json`, services read and change them through their host
(`GET`/`PUT /v1/preferences`), and window chrome follows the theme. At sign-in the theme chosen
in the Crealika account applies once. The interface is English-only for now.

## Shared engines

Engines run models on your computer. The launcher installs them into `<home>/engines/<id>/`
from pinned prebuilt archives listed in `engines.json`, checking the sha256 of every file, and
offers the builds for your system: CPU, Vulkan (most GPUs), CUDA (NVIDIA, a large download) and
Metal (Apple Silicon). The recommended build is Metal on a Mac, else Vulkan when the system has
the Vulkan loader, else CPU. Installing a service also installs the engines its manifest lists.

| Engine | Server | Models | Builds |
|---|---|---|---|
| `llama` | llama.cpp `llama-server` in router mode, OpenAI-compatible API | `.gguf` files in `<home>/models/llm/`, loaded on request | Windows, Linux, macOS |
| `sd` | stable-diffusion.cpp `sd-server`: OpenAI-compatible, WebUI-compatible and native APIs | `<home>/models/sd/` in its category folders (`checkpoints/`, `diffusion_models/`, `vae/`, ...), loaded on request | Windows x64, Linux x64 |
| `whisper` | whisper.cpp `whisper-server`, `POST /inference` | one `ggml-*.bin` file from `<home>/models/whisper/` per process | Windows x64, Linux x64 (CPU) |

Most builds are the engines' own releases. Where those do not fit, they come from
[CrealikaCom/engine-builds](https://github.com/CrealikaCom/engine-builds): stable-diffusion.cpp for
Linux (built for older glibc) and whisper.cpp (with an API key added to its server).

An engine runs as a separate process shared by all services. A service asks its host for it:

| Request | Answer |
|---|---|
| `GET /v1/engines` | `{engines: [{id, name, version, accel, installed, running, declared, perModel, models}], external: [...]}` |
| `POST /v1/engines/<id>/acquire` | `{id, instance, model, url, apiKey, version, accel, models}`; starts the engine if it is not running |
| `POST /v1/engines/<id>/release` | `{ok: true}` |
| errors | 409 `not_installed`, 403 `not_declared` (not in the manifest's `engines`), 404 `unknown_engine`, 400 `model_required`, 404 `model_not_found`, 503 `start_failed` |

Engines with `perModel` (whisper.cpp) load one model when they start, so they run one process per
model file: send `{"model": "<file in the models folder>"}` with `acquire`, and with `release` to
let go of one model (without it, `release` lets go of all of them). Other engines ignore `model`.

The engine listens on `127.0.0.1` and requires `apiKey` as a bearer token; send the key only to
that address. The launcher passes the key to the engine in a file, so it does not show in the
process list. The engine keeps running while any service holds it and stops when the last one
releases it or exits. If a service crashes, the launcher stops the engines nobody holds anymore.
State is in `<home>/run/engines/<instance>.json`, the log in `<home>/logs/engine-<id>.log`.

`external` lists engines you run yourself that answered on their usual local address: Ollama
(`127.0.0.1:11434`), LM Studio (`127.0.0.1:1234`) and ComfyUI (`127.0.0.1:8188`). Other
addresses, and your own engine builds, go into `<home>/config/engines.json`:

```json
{
  "external": [ { "kind": "ollama", "url": "http://192.168.1.10:11434" } ],
  "engines": [ { "id": "llama", "...": "same fields as in engines.json; replaces the built-in entry" } ]
}
```

`node scripts/engine-builds.js <llama|sd|whisper> <version>` prints the builds of an engine
version with their sizes and sha256 digests for `engines.json`.

## Home directory

```
~/Crealika/
  services/<id>/   installed services
  engines/<id>/    shared engines (crealika-engine.json: version and build)
  models/          shared models (llm/ for llama.cpp)
  output/<id>/     service results
  data/<id>/       private service data
  cache/  logs/  config/  run/
```

`config/crealika-id.session` and `config/crealika-id.lock` hold the shared sign-in;
`config/preferences.json` holds the language and theme.

## Switching between services

A service window can switch to the other services from its header, like the Crealika website.
The host lists them and opens one the way the launcher's Open button does:

| Request | Answer |
|---|---|
| `GET /v1/services` | `{services: [{id, name, description, installed, running, current}]}`: the catalog and installed services, by name |
| `POST /v1/services/<id>/open` | `{result}`: `focused` (it was running), `started`, or `launcher` (not installed: the launcher opens on its card); 404 `unknown_service` |

The launcher's header has the same switcher with the installed services; services still to
install are on its cards.

On Linux under Wayland an app cannot bring another app's window to the front, so when XWayland is
available the launcher and the services run as X11 windows (with the NVIDIA driver, drawn through
ANGLE on Vulkan). `CREALIKA_DESKTOP_WAYLAND=1` keeps native Wayland; switching then cannot move
the focus.

## Building and releases

`npm run dist` builds the installers for the current system into `dist/`: NSIS on Windows, an
AppImage and a .deb on Linux, a .dmg for Apple Silicon and Intel on macOS. The GitHub Actions
workflow `.github/workflows/release.yml` runs the tests and the builds on all three systems.
Pushing a tag `v<version>` that matches `version` in `package.json` publishes a release with the
installers and the files the update check reads (`latest*.yml`).

## Layout

```
launcher/
  main.js          entry point: the launcher (--show=<id>), or --service=<id>
  launcher-app.js  launcher window: catalog, install, start and stop services
  service-host.js  service process: backend, window, registry, control
  start-app.js     starts another detached process of this executable
  updates.js       updates of the installed app from GitHub Releases
  app-session.js   Crealika ID session of this process, encrypted with safeStorage
  preload.cjs      launcher window bridge
  ui/              launcher window, served from launcher://app/
  core/            Electron-free, covered by tests (engine-*.js, engines.js: shared engines)
vendor/
  crealika-ui-core/  copy of Crealika UI core (scripts/sync-ui-core.js)
catalog.json       built-in service catalog
engines.json       built-in engine catalog (scripts/engine-builds.js)
build/icon.png     app icon for the installers
test/              node --test; fixtures/echo is a test service, fixtures/engine a fake engine
```

A sample service lives in the `crealika-desktop-dummy` repository.

## License

Apache License, Version 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE).

`vendor/crealika-ui-core/` is a copy of Crealika UI core under the same license, with the Onest
font under the SIL Open Font License. The Crealika name, the logo files in
`vendor/crealika-ui-core/brand/` and the app icon `build/icon.png` are not covered by the Apache License; see
[TRADEMARKS.md](TRADEMARKS.md). A fork replaces them.
