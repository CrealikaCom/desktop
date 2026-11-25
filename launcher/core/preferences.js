// Interface preferences shared by the launcher and every service: locale and theme, kept in
// <home>/config/preferences.json. Values follow the Crealika UI core contract: a locale code and
// `system` or a theme id.
import fs from 'node:fs/promises';
import path from 'node:path';

// The interface is English-only for now; more locales come with localization.
export const LOCALES = Object.freeze(['en']);
export const DEFAULTS = Object.freeze({ locale: 'en', theme: 'system' });
const THEME_ID = /^[a-z][a-z0-9-]{0,31}$/;

export function normalizePreferences(value, base = DEFAULTS) {
  const locale = LOCALES.includes(value?.locale) ? value.locale : base.locale;
  const theme = typeof value?.theme === 'string' && THEME_ID.test(value.theme) ? value.theme : base.theme;
  return { locale, theme };
}

// Electron nativeTheme.themeSource for a theme choice: unknown theme ids follow the system.
export function themeSource(theme) {
  return theme === 'light' || theme === 'dark' ? theme : 'system';
}

export function createPreferences(lay) {
  const file = path.join(lay.config, 'preferences.json');
  return {
    file,
    async read() {
      try {
        return normalizePreferences(JSON.parse(await fs.readFile(file, 'utf8')));
      } catch {
        return { ...DEFAULTS };
      }
    },
    /** Merges a partial update and returns the stored result. */
    async write(update) {
      const next = normalizePreferences(update, await this.read());
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
      await fs.rename(tmp, file);
      return next;
    },
  };
}
