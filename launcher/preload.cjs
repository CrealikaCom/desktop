// Bridge from the launcher window to the main process. Service windows get no preload.
const { contextBridge, ipcRenderer } = require('electron');

async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

contextBridge.exposeInMainWorld('launcher', {
  state: () => call('state'),
  install: (id) => call('install', id),
  uninstall: (id) => call('uninstall', id),
  open: (id) => call('open', id),
  stop: (id) => call('stop', id),
  openFolder: (kind) => call('open-folder', kind),
  signIn: () => call('sign-in'),
  cancelSignIn: () => call('sign-in-cancel'),
  reopenSignIn: () => call('sign-in-reopen'),
  signOut: () => call('sign-out'),
  setPreferences: (update) => call('set-preferences', update),
  onChange: (fn) => ipcRenderer.on('state-changed', () => fn()),
});
