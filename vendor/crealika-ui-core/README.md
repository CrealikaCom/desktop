# Crealika UI core

The shared look of Crealika apps: design tokens and themes, the Onest font, the app header with
an app switcher and account menu, the language and theme settings dialog, a few building blocks
(buttons, fields, dialogs, toast, drop zone, busy block, slider) and the figures engine that draws
little walking people on a canvas.

No dependencies and no build step: the files work in the browser as they are. Serve the folder
from your app's own origin (it works with a `default-src 'self'` CSP).

## Files

```text
crealika-ui.css        header, menus, dialogs, buttons, fields, building blocks, @font-face
crealika-ui.js         ES module: preferences, theme registry, settings dialog, mountAppHeader, helpers
crealika-ui.d.ts       TypeScript types for crealika-ui.js
i18n.js                interface strings for every supported locale (the only translated module)
crealika-prefs.js      classic script for <head>: applies the theme before the first paint
crealika-figures.js    ES module: the figures engine (also window.CrealikaFigures for classic scripts)
crealika-figures.d.ts  types for the figures engine
themes/                themes.json registry, index.css, one <id>.css per theme with the --cr-* tokens
fonts/                 Onest, variable 100-900, Latin and Cyrillic (SIL Open Font License, fonts/OFL.txt)
brand/                 logo.webp, logo-dark.webp, star.svg
test/                  node --test suites and the demo page
```

## Usage

```html
<link rel="stylesheet" href="/crealika-ui-core/themes/index.css">
<link rel="stylesheet" href="/crealika-ui-core/crealika-ui.css">
<!-- optional: preferences the server already knows, applied before the first paint -->
<meta name="crealika-preferences" content='{"locale":"en","theme":"dark","scheme":"dark"}'>
<script src="/crealika-ui-core/crealika-prefs.js"></script>
<script type="module" src="/app.js"></script>
```

```js
import { mountAppHeader, startPreferences, applyTheme } from '/crealika-ui-core/crealika-ui.js';

const start = await startPreferences({ defaultLocale: 'en', account: { locale, theme, loginId } });
let applied = { locale: start.locale, theme: start.theme };

const header = mountAppHeader({
  locale: applied.locale,
  title: 'My app',                  // next to the logo when the switcher has no current item
  switcher: {                       // optional
    current: 'media',
    items: [
      { id: 'media', name: 'Media', summary: 'All your files', href: '/media' },
      { id: 'voice', name: { en: 'Voice' }, status: 'beta', onSelect: () => openVoice() },
    ],
  },
  account: user ? { username: user.username } : null, // undefined while still checking
  signIn: () => startSignIn(),
  preferences: {
    get: () => applied,
    preview: (value) => render(value),          // show without saving
    save: async (value) => saveToAccount(value), // false or a rejection: saved on this device only
    store: (value) => { applied = value; },      // every committed choice (guest toggles, Apply)
  },
  items: [{ label: 'Administration', onSelect: () => openAdmin() }],
  onLogout: () => signOut(),
});
```

- `switcher` items link (`href`), run `onSelect`, or show as unavailable (`status: 'soon'` or
  neither). An item with `listed: false` labels the button when it is `current` but stays out of the
  list (a page outside the app line-up); `icon` names an `icon()` glyph, by default the item id.
- `account`: `undefined` while sign-in is being checked, `null` for a guest, an object when signed in.
  Guests get a theme toggle, a language menu and "Sign in"; signed-in users get the account menu.
- `locales` limits the offered languages; with one language the language controls are hidden.
- `fluid: true` spans the whole width (full-screen editors use `height: calc(100dvh - var(--cr-header-height))`).
- `nav` adds page navigation; `navAlign: 'center'` centres it.
- Wrap the main content in `.cr-page` to match the header width.

Preferences are stored in local storage under `crealika.preferences`. `<html>` gets
`data-theme`, `data-color-scheme` and `data-theme-choice`.

## Themes and tokens

All colours and sizes are `--cr-*` variables (see `themes/light.css`). A theme is a file
`themes/<id>.css` with a `:root[data-theme="<id>"] { color-scheme: …; --cr-…: … }` block, an
`@import` line in `themes/index.css` and an entry in `themes/themes.json` (`id`, `colorScheme`,
a name for every locale). `system.light` / `system.dark` choose the themes for "System". Tests
check that every theme defines the same tokens.

## Localization

All strings of the kit live in `i18n.js`; theme names live in `themes/themes.json`. A new locale
is a block in `i18n.js` plus theme names. Everything else in the repository is English.

## Figures

```js
import { makeLook, draw } from '/crealika-ui-core/crealika-figures.js';
const look = makeLook({ bag: 0.5 });
draw(ctx, look, { x: 120, y: 200, s: 70, facing: 'side', dir: 1, walking: true, phase });
```

A figure is described in metres from the point between its feet and drawn at `s` pixels per metre.

## Development

```sh
npm test        # node --test, Node 22+
npm run demo    # http://localhost:4400: ?guest=1, ?current=<id> (empty for none), ?fluid=1,
                # ?nav=1, ?navAlign=center, ?locales=en, ?remote=fail
```

## License

Apache License, Version 2.0: see [LICENSE](LICENSE) and [NOTICE](NOTICE).

The Onest font in `fonts/` is distributed under the SIL Open Font License, Version 1.1
(`fonts/OFL.txt`). The Crealika name and the logo files in `brand/` are not covered by the
Apache License; see [TRADEMARKS.md](TRADEMARKS.md) for what you may do with them. A fork
replaces the files in `brand/`.
