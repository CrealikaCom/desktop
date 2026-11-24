// Crealika ID session for this process (launcher or service host), stored in the shared
// home directory and encrypted with the OS keychain through Electron safeStorage.
import path from 'node:path';
import { safeStorage } from 'electron';
import { createCrealikaId, resolveIssuer } from './core/crealika-id.js';
import { createSession } from './core/session.js';
import { SessionStore } from './core/session-store.js';

export function createAppSession(lay) {
  const providers = new Map();
  const idpFor = (issuer) => {
    if (!providers.has(issuer)) providers.set(issuer, createCrealikaId({ issuer }));
    return providers.get(issuer);
  };
  const store = new SessionStore({
    file: path.join(lay.config, 'crealika-id.session'),
    lockFile: path.join(lay.config, 'crealika-id.lock'),
    encrypt: (text) => safeStorage.encryptString(text),
    decrypt: (buf) => safeStorage.decryptString(buf),
  });
  // Refresh and revoke go to the issuer the session came from, not the current default.
  const session = createSession({
    store,
    refresh: (d) => idpFor(d.issuer).refresh(d),
    revoke: (d) => idpFor(d.issuer).revoke(d),
  });
  return {
    session,
    idp: () => idpFor(resolveIssuer()),
    // On Linux without a keyring Chromium falls back to a fixed key ("basic_text").
    weakStorage: () => process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text',
  };
}
