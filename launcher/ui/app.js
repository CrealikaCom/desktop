// Launcher window: the Crealika UI core header and the list of services.
import { applyTheme, mountAppHeader } from '/crealika-ui-core/crealika-ui.js';

const api = window.launcher;
const $ = (id) => document.getElementById(id);
let state = null;

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

function showError(err) {
  $('error').hidden = !err;
  $('error').textContent = err ? String(err.message ?? err) : '';
}

async function act(fn) {
  showError(null);
  try {
    await fn();
  } catch (err) {
    showError(err);
  }
  await render();
}

function button(label, onClick, { primary = false, danger = false, disabled = false } = {}) {
  const kind = primary ? ' cr-button-primary' : danger ? ' cr-button-danger' : '';
  return el('button', { type: 'button', className: `cr-button${kind}`, textContent: label, disabled, onclick: () => act(onClick) });
}

const header = mountAppHeader({
  locale: 'en',
  locales: ['en'],
  title: 'Desktop',
  account: undefined,
  signIn: () => act(() => api.signIn()),
  onLogout: () => act(() => api.signOut()),
  preferences: {
    get: () => ({ locale: 'en', theme: state?.preferences.theme ?? 'system' }),
    preview: (value) => {
      applyTheme(value.theme);
    },
    store: (value) => {
      api.setPreferences(value).catch(showError);
    },
  },
});

function serviceCard(s) {
  let status = 'Not installed';
  if (s.busy) status = 'Please wait…';
  else if (s.installed?.broken) status = `Broken: ${s.installed.broken}`;
  else if (s.installed) status = `Installed ${s.installed.version}${s.running ? ' · running' : ''}`;
  const actions = [];
  if (!s.busy) {
    if (s.installed && !s.installed.broken) actions.push(button('Open', () => api.open(s.id), { primary: true }));
    if (s.running) actions.push(button('Stop', () => api.stop(s.id)));
    if (s.source) actions.push(button(s.installed ? 'Reinstall' : 'Install', () => api.install(s.id), { primary: !s.installed, disabled: s.running }));
    if (s.installed) actions.push(button('Uninstall', () => api.uninstall(s.id), { disabled: s.running }));
  }
  return el('li', { className: 'launcher-card' }, [
    el('div', { className: 'launcher-card-info' }, [
      el('h2', { textContent: s.name }),
      s.description ? el('p', { textContent: s.description }) : null,
      el('p', { className: 'launcher-status', textContent: status }),
      el('p', { className: 'launcher-source', textContent: s.source ?? 'not in the catalog' }),
    ]),
    el('div', { className: 'launcher-actions' }, actions),
  ]);
}

function renderNotice(st) {
  const notes = [];
  if (st.signIn) {
    notes.push(el('p', { textContent: 'Finish signing in with Crealika ID in your browser.' }));
    notes.push(el('p', {}, [
      button('Open the sign-in page again', () => api.reopenSignIn()),
      ' ',
      button('Cancel', () => api.cancelSignIn()),
    ]));
  }
  if (st.signInError) notes.push(el('p', { className: 'launcher-error', textContent: st.signInError }));
  if (st.session.user && st.weakStorage) {
    notes.push(el('p', { textContent: 'No system keyring was found, so the sign-in is stored without strong encryption.' }));
  }
  $('notice').hidden = !notes.length;
  $('notice').replaceChildren(...notes);
}

let shownTheme = null;
let shownUser;

async function render() {
  state = await api.state();
  if (state.preferences.theme !== shownTheme) {
    shownTheme = state.preferences.theme;
    applyTheme(shownTheme);
  }
  const user = state.session.user;
  const key = user ? user.sub : null;
  if (key !== shownUser) {
    shownUser = key;
    header.setAccount(user ? { username: user.username ?? user.sub } : null);
  }
  renderNotice(state);
  $('home').textContent = state.home;
  $('services').replaceChildren(
    ...(state.services.length
      ? state.services.map(serviceCard)
      : [el('li', { className: 'launcher-empty', textContent: `No services yet. Add a source to ${state.home}/config/catalog.json.` })]),
  );
}

for (const b of document.querySelectorAll('[data-folder]')) {
  b.addEventListener('click', () => act(() => api.openFolder(b.dataset.folder)));
}
api.onChange(() => render().catch(showError));
render().catch(showError);
