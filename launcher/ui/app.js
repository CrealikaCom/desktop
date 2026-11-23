const api = window.launcher;
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, children = []) {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...children);
  return n;
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

function button(label, onClick, { primary = false, disabled = false } = {}) {
  return el('button', { textContent: label, className: primary ? 'primary' : '', disabled, onclick: () => act(onClick) });
}

function serviceCard(s) {
  const status = s.busy
    ? 'Please wait…'
    : s.installed?.broken
      ? `Broken: ${s.installed.broken}`
      : s.installed
        ? `Installed ${s.installed.version}${s.running ? ' · running' : ''}`
        : 'Not installed';
  const actions = [];
  if (!s.busy) {
    if (s.installed && !s.installed.broken) actions.push(button('Open', () => api.open(s.id), { primary: true }));
    if (s.running) actions.push(button('Stop', () => api.stop(s.id)));
    if (s.source) actions.push(button(s.installed ? 'Reinstall' : 'Install', () => api.install(s.id), { primary: !s.installed, disabled: s.running }));
    if (s.installed) actions.push(button('Uninstall', () => api.uninstall(s.id), { disabled: s.running }));
  }
  return el('li', { className: 'card' }, [
    el('div', { className: 'info' }, [
      el('h2', { textContent: s.name }),
      el('p', { textContent: s.description }),
      el('p', { className: 'muted', textContent: status }),
      el('p', { className: 'muted small', textContent: s.source ?? 'not in the catalog' }),
    ]),
    el('div', { className: 'actions' }, actions),
  ]);
}

async function render() {
  const st = await api.state();
  $('home').textContent = st.home;
  $('session').textContent = st.session.user ? st.session.user.name : 'Guest';
  $('services').replaceChildren(
    ...(st.services.length
      ? st.services.map(serviceCard)
      : [el('li', { className: 'muted', textContent: `No services yet. Add a source to ${st.home}/config/catalog.json.` })]),
  );
}

for (const b of document.querySelectorAll('[data-folder]')) {
  b.addEventListener('click', () => act(() => api.openFolder(b.dataset.folder)));
}
api.onChange(() => render().catch(showError));
render().catch(showError);
