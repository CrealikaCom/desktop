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

function renderAccount(st) {
  const user = st.session.user;
  const parts = [];
  if (st.signIn) {
    parts.push(el('span', { className: 'muted', textContent: 'Signing in…' }));
    parts.push(button('Cancel', () => api.cancelSignIn()));
  } else if (user) {
    parts.push(el('span', { textContent: `@${user.username ?? user.sub}` }));
    parts.push(button('Sign out', () => api.signOut()));
  } else {
    parts.push(el('span', { className: 'muted', textContent: 'Guest' }));
    parts.push(button('Sign in', () => api.signIn(), { primary: true }));
  }
  $('account').replaceChildren(...parts);

  const notes = [];
  if (st.signIn) {
    notes.push(el('p', { textContent: 'Finish signing in with Crealika ID in your browser.' }));
    if (st.signIn.url) {
      notes.push(el('p', {}, [button('Open the sign-in page again', () => api.reopenSignIn())]));
      const link = el('details', {}, [
        el('summary', { className: 'muted small', textContent: 'Show link' }),
        el('p', { className: 'muted small', textContent: st.signIn.url }),
      ]);
      // Re-rendering every few seconds must not fold the link back up.
      link.open = Boolean(document.querySelector('#notice details')?.open);
      notes.push(link);
    }
  }
  if (st.signInError) notes.push(el('p', { className: 'error', textContent: st.signInError }));
  if (user && st.weakStorage) {
    notes.push(el('p', {
      className: 'muted',
      textContent: 'No system keyring was found, so the sign-in is stored without strong encryption.',
    }));
  }
  $('notice').hidden = !notes.length;
  $('notice').replaceChildren(...notes);
}

async function render() {
  const st = await api.state();
  $('home').textContent = st.home;
  renderAccount(st);
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
