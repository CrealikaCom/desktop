# Crealika Desktop

A launcher for local Crealika tools: pick a service, and the launcher installs and runs it.
Each service is a standalone app with its own window, so you can close the launcher and the
service keeps running. All services share one home directory, `~/Crealika`, for engines,
models and results. You can work without signing in, using local models.

Status: early prototype. Installers and shared engines (llama.cpp, stable-diffusion.cpp)
are planned.

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

`config/crealika-id.session` and `config/crealika-id.lock` hold the shared sign-in;
`config/preferences.json` holds the language and theme.

## Layout

```
launcher/
  main.js          entry point: the launcher, or --service=<id>
  launcher-app.js  launcher window: catalog, install, start and stop services
  service-host.js  service process: backend, window, registry, control
  app-session.js   Crealika ID session of this process, encrypted with safeStorage
  preload.cjs      launcher window bridge
  ui/              launcher window, served from launcher://app/
vendor/
  crealika-ui-core/  copy of Crealika UI core (scripts/sync-ui-core.js)
  core/            Electron-free, covered by tests
catalog.json       built-in catalog
test/              node --test; fixtures/echo is a test service
```

A sample service lives in the `crealika-desktop-dummy` repository.

## License

Not chosen yet.
