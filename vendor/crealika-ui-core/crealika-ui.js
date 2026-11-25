/**
 * Crealika UI core: preferences (locale and theme), theme registry, the settings dialog, the app
 * header (mountAppHeader) and a few building blocks (toast, drop zone, busy block, slider).
 *
 * No dependencies and no build step. Pure functions (local storage parsing, theme registry,
 * initial preferences) do not touch the DOM and are tested in Node; only mountAppHeader,
 * openSettings, applyTheme, showToast and the create* helpers need a DOM. Contract: README.md.
 */
import { LOCALE_NAMES, STRINGS } from './i18n.js';

export { LOCALE_NAMES };
export const VERSION = '1.0.0';
export const STORAGE_KEY = 'crealika.preferences';
export const LOCALES = Object.freeze(Object.keys(STRINGS));

const THEME_ID = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * @param {string|undefined} locale
 * @param {keyof typeof STRINGS.en} key
 * @returns {string} Kit string in the given locale (English for an unknown locale).
 */
export function text(locale, key) {
  return (STRINGS[locale] ?? STRINGS.en)[key];
}

/** @returns {string|undefined} A supported locale or undefined. */
export function normalizeLocale(value) {
  return LOCALES.includes(value) ? value : undefined;
}

/** @returns {boolean} Whether the value looks like a theme id or `system`. */
export function isThemeChoice(value) {
  return typeof value === 'string' && THEME_ID.test(value);
}

// ---- local storage ----

/**
 * Parses the crealika.preferences record. A broken record or another version gives null.
 * @param {string|null} raw
 * @returns {{locale?: string, theme?: string, scheme?: string, loginId?: string}|null}
 */
export function parseStored(raw) {
  if (typeof raw !== 'string') return null;
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || value.version !== 1) return null;
  const result = {};
  const locale = normalizeLocale(value.locale);
  if (locale) result.locale = locale;
  if (isThemeChoice(value.theme)) result.theme = value.theme;
  if (value.scheme === 'light' || value.scheme === 'dark') result.scheme = value.scheme;
  if (typeof value.loginId === 'string' && value.loginId.length <= 200) result.loginId = value.loginId;
  return result;
}

/** @returns {Storage|undefined} localStorage when available (undefined in private mode or when blocked). */
function defaultStorage() {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

/** @returns The stored preferences or null. */
export function readStored(storage = defaultStorage()) {
  try {
    return parseStored(storage?.getItem(STORAGE_KEY) ?? null);
  } catch {
    return null;
  }
}

/**
 * Stores the preferences; storage errors (quota, blocked) do not interrupt the page.
 * @param {{locale?: string, theme?: string, scheme?: string, loginId?: string}} value
 * @returns {boolean} Whether the record was written.
 */
export function writeStored(value, storage = defaultStorage()) {
  if (!storage) return false;
  const record = { version: 1 };
  if (normalizeLocale(value.locale)) record.locale = value.locale;
  if (isThemeChoice(value.theme)) record.theme = value.theme;
  if (value.scheme === 'light' || value.scheme === 'dark') record.scheme = value.scheme;
  if (typeof value.loginId === 'string') record.loginId = value.loginId;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

// ---- theme registry ----

/**
 * Validates themes.json.
 * @returns {{system: {light: string, dark: string}, themes: {id: string, colorScheme: 'light'|'dark', name: Record<string,string>}[]}}
 * @throws {Error} when the format is wrong.
 */
export function validateRegistry(data) {
  if (!data || data.version !== 1 || !Array.isArray(data.themes) || data.themes.length === 0) {
    throw new Error('themes.json: version 1 and a non-empty themes list are required');
  }
  const ids = new Set();
  const themes = data.themes.map((theme) => {
    if (!theme || !isThemeChoice(theme.id) || theme.id === 'system' || ids.has(theme.id)) {
      throw new Error(`themes.json: invalid or duplicate id ${theme?.id}`);
    }
    if (theme.colorScheme !== 'light' && theme.colorScheme !== 'dark') {
      throw new Error(`themes.json: ${theme.id}: colorScheme must be light or dark`);
    }
    for (const locale of LOCALES) {
      if (typeof theme.name?.[locale] !== 'string' || !theme.name[locale]) {
        throw new Error(`themes.json: ${theme.id}: name.${locale} is required`);
      }
    }
    ids.add(theme.id);
    return { id: theme.id, colorScheme: theme.colorScheme, name: { ...theme.name } };
  });
  const system = data.system ?? {};
  for (const scheme of ['light', 'dark']) {
    const theme = themes.find((item) => item.id === system[scheme]);
    if (!theme || theme.colorScheme !== scheme) {
      throw new Error(`themes.json: system.${scheme} must name a ${scheme} theme`);
    }
  }
  return { system: { light: system.light, dark: system.dark }, themes };
}

/** Built-in copy of the registry for when themes.json cannot be loaded. */
const FALLBACK_REGISTRY = validateRegistry({
  version: 1,
  system: { light: 'light', dark: 'dark' },
  themes: [
    { id: 'light', colorScheme: 'light', name: Object.fromEntries(LOCALES.map((l) => [l, STRINGS[l].light])) },
    { id: 'dark', colorScheme: 'dark', name: Object.fromEntries(LOCALES.map((l) => [l, STRINGS[l].dark])) },
  ],
});

let registryPromise;

/** @returns {Promise<ReturnType<typeof validateRegistry>>} The theme registry next to this module (cached). */
export function loadRegistry() {
  registryPromise ??= fetch(new URL('./themes/themes.json', import.meta.url), { credentials: 'same-origin' })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`themes.json ${response.status}`))))
    .then(validateRegistry)
    .catch((error) => {
      console.warn('Crealika UI: theme registry unavailable, built-in themes are used.', error);
      return FALLBACK_REGISTRY;
    });
  return registryPromise;
}

/**
 * @param {string} choice `system` or a theme id.
 * @param {boolean} prefersDark Whether the system theme is dark.
 * @returns {{choice: string, theme: string, scheme: 'light'|'dark'}} Theme for data-theme; an unknown id acts as system.
 */
export function resolveTheme(choice, registry, prefersDark) {
  const known = registry.themes.find((item) => item.id === choice);
  if (known) return { choice, theme: known.id, scheme: known.colorScheme };
  const scheme = prefersDark ? 'dark' : 'light';
  return { choice: 'system', theme: registry.system[scheme], scheme };
}

// ---- initial preferences ----

/**
 * Picks the locale and theme when the page loads.
 *
 * - account (the user's preferences from Crealika ID) wins on a new sign-in:
 *   account.loginId differs from the stored one; without loginId it always wins;
 * - otherwise local storage; otherwise the default locale and the `system` theme.
 *
 * @param {{defaultLocale: string, account?: {locale?: string, theme?: string|null, loginId?: string}, stored?: object|null}} input
 * @returns {{locale: string, theme: string, loginId?: string, fromAccount: boolean}}
 */
export function initialPreferences({ defaultLocale, account, stored }) {
  const fallbackLocale = normalizeLocale(defaultLocale) ?? 'en';
  const base = {
    locale: stored?.locale ?? fallbackLocale,
    theme: stored?.theme ?? 'system',
    loginId: stored?.loginId,
    fromAccount: false,
  };
  if (!account || (account.loginId !== undefined && account.loginId === stored?.loginId)) return base;
  return {
    locale: normalizeLocale(account.locale) ?? base.locale,
    theme: isThemeChoice(account.theme) ? account.theme : base.theme,
    loginId: account.loginId ?? base.loginId,
    fromAccount: true,
  };
}

// ---- applying the theme (DOM) ----

const state = { choice: 'system', registry: FALLBACK_REGISTRY, media: undefined, listeners: new Set() };

function prefersDark() {
  return globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

function setAttributes(resolved) {
  const root = document.documentElement;
  root.dataset.theme = resolved.theme;
  root.dataset.colorScheme = resolved.scheme;
  root.dataset.themeChoice = resolved.choice;
  for (const listener of state.listeners) listener(resolved);
}

/**
 * Sets the theme on <html> (data-theme, data-color-scheme, data-theme-choice); for `system` it
 * follows changes of the system theme.
 * @returns {{choice: string, theme: string, scheme: 'light'|'dark'}}
 */
export function applyTheme(choice, registry = state.registry) {
  state.registry = registry;
  const resolved = resolveTheme(choice, registry, prefersDark());
  state.choice = resolved.choice;
  if (!state.media && globalThis.matchMedia) {
    state.media = globalThis.matchMedia('(prefers-color-scheme: dark)');
    state.media.addEventListener('change', () => {
      if (state.choice === 'system') setAttributes(resolveTheme('system', state.registry, prefersDark()));
    });
  }
  setAttributes(resolved);
  return resolved;
}

/**
 * Subscribes to applied themes (including system theme changes while `system` is chosen).
 * @param {(resolved: {choice: string, theme: string, scheme: string}) => void} listener
 * @returns {() => void} Unsubscribe.
 */
export function onThemeApplied(listener) {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

/**
 * Page start: theme registry, initial preferences, theme on <html>, and a local storage record
 * when the preferences came from the account.
 * @param {{defaultLocale: string, account?: {locale?: string, theme?: string|null, loginId?: string}}} options
 * @returns {Promise<{locale: string, theme: string, registry: object, fromAccount: boolean}>}
 */
export async function startPreferences({ defaultLocale, account }) {
  const registry = await loadRegistry();
  const stored = readStored();
  const initial = initialPreferences({ defaultLocale, account, stored });
  const resolved = applyTheme(initial.theme, registry);
  if (initial.fromAccount) {
    writeStored({ locale: initial.locale, theme: resolved.choice, scheme: resolved.scheme, loginId: initial.loginId });
  }
  return { locale: initial.locale, theme: resolved.choice, registry, fromAccount: initial.fromAccount };
}

/** Stores the applied preferences in local storage, keeping loginId. */
export function storePreferences({ locale, theme }) {
  const resolved = resolveTheme(theme, state.registry, prefersDark());
  return writeStored({ locale, theme: resolved.choice, scheme: resolved.scheme, loginId: readStored()?.loginId });
}

// ---- DOM helpers ----

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (name.startsWith('on')) node.addEventListener(name.slice(2), value);
    else node.setAttribute(name, value === true ? '' : value);
  }
  node.append(...children.filter((child) => child !== undefined && child !== null));
  return node;
}

let sequence = 0;
const uid = (name) => `cr-${name}-${++sequence}`;

const CHEVRON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const MENU_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';

/**
 * Shows a short notice at the bottom of the screen.
 * @param {string} message
 * @param {number} [timeout=6000]
 */
export function showToast(message, timeout = 6000) {
  const toast = element('div', { class: 'cr-toast', role: 'status' }, message);
  document.body.append(toast);
  setTimeout(() => toast.remove(), timeout);
  return toast;
}

// ---- file upload and waiting ----

/**
 * File drop zone: a centred button with a hint below ("or drop it here"); the file is picked or
 * dropped. The app checks type and size in onFile.
 *
 * @param {{ label: string, hint?: string, accept?: string, onFile: (file: File) => void }} options
 * @returns {{ element: HTMLElement, setDisabled(disabled: boolean): void }}
 */
export function createDropzone({ label, hint, accept, onFile }) {
  const input = element('input', { type: 'file', accept, hidden: true, tabindex: '-1' });
  const button = element('button', { type: 'button', class: 'cr-button' }, label);
  const zone = element('div', { class: 'cr-dropzone' }, button, hint ? element('p', { class: 'cr-dropzone-hint' }, hint) : null, input);
  let disabled = false;
  let depth = 0;
  const pick = (file) => {
    if (file && !disabled) onFile(file);
  };
  button.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.value = '';
    pick(file);
  });
  zone.addEventListener('dragenter', (event) => {
    if (disabled) return;
    event.preventDefault();
    depth += 1;
    zone.classList.add('is-dragover');
  });
  zone.addEventListener('dragover', (event) => {
    if (!disabled) event.preventDefault();
  });
  zone.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) zone.classList.remove('is-dragover');
  });
  zone.addEventListener('drop', (event) => {
    event.preventDefault();
    depth = 0;
    zone.classList.remove('is-dragover');
    pick(event.dataTransfer?.files?.[0]);
  });
  return {
    element: zone,
    setDisabled(value) {
      disabled = Boolean(value);
      button.disabled = disabled;
      zone.classList.toggle('is-disabled', disabled);
    },
  };
}

/**
 * Waiting block for a long action: title (what is happening), hint (how long it usually takes),
 * elapsed time and a progress bar (indeterminate without a value). Replaces the form while the action runs.
 * The timer stops by itself once the block leaves the page.
 *
 * @param {{ title: string, hint?: string, startedAt?: number, elapsed?: (seconds: number) => string, action?: HTMLElement }} options
 *   startedAt is the action start (ms) when the block is recreated; elapsed formats the elapsed time.
 * @returns {{ element: HTMLElement, update(next: { title?: string, hint?: string, progress?: number|null }): void, stop(): void }}
 */
export function createBusy({ title, hint, startedAt = Date.now(), elapsed, action }) {
  const titleNode = element('p', { class: 'cr-busy-title', role: 'status' }, title);
  const hintNode = element('p', { class: 'cr-busy-hint' }, hint ?? '');
  const bar = element('div', { class: 'cr-busy-bar' });
  const track = element('div', { class: 'cr-busy-track is-indeterminate', role: 'progressbar', 'aria-label': title }, bar);
  const time = element('p', { class: 'cr-busy-time' });
  const box = element('div', { class: 'cr-busy' }, titleNode, hintNode, track, time, action);
  let seen = false;
  const tick = () => {
    if (box.isConnected) seen = true;
    else if (seen) return clearInterval(timer);
    if (elapsed) time.textContent = elapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
  };
  const timer = setInterval(tick, 1000);
  tick();
  return {
    element: box,
    update({ title: nextTitle, hint: nextHint, progress } = {}) {
      if (nextTitle !== undefined) {
        titleNode.textContent = nextTitle;
        track.setAttribute('aria-label', nextTitle);
      }
      if (nextHint !== undefined) hintNode.textContent = nextHint;
      if (progress === undefined) return;
      if (progress === null) {
        track.classList.add('is-indeterminate');
        track.removeAttribute('aria-valuenow');
        bar.style.width = '';
        return;
      }
      const value = Math.max(0, Math.min(1, progress));
      track.classList.remove('is-indeterminate');
      track.setAttribute('aria-valuemin', '0');
      track.setAttribute('aria-valuemax', '100');
      track.setAttribute('aria-valuenow', String(Math.round(value * 100)));
      bar.style.width = `${value * 100}%`;
    },
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * Slider value: a number in [min, max] snapped to step from min; not a number gives min.
 * @param {unknown} raw
 * @param {{ min?: number, max?: number, step?: number }} [range]
 * @returns {number}
 */
export function sliderValue(raw, { min = 0, max = 100, step = 1 } = {}) {
  const number = Number(raw);
  if (!Number.isFinite(number)) return min;
  const snapped = step > 0 ? min + Math.round((number - min) / step) * step : number;
  const digits = String(step).split('.')[1]?.length ?? 0;
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(digits));
}

/**
 * Slider: a label, the current value to its right, and a track filled with the accent up to the thumb.
 * Underneath is a plain input type=range: keyboard, touch and accessibility as in the browser control.
 * onInput fires on every move, onChange when the thumb is released.
 *
 * @param {{ label: string, min?: number, max?: number, step?: number, value?: number,
 *   format?: (value: number) => string, onInput?: (value: number) => void, onChange?: (value: number) => void,
 *   disabled?: boolean }} options
 * @returns {{ element: HTMLElement, input: HTMLInputElement, readonly value: number, setValue(value: number): void,
 *   setLabel(label: string): void, setDisabled(disabled: boolean): void }}
 */
export function createSlider({ label, min = 0, max = 100, step = 1, value = min, format = String, onInput, onChange, disabled = false }) {
  const id = uid('slider');
  const range = { min, max, step };
  let current = sliderValue(value, range);
  const caption = element('label', { class: 'cr-label', for: id }, label);
  const output = element('output', { class: 'cr-slider-value', for: id });
  const input = element('input', {
    id, class: 'cr-slider-input', type: 'range', min: String(min), max: String(max), step: String(step), value: String(current),
  });
  const root = element('div', { class: 'cr-slider' }, element('div', { class: 'cr-slider-head' }, caption, output), input);
  const show = () => {
    input.value = String(current);
    output.textContent = format(current);
    input.setAttribute('aria-valuetext', output.textContent);
    // Track fill goes through CSSOM: pages with CSP style-src 'self' reject the style attribute.
    root.style.setProperty('--cr-slider-fill', `${max > min ? ((current - min) / (max - min)) * 100 : 0}%`);
  };
  const read = () => {
    current = sliderValue(input.value, range);
    show();
    return current;
  };
  input.addEventListener('input', () => onInput?.(read()));
  input.addEventListener('change', () => onChange?.(read()));
  const api = {
    element: root,
    input,
    get value() { return current; },
    setValue(next) {
      current = sliderValue(next, range);
      show();
    },
    setLabel(next) { caption.textContent = next; },
    setDisabled(next) {
      input.disabled = Boolean(next);
      root.classList.toggle('is-disabled', Boolean(next));
    },
  };
  show();
  api.setDisabled(disabled);
  return api;
}

// ---- settings dialog ----

let openDialog;

/**
 * Settings dialog: language and theme. A change is previewed at once; it is saved only on
 * "Apply"; "Cancel", Esc and closing restore the initial values.
 *
 * @param {{
 *   preferences: {
 *     get(): {locale: string, theme: string},
 *     preview(value: {locale: string, theme: string}): void|Promise<void>,
 *     save(value: {locale: string, theme: string}): Promise<boolean|void>|boolean|void,
 *     store?(value: {locale: string, theme: string}): void,
 *   },
 *   onLocale?: (locale: string) => void,
 *   locales?: string[],
 * }} options When save returns false or rejects, the preferences stay on this device only.
 *   store keeps the applied choice where the app keeps it (besides local storage). locales lists
 *   the offered languages (all supported by default); with one language the field is hidden.
 * @returns {Promise<'applied'|'cancelled'>}
 */
export async function openSettings({ preferences, onLocale, locales = LOCALES }) {
  if (openDialog) {
    openDialog.focus();
    return 'cancelled';
  }
  const registry = await loadRegistry();
  const initial = { ...preferences.get() };
  initial.theme = resolveTheme(initial.theme, registry, prefersDark()).choice;
  let current = { ...initial };

  const titleId = uid('settings-title');
  const languageId = uid('language');
  const themeId = uid('theme');
  const title = element('h2', { class: 'cr-dialog-title', id: titleId });
  const languageLabel = element('label', { for: languageId });
  const themeLabel = element('label', { for: themeId });
  const offered = locales.filter((locale) => LOCALES.includes(locale));
  const language = element('select', { id: languageId },
    ...offered.map((locale) => element('option', { value: locale, lang: locale }, LOCALE_NAMES[locale])));
  const theme = element('select', { id: themeId });
  const cancel = element('button', { type: 'button', class: 'cr-button' });
  const apply = element('button', { type: 'submit', class: 'cr-button cr-button-primary' });
  const form = element('form', { method: 'dialog' },
    title,
    element('div', { class: 'cr-dialog-body' },
      offered.length > 1 ? element('div', { class: 'cr-field' }, languageLabel, language) : null,
      element('div', { class: 'cr-field' }, themeLabel, theme)),
    element('div', { class: 'cr-dialog-actions' }, cancel, apply));
  const dialog = element('dialog', { class: 'cr-dialog cr-settings', 'aria-labelledby': titleId }, form);

  const render = (locale) => {
    dialog.lang = locale;
    title.textContent = text(locale, 'settings');
    languageLabel.textContent = text(locale, 'language');
    themeLabel.textContent = text(locale, 'theme');
    cancel.textContent = text(locale, 'cancel');
    apply.textContent = text(locale, 'apply');
    const selected = theme.value || current.theme;
    theme.replaceChildren(
      element('option', { value: 'system' }, text(locale, 'system')),
      ...registry.themes.map((item) => element('option', { value: item.id }, item.name[locale] ?? item.name.en)),
    );
    theme.value = selected;
  };

  const preview = async (value) => {
    applyTheme(value.theme, registry);
    render(value.locale);
    onLocale?.(value.locale);
    try {
      await preferences.preview({ ...value });
    } catch (error) {
      console.error('Crealika UI: preview failed', error);
    }
  };

  // With the language field hidden the locale stays as it was.
  const chosenLocale = () => (offered.length > 1 ? language.value : initial.locale);
  language.value = initial.locale;
  render(initial.locale);
  theme.value = initial.theme;

  const changed = () => {
    current = { locale: chosenLocale(), theme: theme.value };
    void preview(current);
  };
  language.addEventListener('change', changed);
  theme.addEventListener('change', changed);

  return new Promise((resolve) => {
    let result = 'cancelled';
    let saving = false;
    let done = false;
    const revert = () => {
      if (current.locale !== initial.locale || current.theme !== initial.theme) {
        current = { ...initial };
        void preview(initial);
      }
    };
    // Finish right away on Cancel, Esc and Apply: the <dialog> close event is asynchronous and
    // delayed in background tabs; close remains a fallback (closing from outside).
    const end = () => {
      if (done) return;
      done = true;
      if (result !== 'applied') revert();
      if (dialog.open) dialog.close();
      dialog.remove();
      openDialog = undefined;
      resolve(result);
    };
    cancel.addEventListener('click', end);
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      if (!saving) end();
    });
    dialog.addEventListener('close', end);
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (saving) return;
      saving = true;
      cancel.disabled = true;
      apply.disabled = true;
      const value = { locale: chosenLocale(), theme: theme.value };
      storePreferences(value);
      preferences.store?.({ ...value });
      let remote = true;
      try {
        remote = (await preferences.save?.({ ...value })) !== false;
      } catch (error) {
        console.warn('Crealika UI: settings were saved on this device only', error);
        remote = false;
      }
      result = 'applied';
      saving = false;
      end();
      if (!remote) showToast(text(value.locale, 'localOnly'));
    });
    document.body.append(dialog);
    openDialog = dialog;
    dialog.showModal();
    (offered.length > 1 ? language : theme).focus();
  });
}

/** A label: a (locale) => string function, a per-locale object or a string. */
export function localized(value, locale) {
  if (typeof value === 'function') return value(locale);
  if (value && typeof value === 'object') return value[locale] ?? value.en ?? '';
  return value ?? '';
}

const ICONS = {
  images: '<rect x="3" y="3" width="18" height="18" rx="4"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="m4 17 5-5 4 4 3-3 4 4"/>',
  voice: '<path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/>',
  music: '<path d="M9 18V5l11-2v13"/><ellipse cx="6" cy="18" rx="3" ry="2.2"/><ellipse cx="17" cy="16" rx="3" ry="2.2"/>',
  characters: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21c.8-4 3.8-6.2 7.5-6.2s6.7 2.2 7.5 6.2"/>',
  vino: '<rect x="8.5" y="3" width="7" height="5" rx="1.2"/><rect x="2.5" y="16" width="7" height="5" rx="1.2"/><rect x="14.5" y="16" width="7" height="5" rx="1.2"/><path d="M12 8v4M6 16v-4h12v4"/>',
  media: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2.5h6.5A2.5 2.5 0 0 1 21 10v7.5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z"/>',
  video: '<rect x="3" y="5" width="13" height="14" rx="3"/><path d="m16 10 5-3v10l-5-3"/>',
  grid: '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.8"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.8"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.8"/><rect x="14" y="14" width="6.5" height="6.5" rx="1.8"/>',
  sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3z"/>',
  burger: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  arrow: '<path d="M7 17 17 7M9 7h8v8"/>',
};

/** @returns {string} SVG icon by name (app icons and grid, sun, moon, globe, arrow…) for innerHTML. */
export function icon(name, size = 20) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] ?? ICONS.grid}</svg>`;
}

const asset = (path) => new URL(path, import.meta.url).href;

// ---- app header ----

/**
 * A panel toggled by a button: aria-expanded, Esc. Panels of one group exclude each other;
 * a press inside area does not close the panel.
 */
function disclosure(button, panel, group, area, { onOpen, onToggle } = {}) {
  const api = {
    open() {
      if (!panel.hidden) return;
      for (const other of group) if (other !== api) other.close(false);
      panel.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      onToggle?.(true);
      onOpen?.();
    },
    close(focusButton) {
      if (panel.hidden) return;
      panel.hidden = true;
      button.setAttribute('aria-expanded', 'false');
      onToggle?.(false);
      if (focusButton) button.focus();
    },
    get isOpen() { return !panel.hidden; },
    contains: (node) => area.contains(node),
  };
  group.add(api);
  button.addEventListener('click', () => (panel.hidden ? api.open() : api.close(false)));
  const escape = (event) => {
    if (event.key === 'Escape' && api.isOpen) {
      event.preventDefault();
      event.stopPropagation();
      api.close(true);
    }
  };
  panel.addEventListener('keydown', escape);
  button.addEventListener('keydown', escape);
  return api;
}

/** Menu (role=menu) navigation with arrows and Home/End; Tab closes it. */
function menuKeys(menu, close) {
  menu.addEventListener('keydown', (event) => {
    const items = [...menu.querySelectorAll('[role^="menuitem"]')];
    const index = items.indexOf(document.activeElement);
    const move = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 }[event.key];
    if (move !== undefined && items.length) {
      event.preventDefault();
      items[(move + items.length) % items.length].focus();
    } else if (event.key === 'Tab') {
      close(false);
    }
  });
}

/**
 * App header: logo, an optional title, an optional switcher between apps, page navigation;
 * guests get theme, language and "Sign in"; a signed-in user gets an account menu (settings, app
 * items, account page, sign out). On narrow screens the navigation and guest preferences move to
 * a drawer. Content width is --cr-page-width; fluid spans the whole width.
 *
 * @typedef {string|Record<string,string>|((locale: string) => string)} Label
 * @typedef {{id: string, name: Label, summary?: Label, href?: string|null, onSelect?: () => void,
 *   status?: 'live'|'beta'|'soon', icon?: string}} SwitcherItem
 * @param {{
 *   locale: string,
 *   locales?: string[],
 *   title?: Label,
 *   titleUrl?: string|null,
 *   homeUrl?: string,
 *   switcher?: {items: SwitcherItem[], current?: string, guests?: boolean},
 *   nav?: {label: Label, href: string, current?: boolean}[],
 *   navAlign?: 'start'|'center',
 *   fluid?: boolean,
 *   account?: {username?: string, name?: string}|null,
 *   signIn?: string|(() => void),
 *   accountUrl?: string,
 *   preferences?: {get(): {locale: string, theme: string}, preview(value: {locale: string, theme: string}): void|Promise<void>,
 *     save?(value: {locale: string, theme: string}): Promise<boolean|void>|boolean|void, store?(value: {locale: string, theme: string}): void},
 *   items?: {label: Label, onSelect: () => void}[],
 *   onLogout?: () => void,
 *   target?: HTMLElement,
 * }} options
 *   account: undefined while sign-in is being checked, null for a guest, an object for a signed-in user.
 *   switcher: with `current` the button shows that item's name and is visible to guests too; without
 *   it the button reads "Services" and is shown to signed-in users only (override with `guests`).
 *   An item without href and onSelect is shown as unavailable. title is shown when the switcher has
 *   no current item. locales limits the offered languages (one language hides the language controls).
 *   preferences.store keeps every committed choice (guest toggles and applied settings) where the
 *   app keeps it. navAlign: 'center' centres the page navigation.
 * @returns {{element: HTMLElement, setLocale(locale: string): void, setAccount(account?: {username?: string, name?: string}|null): void, openSettings(): Promise<string>, destroy(): void}}
 */
export function mountAppHeader(options) {
  let locale = normalizeLocale(options.locale) ?? 'en';
  let account = options.account;
  const locales = (options.locales ?? LOCALES).filter((value) => LOCALES.includes(value));
  const homeUrl = options.homeUrl ?? '/';
  const switcherItems = options.switcher?.items ?? [];
  const current = switcherItems.find((item) => item.id === options.switcher?.current);
  const switcherForGuests = options.switcher?.guests ?? Boolean(current);
  const nav = options.nav ?? [];
  const popovers = new Set();
  const cleanup = [];

  const navCenter = options.navAlign === 'center';
  const header = element('header', { class: `cr-header${options.fluid ? ' is-fluid' : ''}${nav.length ? ' has-nav' : ''}${nav.length && navCenter ? ' is-nav-center' : ''}` });
  const inner = element('div', { class: 'cr-header-inner' });
  header.append(inner);

  // Logo: light and dark variants, one of them visible according to data-color-scheme.
  const brand = element('a', { class: 'cr-header-brand', href: homeUrl },
    element('img', { class: 'cr-logo cr-logo-light', src: asset('./brand/logo.webp'), width: '126', height: '30', alt: 'Crealika' }),
    element('img', { class: 'cr-logo cr-logo-dark', src: asset('./brand/logo-dark.webp'), width: '126', height: '30', alt: 'Crealika' }));
  inner.append(brand);

  // Title: only when the switcher does not already name the current app.
  let serviceLabel;
  if (!current && options.title) {
    serviceLabel = options.titleUrl ? element('a', { class: 'cr-header-service', href: options.titleUrl }) : element('span', { class: 'cr-header-service' });
    inner.append(serviceLabel);
  }

  // Switcher.
  const switcherId = uid('services');
  const switcherButton = element('button', { type: 'button', class: 'cr-header-button cr-switcher-button', 'aria-expanded': 'false', 'aria-controls': switcherId });
  const switcherList = element('ul', { class: 'cr-switcher-list' });
  const switcherNav = element('nav', { class: 'cr-switcher-panel', id: switcherId, hidden: true }, switcherList);
  const switcherWrap = element('div', { class: `cr-header-popover cr-switcher${current ? ' is-service' : ''}` }, switcherButton, switcherNav);
  const switcher = disclosure(switcherButton, switcherNav, popovers, switcherWrap, {
    onOpen: () => (switcherList.querySelector('[aria-current]') ?? switcherList.querySelector('a'))?.focus(),
  });
  if (switcherItems.length) inner.append(switcherWrap);

  // Page navigation.
  const pageNav = element('nav', { class: 'cr-header-nav' });
  if (nav.length) inner.append(pageNav);

  inner.append(element('span', { class: 'cr-header-spacer' }));
  const actions = element('div', { class: 'cr-header-actions' });
  inner.append(actions);

  // Drawer (narrow screens): navigation and guest preferences.
  const drawerId = uid('drawer');
  const burger = element('button', { type: 'button', class: 'cr-header-button cr-header-burger', 'aria-expanded': 'false', 'aria-controls': drawerId });
  const drawer = element('div', { class: 'cr-header-drawer', id: drawerId, hidden: true });
  const drawerArea = { contains: (node) => drawer.contains(node) || burger.contains(node) };
  const drawerApi = disclosure(burger, drawer, popovers, drawerArea, {
    onOpen: () => drawer.querySelector('a, button')?.focus(),
    onToggle: (open) => {
      header.classList.toggle('is-drawer-open', open);
      renderBurger();
    },
  });
  inner.append(burger);
  header.append(drawer);

  const outside = (event) => {
    for (const popover of popovers) if (popover.isOpen && !popover.contains(event.target)) popover.close(false);
  };
  document.addEventListener('pointerdown', outside);
  cleanup.push(() => document.removeEventListener('pointerdown', outside));
  // Above the breakpoint the drawer is not needed: close it so it does not stay open off-screen.
  const wide = globalThis.matchMedia?.('(min-width: 960px)');
  const closeDrawerOnWide = () => {
    if (wide.matches) drawerApi.close(false);
  };
  wide?.addEventListener('change', closeDrawerOnWide);
  cleanup.push(() => wide?.removeEventListener('change', closeDrawerOnWide));

  const currentChoice = () => document.documentElement.dataset.themeChoice ?? state.choice;
  const currentScheme = () => document.documentElement.dataset.colorScheme ?? 'light';

  /** Guest preferences: applied at once and kept on this device. */
  const commitGuest = (value) => {
    storePreferences(value);
    options.preferences?.store?.({ ...value });
    if (value.locale !== locale) locale = value.locale;
    render();
    Promise.resolve()
      .then(() => options.preferences?.preview?.({ ...value }))
      .catch((error) => console.error('Crealika UI: preview failed', error));
  };
  const setTheme = (choice) => {
    const resolved = applyTheme(choice);
    commitGuest({ locale, theme: resolved.choice });
  };
  const setLanguage = (next) => commitGuest({ locale: next, theme: currentChoice() });

  cleanup.push(onThemeApplied(() => render()));

  const menuEntries = () => {
    const entries = [];
    if (options.preferences) entries.push({ label: (l) => text(l, 'settings'), onSelect: () => controller.openSettings() });
    for (const item of options.items ?? []) entries.push(item);
    if (options.accountUrl) entries.push({ label: (l) => text(l, 'account'), href: options.accountUrl });
    if (options.onLogout) entries.push('separator', { label: (l) => text(l, 'logout'), onSelect: options.onLogout, logout: true });
    return entries;
  };

  function buildGuest(group) {
    const themeButton = element('button', {
      type: 'button',
      class: 'cr-header-button cr-theme-button',
      onclick: () => setTheme(currentScheme() === 'dark' ? state.registry.system.light : state.registry.system.dark),
    });
    const langId = uid('language');
    const langButton = element('button', { type: 'button', class: 'cr-header-button cr-language-button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': langId });
    const langMenu = element('div', { class: 'cr-menu cr-language-menu', role: 'menu', id: langId, hidden: true });
    const langWrap = element('div', { class: 'cr-header-popover cr-language' }, langButton, langMenu);
    const language = disclosure(langButton, langMenu, group, langWrap, {
      onOpen: () => langMenu.querySelector('[aria-checked="true"]')?.focus(),
    });
    langMenu.append(...locales.map((value) => element('button', {
      type: 'button', class: 'cr-menu-item', role: 'menuitemradio', tabindex: '-1', lang: value,
      onclick: () => {
        language.close(true);
        setLanguage(value);
      },
    }, LOCALE_NAMES[value])));
    menuKeys(langMenu, (focus) => language.close(focus));
    langButton.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        language.open();
      }
    });
    const nodes = [element('div', { class: 'cr-header-guest' }, themeButton, locales.length > 1 ? langWrap : null)];
    let signIn;
    if (account === null && options.signIn) {
      signIn = typeof options.signIn === 'function'
        ? element('button', { type: 'button', class: 'cr-button cr-button-primary cr-header-signin', onclick: options.signIn })
        : element('a', { class: 'cr-button cr-button-primary cr-header-signin', href: options.signIn });
      nodes.push(signIn);
    }
    return { kind: 'guest', nodes, themeButton, langButton, langMenu, signIn };
  }

  function buildAccount(group) {
    const menuId = uid('account');
    const button = element('button', { type: 'button', class: 'cr-header-button cr-account-button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-controls': menuId });
    const menu = element('div', { class: 'cr-menu cr-account-menu', role: 'menu', id: menuId, hidden: true });
    const wrap = element('div', { class: 'cr-header-popover cr-account' }, button, menu);
    const api = disclosure(button, menu, group, wrap, { onOpen: () => menu.querySelector('[role="menuitem"]')?.focus() });
    menuKeys(menu, (focus) => api.close(focus));
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        api.open();
      }
    });
    return { kind: 'account', nodes: [wrap], button, menu, api };
  }

  let right;
  let rightPopovers = [];
  function buildRight() {
    for (const popover of rightPopovers) {
      popover.close(false);
      popovers.delete(popover);
    }
    const before = new Set(popovers);
    actions.replaceChildren();
    header.classList.toggle('is-pending', account === undefined);
    header.classList.toggle('is-guest', !account);
    header.classList.toggle('is-signed-in', Boolean(account));
    // Without a current item the switcher is for signed-in users unless `guests` says otherwise.
    if (!account && !switcherForGuests) switcher.close(false);
    switcherWrap.hidden = !account && !switcherForGuests;
    right = account ? buildAccount(popovers) : buildGuest(popovers);
    rightPopovers = [...popovers].filter((popover) => !before.has(popover));
    actions.append(...right.nodes);
    render();
  }

  function renderBurger() {
    burger.innerHTML = icon(drawerApi.isOpen ? 'close' : 'burger', 20);
    burger.setAttribute('aria-label', text(locale, drawerApi.isOpen ? 'closeMenu' : 'openMenu'));
  }

  function renderDrawer() {
    const sections = [];
    if (nav.length) {
      sections.push(element('nav', { class: 'cr-drawer-nav', 'aria-label': text(locale, 'pageNav') },
        ...nav.map((item) => element('a', { href: item.href, 'aria-current': item.current ? 'page' : undefined, onclick: () => drawerApi.close(false) }, localized(item.label, locale)))));
    }
    if (!account) {
      const choice = currentChoice();
      const themes = ['system', state.registry.system.light, state.registry.system.dark];
      const themeName = (value) => (value === 'system' ? text(locale, 'system') : (state.registry.themes.find((item) => item.id === value)?.name[locale] ?? value));
      sections.push(element('div', { class: 'cr-drawer-prefs' },
        element('span', { class: 'cr-drawer-label' }, text(locale, 'theme')),
        element('div', { class: 'cr-segmented', role: 'group', 'aria-label': text(locale, 'theme') },
          ...themes.map((value) => element('button', { type: 'button', 'aria-pressed': String(choice === value), onclick: () => setTheme(value) }, themeName(value)))),
        ...(locales.length > 1 ? [
          element('span', { class: 'cr-drawer-label' }, text(locale, 'language')),
          element('div', { class: 'cr-segmented', role: 'group', 'aria-label': text(locale, 'language') },
            ...locales.map((value) => element('button', { type: 'button', lang: value, 'aria-pressed': String(locale === value), onclick: () => setLanguage(value) }, LOCALE_NAMES[value]))),
        ] : [])));
    }
    // Focus inside the drawer survives a re-render: it returns to the button at the same position.
    const focusables = () => [...drawer.querySelectorAll('a, button')];
    const focusIndex = focusables().indexOf(document.activeElement);
    drawer.replaceChildren(...sections);
    if (focusIndex >= 0) focusables()[focusIndex]?.focus();
  }

  function renderSwitcher() {
    if (!switcherItems.length) return;
    const label = current ? localized(current.name, locale) : text(locale, 'services');
    switcherButton.innerHTML = `${icon(current ? (current.icon ?? current.id) : 'grid', 18)}<span class="cr-switcher-label"></span>${current ? icon('chevron', 16) : ''}`;
    switcherButton.querySelector('.cr-switcher-label').textContent = label;
    switcherButton.setAttribute('aria-label', current ? `${label} — ${text(locale, 'services')}` : label);
    switcherNav.setAttribute('aria-label', text(locale, 'servicesNav'));
    switcherList.replaceChildren(...switcherItems.map((item) => {
      const status = item.status ?? 'live';
      const badge = status === 'live' ? null : element('span', { class: `cr-switcher-badge is-${status}` }, text(locale, status));
      const iconNode = element('span', { class: 'cr-switcher-icon' });
      iconNode.innerHTML = icon(item.icon ?? item.id, 22);
      const body = [iconNode, element('span', { class: 'cr-switcher-text' },
        element('span', { class: 'cr-switcher-name' }, localized(item.name, locale), badge),
        item.summary ? element('span', { class: 'cr-switcher-summary' }, localized(item.summary, locale)) : null)];
      const currentAttr = item.id === current?.id ? 'page' : undefined;
      let node;
      if (item.href && status !== 'soon') {
        node = element('a', { href: item.href, class: 'cr-switcher-item', 'aria-current': currentAttr }, ...body);
      } else if (item.onSelect && status !== 'soon') {
        node = element('button', {
          type: 'button', class: 'cr-switcher-item', 'aria-current': currentAttr,
          onclick: () => {
            switcher.close(false);
            item.onSelect();
          },
        }, ...body);
      } else {
        node = element('span', { class: 'cr-switcher-item is-disabled', 'aria-disabled': 'true' }, ...body);
      }
      return element('li', {}, node);
    }));
  }

  function renderRight() {
    if (right.kind === 'guest') {
      const dark = currentScheme() === 'dark';
      right.themeButton.innerHTML = icon(dark ? 'sun' : 'moon', 18);
      right.themeButton.setAttribute('aria-label', text(locale, dark ? 'toLight' : 'toDark'));
      right.themeButton.title = text(locale, dark ? 'toLight' : 'toDark');
      right.langButton.innerHTML = `${icon('globe', 18)}<span class="cr-language-code">${locale.toUpperCase()}</span>`;
      right.langButton.setAttribute('aria-label', `${text(locale, 'languageMenu')}: ${LOCALE_NAMES[locale]}`);
      for (const item of right.langMenu.children) item.setAttribute('aria-checked', String(item.lang === locale));
      if (right.signIn) right.signIn.textContent = text(locale, 'signIn');
      return;
    }
    const name = account.username || account.name || '';
    right.button.replaceChildren(
      element('span', { class: 'cr-avatar', 'aria-hidden': 'true' }, (name.trim()[0] ?? '•').toUpperCase()),
      element('span', { class: 'cr-account-name' }, name));
    right.button.insertAdjacentHTML('beforeend', icon('chevron', 16));
    right.button.setAttribute('aria-label', name ? `${name} — ${text(locale, 'menu')}` : text(locale, 'menu'));
    const head = name
      ? [element('div', { class: 'cr-account-head' }, element('span', {}, text(locale, 'signedInAs')), element('strong', {}, name)),
        element('div', { class: 'cr-menu-separator', role: 'separator' })]
      : [];
    right.menu.replaceChildren(...head, ...menuEntries().map((entry) => {
      if (entry === 'separator') return element('div', { class: 'cr-menu-separator', role: 'separator' });
      const label = localized(entry.label, locale);
      if (entry.href) return element('a', { class: 'cr-menu-item', role: 'menuitem', tabindex: '-1', href: entry.href }, label);
      return element('button', {
        type: 'button', class: 'cr-menu-item', role: 'menuitem', tabindex: '-1',
        'data-cr-logout': entry.logout ? 'true' : undefined,
        onclick: () => {
          right.api.close(false);
          entry.onSelect();
        },
      }, label);
    }));
  }

  function render() {
    header.lang = locale;
    brand.setAttribute('aria-label', text(locale, 'home'));
    if (serviceLabel) serviceLabel.textContent = localized(options.title, locale);
    renderSwitcher();
    if (nav.length) {
      pageNav.setAttribute('aria-label', text(locale, 'pageNav'));
      pageNav.replaceChildren(...nav.map((item) => element('a', { href: item.href, 'aria-current': item.current ? 'page' : undefined }, localized(item.label, locale))));
    }
    renderRight();
    renderBurger();
    renderDrawer();
  }

  const controller = {
    element: header,
    setLocale(next) {
      locale = normalizeLocale(next) ?? locale;
      render();
    },
    setAccount(next) {
      account = next;
      buildRight();
    },
    openSettings() {
      if (!options.preferences) return Promise.resolve('cancelled');
      const before = locale;
      return openSettings({ preferences: { save: () => true, ...options.preferences }, locales, onLocale: (next) => controller.setLocale(next) })
        .then((result) => {
          if (result !== 'applied') controller.setLocale(options.preferences.get().locale ?? before);
          return result;
        });
    },
    destroy() {
      for (const done of cleanup) done();
      header.remove();
    },
  };

  buildRight();
  (options.target ?? document.body).prepend(header);
  // The guest theme button needs the registry (ids of the light and dark themes); built-in until loaded.
  loadRegistry().then((registry) => {
    state.registry = registry;
    render();
  });
  return controller;
}
