// chat-mcp web UI — vanilla ES module, no build step.
//
// State model: single `state` object holds handle, current target, peers,
// rooms, and the messages for the current view. Every mutation goes through
// the render() function which reconciles by innerHTML-replacing the sidebar
// + message list. For MVP this is fine — small message counts, simple UI.
// If we outgrow it we migrate to React + react-window.

const state = {
  handle: null,
  version: null,
  peers: [],
  rooms: [],
  discoverRooms: [],
  currentTarget: null, // e.g. "#poker" or "@alice"
  messages: [],
  theme: null, // set below
};

const el = {
  app: document.getElementById('app'),
  loading: document.getElementById('loading'),
  myHandle: document.getElementById('my-handle'),
  sidebar: document.getElementById('sidebar'),
  paneTitle: document.getElementById('pane-title'),
  paneMeta: document.getElementById('pane-meta'),
  messages: document.getElementById('messages'),
  composer: document.getElementById('composer'),
  composerInput: document.getElementById('composer-input'),
  composerSend: document.getElementById('composer-send'),
  themeToggle: document.getElementById('theme-toggle'),
};

// ── Theme ────────────────────────────────────────────────────────────────

function applyTheme(theme) {
  state.theme = theme;
  if (theme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  try { localStorage.setItem('chat-mcp:theme', theme); } catch { /* private mode */ }
}

function initTheme() {
  let stored = null;
  try { stored = localStorage.getItem('chat-mcp:theme'); } catch { /* nothing */ }
  if (stored === 'dark' || stored === 'light') {
    applyTheme(stored);
    return;
  }
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  applyTheme(prefersDark ? 'dark' : 'light');
}

el.themeToggle.addEventListener('click', () => {
  applyTheme(state.theme === 'dark' ? 'light' : 'dark');
});

// ── API ──────────────────────────────────────────────────────────────────

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${path} ${res.status}: ${body}`);
  }
  return res.json();
}

async function fetchWhoami() {
  const data = await api('/api/whoami');
  state.handle = data.handle;
  state.version = data.version;
  state.peers = data.peers;
  state.rooms = data.rooms;
  state.discoverRooms = data.discoverRooms;
  el.myHandle.textContent = `${data.handle} · v${data.version}`;
}

async function fetchMessages(target) {
  if (!target) { state.messages = []; return; }
  const messages = await api(`/api/messages?target=${encodeURIComponent(target)}&limit=200`);
  state.messages = messages;
}

async function sendMessage(target, body) {
  return api('/api/messages', {
    method: 'POST',
    body: JSON.stringify({ target, body }),
  });
}

async function joinRoom(room) {
  return api('/api/rooms/join', {
    method: 'POST',
    body: JSON.stringify({ room }),
  });
}

// ── Render ───────────────────────────────────────────────────────────────

function h(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (typeof c === 'string') node.appendChild(document.createTextNode(c));
    else node.appendChild(c);
  }
  return node;
}

function renderSidebar() {
  el.sidebar.innerHTML = '';

  // Peers
  const peersSection = h('div', { className: 'sidebar__section' }, [
    h('div', { className: 'sidebar__heading' }, ['Peers']),
    ...(state.peers.length === 0
      ? [h('div', { className: 'sidebar__empty' }, ['(none online)'])]
      : state.peers.map((p) => sidebarItem({
        label: p.handle,
        target: p.handle,
        online: p.online,
        active: state.currentTarget === p.handle,
      }))),
  ]);
  el.sidebar.appendChild(peersSection);

  // Joined rooms
  const roomsSection = h('div', { className: 'sidebar__section' }, [
    h('div', { className: 'sidebar__heading' }, ['Rooms']),
    ...(state.rooms.length === 0
      ? [h('div', { className: 'sidebar__empty' }, ['(none joined)'])]
      : state.rooms.map((r) => sidebarItem({
        label: r.name,
        target: r.name,
        online: true,
        active: state.currentTarget === r.name,
      }))),
  ]);
  el.sidebar.appendChild(roomsSection);

  // Discover rooms
  if (state.discoverRooms.length > 0) {
    const discoverSection = h('div', { className: 'sidebar__section' }, [
      h('div', { className: 'sidebar__heading' }, ['Discover']),
      ...state.discoverRooms.map((r) =>
        h('div', {
          className: 'sidebar__item sidebar__discover',
          onclick: async () => {
            await joinRoom(r.name);
            await fetchWhoami();
            selectTarget(r.name);
          },
        }, [
          h('span', { className: 'sidebar__item-dot' }),
          h('span', { className: 'sidebar__item-label' }, [`+ ${r.name}`]),
        ])),
    ]);
    el.sidebar.appendChild(discoverSection);
  }
}

function sidebarItem({ label, target, online, active }) {
  return h('div', {
    className: `sidebar__item${online ? ' is-online' : ''}${active ? ' is-active' : ''}`,
    onclick: () => selectTarget(target),
  }, [
    h('span', { className: 'sidebar__item-dot' }),
    h('span', { className: 'sidebar__item-label' }, [label]),
  ]);
}

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function renderMessages() {
  el.messages.innerHTML = '';
  if (!state.currentTarget) {
    el.messages.appendChild(h('div', { className: 'messages__empty' }, ['Select a peer or room from the sidebar.']));
    return;
  }
  if (state.messages.length === 0) {
    el.messages.appendChild(h('div', { className: 'messages__empty' }, ['No messages yet.']));
    return;
  }
  for (const m of state.messages) {
    const isSelf = m.from_handle === state.handle;
    const kind = m.kind || 'chat';
    const cls = ['message', isSelf ? 'is-self' : '', kind === 'dispatch' ? 'is-dispatch' : '', kind === 'alert' ? 'is-alert' : '']
      .filter(Boolean).join(' ');
    const meta = h('div', { className: 'message__meta' }, [
      h('span', { className: 'message__from' }, [m.from_handle]),
      h('span', { className: 'message__time' }, [fmtTime(m.sent_at)]),
      kind !== 'chat' ? h('span', { className: 'message__kind' }, [kind.toUpperCase()]) : null,
    ]);
    const body = h('div', { className: 'message__body', html: m.body_html || '' });
    el.messages.appendChild(h('li', { className: cls }, [meta, body]));
  }
  // Scroll to newest.
  el.messages.scrollTop = el.messages.scrollHeight;
}

function renderPaneHeader() {
  if (!state.currentTarget) {
    el.paneTitle.textContent = 'select a peer or room';
    el.paneMeta.textContent = '';
    el.composerInput.disabled = true;
    el.composerSend.disabled = true;
    return;
  }
  if (state.currentTarget.startsWith('#')) {
    el.paneTitle.textContent = state.currentTarget;
    const room = state.rooms.find((r) => r.name === state.currentTarget);
    el.paneMeta.textContent = room ? `${room.member_count ?? '?'} members` : '';
  } else {
    el.paneTitle.textContent = `DM · ${state.currentTarget}`;
    const peer = state.peers.find((p) => p.handle === state.currentTarget);
    el.paneMeta.textContent = peer ? (peer.online ? 'online' : 'offline') : '';
  }
  el.composerInput.disabled = false;
  el.composerSend.disabled = false;
  el.composerInput.focus();
}

// ── Actions ──────────────────────────────────────────────────────────────

async function selectTarget(target) {
  state.currentTarget = target;
  renderSidebar();
  renderPaneHeader();
  try {
    await fetchMessages(target);
  } catch (e) {
    console.error('fetchMessages failed', e);
    state.messages = [];
  }
  renderMessages();
}

async function refresh() {
  try {
    await fetchWhoami();
    if (state.currentTarget) await fetchMessages(state.currentTarget);
    renderSidebar();
    renderPaneHeader();
    renderMessages();
  } catch (e) {
    console.error('refresh failed', e);
  }
}

// ── Composer ─────────────────────────────────────────────────────────────

el.composerInput.addEventListener('input', () => {
  // Auto-grow up to CSS max-height.
  el.composerInput.style.height = 'auto';
  el.composerInput.style.height = el.composerInput.scrollHeight + 'px';
});

el.composerInput.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    el.composer.requestSubmit();
  }
});

el.composer.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = el.composerInput.value.trim();
  if (!body || !state.currentTarget) return;
  el.composerSend.disabled = true;
  try {
    await sendMessage(state.currentTarget, body);
    el.composerInput.value = '';
    el.composerInput.style.height = 'auto';
    await refresh();
  } catch (e) {
    console.error('send failed', e);
    alert(`Send failed: ${e.message}`);
  } finally {
    el.composerSend.disabled = false;
    el.composerInput.focus();
  }
});

// ── SSE ──────────────────────────────────────────────────────────────────

function connectSse() {
  const source = new EventSource('/api/events');
  source.addEventListener('wake', () => { refresh(); });
  source.addEventListener('error', () => {
    // EventSource auto-reconnects. Just log for debugging.
    // console.warn('SSE dropped, browser will retry');
  });
}

// ── Boot ─────────────────────────────────────────────────────────────────

async function boot() {
  initTheme();
  try {
    await fetchWhoami();
  } catch (e) {
    el.loading.textContent = `Failed to reach server: ${e.message}`;
    return;
  }
  el.loading.hidden = true;
  el.app.hidden = false;
  renderSidebar();
  renderPaneHeader();
  renderMessages();
  connectSse();
}

boot();
