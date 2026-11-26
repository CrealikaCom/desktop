/** Types of the public crealika-ui.js API for TypeScript apps. Contract: README.md. */

export declare const VERSION: string;
export declare const STORAGE_KEY: string;
export declare const LOCALES: readonly string[];
export declare const LOCALE_NAMES: Readonly<Record<string, string>>;

export interface Preferences {
  locale: string;
  theme: string;
}

export interface StoredPreferences {
  locale?: string;
  theme?: string;
  scheme?: "light" | "dark";
  loginId?: string;
}

export interface AccountPreferences {
  locale?: string | null;
  theme?: string | null;
  loginId?: string;
}

export interface ThemeEntry {
  id: string;
  colorScheme: "light" | "dark";
  name: Record<string, string>;
}

export interface ThemeRegistry {
  system: { light: string; dark: string };
  themes: ThemeEntry[];
}

export interface ResolvedTheme {
  choice: string;
  theme: string;
  scheme: "light" | "dark";
}

export interface PreferencesAdapter {
  /** The values applied right now. */
  get(): Preferences;
  /** Re-render the app with the chosen values (without saving). */
  preview(value: Preferences): void | Promise<void>;
  /** Save to the account; false or a rejection means the values stay on this device only. */
  save?(value: Preferences): boolean | void | Promise<boolean | void>;
  /** Keep every committed choice where the app keeps it (besides local storage). */
  store?(value: Preferences): void;
}

/** A label: a string, a per-locale object or a function of the locale. */
export type Localized = string | Partial<Record<string, string>> | ((locale: string) => string);

export interface SwitcherItem {
  id: string;
  name: Localized;
  summary?: Localized;
  /** A link; without href and onSelect the item is shown as unavailable. */
  href?: string | null;
  onSelect?: () => void;
  status?: "live" | "beta" | "soon";
  /** Icon name for icon(); defaults to the item id. */
  icon?: string;
  /** false: labels the switcher button when current, but is not shown in the list. */
  listed?: boolean;
}

export interface NavItem {
  label: Localized;
  href: string;
  current?: boolean;
}

export interface MenuItem {
  label: Localized;
  onSelect: () => void;
}

export interface Account {
  username?: string;
  name?: string;
}

export interface AppHeaderOptions {
  locale: string;
  /** Offered languages (all supported by default); one language hides the language controls. */
  locales?: string[];
  /** Shown next to the logo when the switcher does not name the current app. */
  title?: Localized;
  titleUrl?: string | null;
  homeUrl?: string;
  /** With `current` the button shows that item and is visible to guests too. */
  switcher?: { items: SwitcherItem[]; current?: string; guests?: boolean };
  nav?: NavItem[];
  navAlign?: "start" | "center";
  /** Full-width header (full-screen editors). */
  fluid?: boolean;
  /** undefined while sign-in is being checked, null for a guest, an object for a signed-in user. */
  account?: Account | null;
  signIn?: string | (() => void);
  accountUrl?: string;
  preferences?: PreferencesAdapter;
  items?: MenuItem[];
  onLogout?: () => void;
  target?: HTMLElement;
}

export interface AppHeaderController {
  element: HTMLElement;
  setLocale(locale: string): void;
  setAccount(account?: Account | null): void;
  openSettings(): Promise<"applied" | "cancelled">;
  destroy(): void;
}

export declare function text(locale: string | undefined, key: string): string;
export declare function normalizeLocale(value: unknown): string | undefined;
export declare function isThemeChoice(value: unknown): value is string;
export declare function parseStored(raw: string | null): StoredPreferences | null;
export declare function readStored(storage?: Storage): StoredPreferences | null;
export declare function writeStored(value: StoredPreferences, storage?: Storage): boolean;
export declare function validateRegistry(data: unknown): ThemeRegistry;
export declare function loadRegistry(): Promise<ThemeRegistry>;
export declare function resolveTheme(choice: string, registry: ThemeRegistry, prefersDark: boolean): ResolvedTheme;
export declare function initialPreferences(input: {
  defaultLocale: string;
  account?: AccountPreferences;
  stored?: StoredPreferences | null;
}): Preferences & { loginId?: string; fromAccount: boolean };
export declare function applyTheme(choice: string, registry?: ThemeRegistry): ResolvedTheme;
export declare function onThemeApplied(listener: (resolved: ResolvedTheme) => void): () => void;
export declare function startPreferences(options: {
  defaultLocale: string;
  account?: AccountPreferences;
}): Promise<Preferences & { registry: ThemeRegistry; fromAccount: boolean }>;
export declare function storePreferences(value: Preferences): boolean;
export declare function showToast(message: string, timeout?: number): HTMLElement;
export declare function createDropzone(options: {
  label: string;
  hint?: string;
  accept?: string;
  onFile: (file: File) => void;
}): { element: HTMLElement; setDisabled(disabled: boolean): void };
export declare function createBusy(options: {
  title: string;
  hint?: string;
  startedAt?: number;
  elapsed?: (seconds: number) => string;
  action?: HTMLElement;
}): {
  element: HTMLElement;
  update(next: { title?: string; hint?: string; progress?: number | null }): void;
  stop(): void;
};
export declare function sliderValue(raw: unknown, range?: { min?: number; max?: number; step?: number }): number;
export declare function createSlider(options: {
  label: string;
  min?: number;
  max?: number;
  step?: number;
  value?: number;
  format?: (value: number) => string;
  onInput?: (value: number) => void;
  onChange?: (value: number) => void;
  disabled?: boolean;
}): {
  element: HTMLElement;
  input: HTMLInputElement;
  readonly value: number;
  setValue(value: number): void;
  setLabel(label: string): void;
  setDisabled(disabled: boolean): void;
};
export declare function openSettings(options: {
  preferences: PreferencesAdapter;
  onLocale?: (locale: string) => void;
  locales?: string[];
}): Promise<"applied" | "cancelled">;
export declare function localized(value: Localized | undefined, locale: string): string;
export declare function icon(name: string, size?: number): string;
export declare function mountAppHeader(options: AppHeaderOptions): AppHeaderController;
