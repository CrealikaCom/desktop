/*
 * Crealika UI: sets the theme before the first paint.
 * A classic script, loaded synchronously in <head> after the kit CSS:
 *   <script src=".../crealika-ui-core/crealika-prefs.js"></script>
 * It reads the choice from local storage (crealika.preferences) or from
 * <meta name="crealika-preferences" content='{"theme":"dark","scheme":"dark"}'> when the server
 * (or the app host) knows the user's preferences, and sets data-theme / data-color-scheme on <html>.
 * The full logic (theme registry, settings dialog, saving) lives in crealika-ui.js.
 */
(function () {
  'use strict';
  var KEY = 'crealika.preferences';
  var ID = /^[a-z][a-z0-9-]{0,31}$/;
  var root = document.documentElement;

  function parse(text) {
    try {
      var value = JSON.parse(text);
      return value && typeof value === 'object' ? value : null;
    } catch (error) {
      return null;
    }
  }

  var stored = null;
  try {
    stored = parse(window.localStorage.getItem(KEY));
  } catch (error) {
    stored = null;
  }
  if (stored && stored.version !== 1) stored = null;
  var meta = document.querySelector('meta[name="crealika-preferences"]');
  var account = meta ? parse(meta.getAttribute('content')) : null;
  var source = account && typeof account.theme === 'string' ? account : stored;

  var choice = source && typeof source.theme === 'string' && ID.test(source.theme) ? source.theme : 'system';
  var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var theme = choice;
  var scheme = source && (source.scheme === 'dark' || source.scheme === 'light') ? source.scheme : null;
  if (choice === 'system') {
    theme = dark ? 'dark' : 'light';
    scheme = theme;
  }
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-color-scheme', scheme || (theme === 'dark' ? 'dark' : 'light'));
  root.setAttribute('data-theme-choice', choice);
})();
