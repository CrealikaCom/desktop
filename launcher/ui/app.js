// Launcher window: the Crealika UI core header, the list of services and the shared engines.
import { applyTheme, mountAppHeader } from '/crealika-ui-core/crealika-ui.js';

const api = window.launcher;
const $ = (id) => document.getElementById(id);
let state = null;
// Card highlighted after a service window asked to show it: { id, until }.
let highlight = null;
const HIGHLIGHT_MS = 4000;

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

const headerOptions = {
  locale: 'en',
  locales: ['en'],
  title: 'Desktop',
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
};
let header = mountAppHeader({ ...headerOptions, account: undefined });

// The header switcher lists the installed services, like the switcher in service windows but
// without the ones still to install (their cards are here). Choosing one opens it like its Open
// button: focuses its window or starts it.
function launcherSwitcher(services) {
  const installed = services.filter((s) => s.installed && !s.installed.broken).sort((a, b) => a.name.localeCompare(b.name));
  if (!installed.length) return undefined;
  return {
    current: 'desktop',
    items: [
      { id: 'desktop', name: 'Desktop', listed: false },
      ...installed.map((s) => ({ id: s.id, name: s.name, onSelect: () => act(() => api.open(s.id)) })),
    ],
  };
}

const engineName = (id) => state?.engines.find((e) => e.id === id)?.name ?? id;

function serviceCard(s) {
  let status = s.version ? `Not installed · ${s.version}` : 'Not installed';
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
  const lit = highlight?.id === s.id && Date.now() < highlight.until;
  return el('li', { className: `launcher-card${lit ? ' is-highlighted' : ''}`, id: `service-${s.id}` }, [
    el('div', { className: 'launcher-card-info' }, [
      el('h2', { textContent: s.name }),
      s.description ? el('p', { textContent: s.description }) : null,
      el('p', { className: 'launcher-status', textContent: status }),
      s.engines.length ? el('p', { className: 'launcher-status', textContent: `Uses ${s.engines.map(engineName).join(', ')}` }) : null,
      el('p', { className: 'launcher-source', textContent: s.source ?? 'not in the catalog' }),
    ]),
    el('div', { className: 'launcher-actions' }, actions),
  ]);
}

const ACCEL_NAMES = { cpu: 'CPU', vulkan: 'Vulkan (GPU)', cuda: 'CUDA (NVIDIA)', metal: 'Metal (Apple GPU)' };
const mb = (bytes) => `${Math.round(bytes / 1e6)} MB`;
// Build chosen in the select of each engine card, kept across re-renders.
const chosen = new Map();

function engineCard(e) {
  const accelName = (a) => ACCEL_NAMES[a] ?? a;
  let status = 'Not installed';
  if (e.progress) {
    status = e.progress.total ? `Downloading ${mb(e.progress.received)} of ${mb(e.progress.total)}` : `Downloading ${mb(e.progress.received)}`;
  } else if (e.busy) status = 'Please wait…';
  else if (e.installed) {
    status = `Installed ${e.installed.version} · ${accelName(e.installed.accel)}`;
    if (e.installed.version !== e.version) status += ` · ${e.version} available`;
  }
  const serviceName = (id) => state?.services.find((x) => x.id === id)?.name ?? id;
  if (e.running) {
    status += ` · running for ${e.running.services.map(serviceName).join(', ') || 'no service'}`;
    const models = e.running.instances.map((i) => i.model).filter(Boolean);
    if (models.length) status += ` (${models.join(', ')})`;
  }

  const actions = [];
  if (!e.builds.length) {
    status = 'No build for this computer yet';
  } else if (!e.busy) {
    const current = chosen.get(e.id) ?? e.installed?.accel ?? e.recommended;
    const select = el('select', {
      ariaLabel: `${e.name} build`,
      disabled: Boolean(e.running),
      onchange: (ev) => {
        chosen.set(e.id, ev.target.value);
        render().catch(showError);
      },
    }, e.builds.map((b) => el('option', {
      value: b.accel,
      selected: b.accel === current,
      textContent: `${accelName(b.accel)}${b.size ? `, ${mb(b.size)}` : ''}${b.accel === e.recommended ? ' (recommended)' : ''}`,
    })));
    actions.push(el('div', { className: 'cr-field' }, [select]));
    const same = e.installed && e.installed.accel === current && e.installed.version === e.version;
    const label = !e.installed ? 'Install' : same ? 'Reinstall' : e.installed.accel === current ? 'Update' : 'Switch';
    actions.push(button(label, () => api.installEngine(e.id, current), { primary: !same, disabled: Boolean(e.running) }));
    if (e.installed) actions.push(button('Remove', () => api.uninstallEngine(e.id), { disabled: Boolean(e.running) }));
  }
  const bar = e.progress?.total ? el('progress', { className: 'launcher-progress', max: e.progress.total, value: e.progress.received }) : null;
  return el('li', { className: 'launcher-card' }, [
    el('div', { className: 'launcher-card-info' }, [
      el('h2', { textContent: `${e.name} ${e.version}` }),
      e.description ? el('p', { textContent: e.description }) : null,
      el('p', { className: 'launcher-status', textContent: status }),
      bar,
      el('p', { className: 'launcher-source', textContent: `Models: ${e.models}` }),
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
let shownSwitcher = '[]';

async function render() {
  state = await api.state();
  if (state.preferences.theme !== shownTheme) {
    shownTheme = state.preferences.theme;
    applyTheme(shownTheme);
  }
  const user = state.session.user;
  const key = user ? user.sub : null;
  const account = user ? { username: user.username ?? user.sub } : null;
  // The header takes its switcher when it is mounted, so a new set of installed services mounts
  // it again.
  const switcher = launcherSwitcher(state.services);
  const switcherKey = JSON.stringify(switcher?.items.map((item) => [item.id, item.name]) ?? []);
  if (switcherKey !== shownSwitcher) {
    shownSwitcher = switcherKey;
    shownUser = key;
    header.destroy();
    header = mountAppHeader({ ...headerOptions, switcher, account });
  } else if (key !== shownUser) {
    shownUser = key;
    header.setAccount(account);
  }
  renderNotice(state);
  $('home').textContent = state.home;
  $('services').replaceChildren(
    ...(state.services.length
      ? state.services.map(serviceCard)
      : [el('li', { className: 'launcher-empty', textContent: `No services yet. Add a source to ${state.home}/config/catalog.json.` })]),
  );
  $('engines').replaceChildren(
    ...(state.engines.length ? state.engines.map(engineCard) : [el('li', { className: 'launcher-empty', textContent: 'No engines in the catalog.' })]),
  );
  $('external').hidden = !state.external.length;
  $('external').textContent = state.external.length
    ? `Also running on this computer: ${state.external.map((x) => `${x.name} at ${x.url}`).join(', ')}. Services can use them too.`
    : '';
}

for (const b of document.querySelectorAll('[data-folder]')) {
  b.addEventListener('click', () => act(() => api.openFolder(b.dataset.folder)));
}
async function showRequested() {
  const id = await api.takeShow();
  if (!id) return;
  highlight = { id, until: Date.now() + HIGHLIGHT_MS };
  await render();
  $(`service-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => render().catch(showError), HIGHLIGHT_MS);
}

api.onChange(() => render().catch(showError));
api.onShow(() => showRequested().catch(showError));
render()
  .then(showRequested)
  .catch(showError);
