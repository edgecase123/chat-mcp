// chat-mcp web UI — vanilla ES module, no build step.
//
// 🛑 THE DECISIONS LIVE IN ./logic.js, NOT HERE. This file owns the DOM and
// the events; anything that can be decided from values alone is imported, so
// it can be tested without a DOM. See chat-mcp#52.
import {
  acceptReopens,
  isPinnedToBottom,
  jumpLabel,
  moveIndex,
  nextUnreadBelow,
  shouldShowJump,
  suggestionsFor,
  enterShouldSend,
  menuEntriesFor,
  mentionSuggestionsFor,
  pushHistory,
  historyStep,
  historyKeyApplies,
} from './logic.js';
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
  renderedCount: 0, // list length at last render, so a delta gives the unread count
  unreadBelow: 0,   // messages that arrived while the reader was scrolled up
  suggest: null,     // { items, index, kind, token } while the composer popover is open
  history: { entries: [], index: null, draft: null },
  openMenuFor: null, // sidebar target whose (...) menu is open. NOT in the DOM:
                     // renderSidebar() wipes it on every peer status change.
  approvals: [],
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
  jumpNewest: document.getElementById('jump-newest'),
  suggest: document.getElementById('composer-suggest'),
  approvals: document.getElementById('approvals'),
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

  // Marking read is a separate POST on purpose: a mutation on the GET above
  // would fire from an <img> tag on any page the operator visits.
  if (target.startsWith('#') && messages.length > 0) {
    const newest = messages.reduce((max, m) => Math.max(max, m.id), 0);
    try {
      await api('/api/rooms/read', { method: 'POST', body: JSON.stringify({ room: target, up_to_id: newest }) });
    } catch { /* the badge is stale until the next open; not worth a toast */ }
  }
}

async function sendMessage(target, body, kind = 'chat') {
  return api('/api/messages', {
    method: 'POST',
    body: JSON.stringify({ target, body, kind }),
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
        kind: 'peer',
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
        kind: 'room',
        unread: r.unread ?? 0,
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

function sidebarItem({ label, target, online, active, kind, unread = 0 }) {
  const open = state.openMenuFor === target;
  return h('div', {
    className: `sidebar__item${online ? ' is-online' : ''}${active ? ' is-active' : ''}`,
    onclick: () => selectTarget(target),
  }, [
    h('span', { className: 'sidebar__item-dot' }),
    h('span', { className: 'sidebar__item-label' }, [label]),
    unread > 0 ? h('span', { className: 'sidebar__item-unread' }, [`(${unread})`]) : null,
    h('button', {
      className: 'sidebar__item-actions',
      type: 'button',
      'aria-label': `Actions for ${label}`,
      'aria-expanded': open ? 'true' : 'false',
      // Without this the row's own click runs too and switches conversation.
      onclick: (e) => { e.stopPropagation(); toggleItemMenu(target); },
    }, ['\u22ef']),
    open ? itemMenu({ target, kind, label }) : null,
  ]);
}

function itemMenu({ kind, label }) {
  const handlers = {
    deleteRoom: () => deleteRoomEntry(label),
    kickPeer: () => kickPeer(label),
  };
  const entries = menuEntriesFor(kind, label)
    .map((e) => menuEntry(e.text, e.title, handlers[e.action]));
  return h('div', {
    className: 'item-menu',
    role: 'menu',
    onclick: (e) => e.stopPropagation(),
  }, entries);
}

function menuEntry(text, title, action) {
  return h('button', {
    className: 'item-menu__entry is-destructive',
    type: 'button',
    role: 'menuitem',
    title,
    onclick: () => { closeItemMenu(); action(); },
  }, [text]);
}

async function deleteRoomEntry(room) {
  const ok = window.confirm(
    `Delete ${room}?\n\n`
    + 'The room, every membership and every message ever sent to it are '
    + 'deleted for EVERYONE, not just you. This cannot be undone.',
  );
  if (!ok) return;
  try {
    await api('/api/rooms/delete', { method: 'POST', body: JSON.stringify({ room }) });
    toast(`deleted ${room}`, 'info');
    if (state.currentTarget === room) state.currentTarget = null;
    await fetchWhoami();
    renderSidebar();
    renderPaneHeader();
    renderMessages({ forceBottom: true });
  } catch (e) {
    toast(`delete failed: ${e.message}`, 'error');
  }
}

function toggleItemMenu(target) {
  state.openMenuFor = state.openMenuFor === target ? null : target;
  renderSidebar();
}

function closeItemMenu() {
  if (state.openMenuFor === null) return;
  state.openMenuFor = null;
  renderSidebar();
}

async function kickPeer(handle) {
  // Destructive, and one click here where the CLI makes you type it.
  const ok = window.confirm(
    `Kick ${handle} from the bus?\n\n`
    + 'Their agent row, room memberships and read marks are deleted. '
    + 'Messages they sent stay. A running shim re-registers on its next touch.',
  );
  if (!ok) return;
  try {
    await api('/api/kick', { method: 'POST', body: JSON.stringify({ handle }) });
    toast(`kicked ${handle}`, 'info');
    await fetchWhoami();
    renderSidebar();
  } catch (e) {
    toast(`kick failed: ${e.message}`, 'error');
  }
}

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** The one place the DOM's geometry is read. Everything downstream is pure. */
function streamGeometry() {
  return {
    scrollTop: el.messages.scrollTop,
    scrollHeight: el.messages.scrollHeight,
    clientHeight: el.messages.clientHeight,
  };
}

function jumpToNewest() {
  el.messages.scrollTo({ top: el.messages.scrollHeight, behavior: 'instant' });
  state.unreadBelow = 0;
  renderJumpNewest();
}

function renderJumpNewest() {
  el.jumpNewest.hidden = !shouldShowJump(state.unreadBelow, streamGeometry());
  if (el.jumpNewest.hidden) return;
  const label = jumpLabel(state.unreadBelow);
  if (el.jumpNewest.textContent !== label) el.jumpNewest.textContent = label;
}

function resetStreamPosition() {
  state.renderedCount = 0;
  state.unreadBelow = 0;
  renderJumpNewest();
}

function renderMessages({ forceBottom = false } = {}) {
  // Measured BEFORE the wipe below destroys both of them.
  const wasPinned = forceBottom || isPinnedToBottom(streamGeometry());
  const prevScrollTop = el.messages.scrollTop;
  const arrived = Math.max(0, state.messages.length - state.renderedCount);

  el.messages.innerHTML = '';
  if (!state.currentTarget) {
    el.messages.appendChild(h('div', { className: 'messages__empty' }, ['Select a peer or room from the sidebar.']));
    resetStreamPosition();
    return;
  }
  if (state.messages.length === 0) {
    el.messages.appendChild(h('div', { className: 'messages__empty' }, ['No messages yet.']));
    resetStreamPosition();
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
  state.renderedCount = state.messages.length;

  // Jump INSTANT, never animated: a smooth scroll on room open reads as the
  // view sliding away on its own. Scrolled up, we hold position instead and
  // offer the jump, so reading is never interrupted.
  state.unreadBelow = nextUnreadBelow(state.unreadBelow, arrived, wasPinned);
  if (wasPinned) {
    el.messages.scrollTo({ top: el.messages.scrollHeight, behavior: 'instant' });
  } else {
    el.messages.scrollTop = prevScrollTop;
  }
  renderJumpNewest();
}

function renderPaneHeader() {
  el.composerInput.disabled = false;
  el.composerSend.disabled = false;
  if (!state.currentTarget) {
    el.paneTitle.textContent = 'select a peer or room';
    el.paneMeta.textContent = 'type /help for commands';
    el.composerInput.placeholder = 'Type /dm <peer> or /join #room to get started. /help for commands.';
    return;
  }
  el.composerInput.placeholder = 'Type a message. Shift-Enter for newline.';
  if (state.currentTarget.startsWith('#')) {
    el.paneTitle.textContent = state.currentTarget;
    const room = state.rooms.find((r) => r.name === state.currentTarget);
    el.paneMeta.textContent = room ? `${room.member_count ?? '?'} members` : '';
  } else {
    el.paneTitle.textContent = `DM · ${state.currentTarget}`;
    const peer = state.peers.find((p) => p.handle === state.currentTarget);
    el.paneMeta.textContent = peer ? (peer.online ? 'online' : 'offline') : '';
  }
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
  renderMessages({ forceBottom: true });
  // The fetch above marked the room read server-side. Pull the counts back so
  // the badge clears now rather than at the next inbound message.
  await fetchWhoami();
  renderSidebar();
}

async function refresh() {
  try {
    await fetchWhoami();
    await fetchApprovals();
    if (state.currentTarget) await fetchMessages(state.currentTarget);
    renderSidebar();
    renderPaneHeader();
    renderApprovals();
    renderMessages();
  } catch (e) {
    console.error('refresh failed', e);
  }
}


// ── Approvals ────────────────────────────────────────────────────────────

/**
 * A supervised agent is STOPPED until one of these is answered. A denied
 * child is told not to retry for the rest of its session, so an unanswered
 * request is not a delay — it is an agent that has given up partway through.
 */
async function fetchApprovals() {
  try {
    const data = await api('/api/approvals');
    state.approvals = data.approvals ?? [];
  } catch (e) {
    // A failed fetch must not blank the list and make a blocked agent look
    // unblocked. Keep whatever was last known.
    console.error('approvals fetch failed', e);
  }
}

async function answerApproval(id, decision) {
  try {
    await api('/api/approvals/answer', {
      method: 'POST',
      body: JSON.stringify({ id, decision }),
    });
    toast(decision === 'approve' ? 'Approved' : 'Denied', decision === 'approve' ? 'info' : 'warn');
  } catch (e) {
    // 🛑 A 409 means another tab answered first. Say so rather than failing
    // silently — the operator must not believe they granted something that
    // was in fact already denied.
    toast(`Not recorded: ${e.message}`, 'warn');
  }

  await refresh();
}

function renderApprovals() {
  const root = el.approvals;
  if (!root) return;

  root.replaceChildren();

  if (state.approvals.length === 0) {
    root.hidden = true;
    return;
  }

  root.hidden = false;

  for (const a of state.approvals) {
    const deny = h('button', { class: 'approval__btn approval__btn--no', type: 'button' }, ['Deny']);
    deny.addEventListener('click', () => answerApproval(a.id, 'deny'));

    // 🛑 NO GRANT, NO APPROVE BUTTON — and `grant` is the test, not
    // `requested`. A card can name a command in prose and still have
    // nothing the allowlist understands; approving that grants NOTHING and
    // the agent is denied again. Measured live: lee approved
    // `rm in '/path/README.md'` and a second card appeared.
    //
    // 🛑 NO NAME, NO APPROVE BUTTON. A denial does not always name a command
    // — a `git push` refusal gives a prose reason. Approving one grants a
    // string nobody can act on: measured, a placeholder went into
    // --allowedTools, the retry was denied, and a second card appeared.
    // Deny stays, because stopping something you cannot name is always safe.
    const actions = [deny];

    if (a.grant) {
      const approve = h(
        'button',
        { class: 'approval__btn approval__btn--yes', type: 'button' },
        ['Approve'],
      );

      approve.addEventListener('click', () => answerApproval(a.id, 'approve'));
      actions.unshift(approve);
    }

    root.appendChild(
      h('article', { class: 'approval' }, [
        h('div', { class: 'approval__who' }, [`${a.agentHandle} is blocked`]),
        // 🛑 VERBATIM, in a <code> block, or an explicit statement that the
        // CLI named nothing. Never a placeholder that reads like a command.
        a.requested
          ? h('code', { class: 'approval__cmd' }, [a.requested])
          : h('div', { class: 'approval__unnamed' }, [
              'The agent was blocked but the CLI did not say which command. It can only be denied.',
            ]),
        // 🛑 WHAT APPROVE ACTUALLY GRANTS, shown separately. The line above
        // is the CLI's prose; this is the allowlist entry. They differ, and
        // hiding that is how an operator approves one thing and permits
        // another.
        a.grant
          ? h('div', { class: 'approval__grant' }, [`Approving permits: ${a.grant}`])
          : h('div', { class: 'approval__unnamed' }, [
              'No allowlist entry could be derived, so this can only be denied.',
            ]),
        h('div', { class: 'approval__reason' }, [a.reason]),
        h('div', { class: 'approval__actions' }, actions),
      ]),
    );
  }
}

// ── Slash commands ───────────────────────────────────────────────────────

// 2.5s was not enough to read /help, and it timed out mid-read with no way
// to stop it. Pointing at it now holds it open indefinitely.
const TOAST_MS = 7000;
// Short, because you have just finished reading it.
const TOAST_AFTER_HOVER_MS = 1200;

function armToastDismiss(el, ms) {
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('is-visible'), ms);
}

/** Transient toast for command output. Sits over the message pane, holds
 *  while the pointer is inside it, and scrolls when the content is tall. */
function toast(msg, kind = 'info') {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    // ⚠️ `.toast` had pointer-events: none, so these could never fire. The
    // CSS now lets it take the pointer, which is what makes holding possible.
    el.addEventListener('mouseenter', () => {
      el._held = true;
      el.classList.add('is-held');
      clearTimeout(el._t);
    });
    el.addEventListener('mouseleave', () => {
      el._held = false;
      el.classList.remove('is-held');
      armToastDismiss(el, TOAST_AFTER_HOVER_MS);
    });
    document.body.appendChild(el);
  }
  el.textContent = msg;
  // Rebuilt, so the held state has to be carried over: a toast replaced while
  // the pointer is inside it would otherwise lose its outline and its hold.
  el.className = `toast is-${kind}${el._held ? ' is-held' : ''}`;
  el.classList.add('is-visible');
  el.scrollTop = 0;
  if (!el._held) armToastDismiss(el, TOAST_MS);
}

// 🛑 ONE table. The suggestion popover and /help both read it, and the switch
// in tryDispatchSlashCommand is the only other place a command name appears.
// A hand-kept help string drifted from the dispatcher is the bug this avoids.
const CATEGORY_LABELS = {
  conversation: 'CONVERSATION',
  messaging: 'MESSAGING',
  status: 'STATUS',
  admin: 'ADMIN — destructive',
  system: 'SYSTEM',
};

const COMMANDS = [
  { name: 'dm', arg: '<peer>', desc: 'open a DM', suggest: 'peer', cat: 'conversation' },
  { name: 'join', arg: '<#room>', desc: 'join a room (auto-creates)', suggest: 'room', cat: 'conversation' },
  { name: 'leave', arg: '', desc: 'leave the current room', cat: 'conversation' },
  { name: 'back', arg: '', desc: 'return to no-target home', cat: 'conversation' },

  { name: 'dispatch', arg: '<peer> <text>', desc: 'hand a task to a peer', suggest: 'peer', cat: 'messaging' },
  { name: 'broadcast', arg: '<#room> <text>', desc: 'hand a task to a room', suggest: 'room', cat: 'messaging' },
  { name: 'alert', arg: '<target> <text>', desc: 'urgent — surfaces in their alert lane', suggest: 'any', cat: 'messaging' },

  { name: 'who', arg: '', desc: 'list peers and their status', cat: 'status' },
  { name: 'rooms', arg: '', desc: 'list rooms you belong to', cat: 'status' },
  { name: 'whoami', arg: '', desc: 'show your own handle', cat: 'status' },

  { name: 'kick', arg: '<peer>', desc: 'remove a peer from the bus', suggest: 'peer', cat: 'admin' },
  { name: 'delete', arg: '<#room>', desc: 'delete a room and its messages, for everyone', suggest: 'room', cat: 'admin' },

  { name: 'help', arg: '', desc: 'this list', cat: 'system' },
];

// Grouped, because a flat list of thirteen reads as thirteen unrelated things.
const HELP_TEXT = Object.keys(CATEGORY_LABELS)
  .map((cat) => {
    const rows = COMMANDS.filter((c) => c.cat === cat)
      .map((c) => '  ' + `/${c.name} ${c.arg}`.trimEnd().padEnd(22) + `— ${c.desc}`);
    return rows.length ? [CATEGORY_LABELS[cat], ...rows].join('\n') : null;
  })
  .filter(Boolean)
  .join('\n\n');

// ── Composer suggestions ────────────────────────────────────────────────

const CARET_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'Home', 'End']);

function renderSuggest() {
  const s = state.suggest;
  el.suggest.innerHTML = '';
  el.suggest.hidden = !s;
  if (!s) return;
  let shownCat = null;
  s.items.forEach((item, i) => {
    // Only while listing COMMANDS. An argument list is one kind of thing.
    if (s.kind === 'command' && item.cat && item.cat !== shownCat) {
      shownCat = item.cat;
      el.suggest.appendChild(h('div', { className: 'composer-suggest__cat' }, [CATEGORY_LABELS[item.cat]]));
    }
    el.suggest.appendChild(h('div', {
      className: `composer-suggest__row${i === s.index ? ' is-active' : ''}`,
      role: 'option',
      'aria-selected': i === s.index ? 'true' : 'false',
      // mousedown, not click: click fires after the textarea has already
      // lost focus, and blur closes the popover first.
      onmousedown: (e) => { e.preventDefault(); acceptSuggestion(i); },
    }, [
      h('span', { className: 'composer-suggest__name' }, [item.name]),
      item.arg ? h('span', { className: 'composer-suggest__arg' }, [item.arg]) : null,
      h('span', { className: 'composer-suggest__desc' }, [item.desc]),
    ]));
  });
  el.suggest.appendChild(h('div', { className: 'composer-suggest__hint' }, ['Tab or Enter to accept · Esc to dismiss']));
}

function updateSuggest() {
  const value = el.composerInput.value;
  const peers = state.peers.filter((p) => p.handle !== state.handle).map((p) => p.handle);
  const rooms = [...state.rooms.map((r) => r.name), ...state.discoverRooms.map((r) => r.name)];
  // A slash line is a command line. Only when it is not do @ and # mean a name.
  state.suggest = suggestionsFor(value, { commands: COMMANDS, peers, rooms })
    ?? mentionSuggestionsFor(value, el.composerInput.selectionStart ?? value.length, { peers, rooms });
  renderSuggest();
}

function closeSuggest() {
  if (!state.suggest) return;
  state.suggest = null;
  renderSuggest();
}

function moveSuggest(delta) {
  const s = state.suggest;
  s.index = moveIndex(s.index, delta, s.items.length);
  renderSuggest();
}

function applyHistory({ index, draft, value }) {
  state.history.index = index;
  state.history.draft = draft;
  el.composerInput.value = value;
  el.composerInput.setSelectionRange(value.length, value.length);
  el.composerInput.style.height = 'auto';
  el.composerInput.style.height = el.composerInput.scrollHeight + 'px';
  closeSuggest();
}

/** Typing, sending or dismissing all mean you are no longer browsing. */
function leaveHistory() {
  state.history.index = null;
  state.history.draft = null;
}

function acceptSuggestion(i) {
  const s = state.suggest;
  if (!s) return;
  const item = s.items[i ?? s.index];
  el.composerInput.value = item.insert;
  closeSuggest();
  el.composerInput.focus();
  // A mention completes mid-sentence, so the caret belongs where the name
  // ended, not at the end of the line.
  if (item.caret != null) el.composerInput.setSelectionRange(item.caret, item.caret);
  // Only a command that TAKES an argument reopens, to offer it. "/help"
  // reopening on itself is what left Enter unable to send.
  if (acceptReopens(item.insert)) updateSuggest();
}

/** Returns true if the input was consumed as a command (do not send).
 *  Returns false to fall through to normal message send. */
async function tryDispatchSlashCommand(input) {
  if (!input.startsWith('/')) return false;
  const parts = input.slice(1).trim().split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);
  switch (cmd) {
    case 'dm': {
      const peer = args[0];
      if (!peer) { toast('usage: /dm <peer>', 'warn'); return true; }
      if (!state.peers.find((p) => p.handle === peer)) {
        toast(`unknown peer: ${peer}`, 'warn'); return true;
      }
      await selectTarget(peer);
      return true;
    }
    case 'join': {
      const room = args[0];
      if (!room || !room.startsWith('#')) { toast('usage: /join #room', 'warn'); return true; }
      try {
        await joinRoom(room);
        await fetchWhoami();
        await selectTarget(room);
      } catch (e) { toast(`join failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'leave': {
      if (!state.currentTarget || !state.currentTarget.startsWith('#')) {
        toast('not in a room', 'warn'); return true;
      }
      try {
        await api('/api/rooms/leave', { method: 'POST', body: JSON.stringify({ room: state.currentTarget }) });
        state.currentTarget = null;
        await fetchWhoami();
        renderSidebar(); renderPaneHeader(); renderMessages();
      } catch (e) { toast(`leave failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'back': {
      state.currentTarget = null;
      renderSidebar(); renderPaneHeader(); renderMessages();
      return true;
    }
    case 'who': {
      toast(state.peers.map((p) => `${p.online ? '●' : '·'} ${p.handle}`).join('\n') || '(no peers)', 'info');
      return true;
    }
    case 'rooms': {
      const j = state.rooms.map((r) => `▸ ${r.name}`).join('\n');
      const d = state.discoverRooms.map((r) => `+ ${r.name}`).join('\n');
      toast([j || '(no joined rooms)', d && '— discover —', d].filter(Boolean).join('\n'), 'info');
      return true;
    }
    case 'whoami': {
      toast(`${state.handle} · v${state.version}`, 'info');
      return true;
    }
    case 'help': {
      toast(HELP_TEXT, 'info');
      return true;
    }
    // Same wire as a normal send, only the kind differs. The recipient's
    // client is what makes a dispatch a hand-off and an alert loud.
    case 'dispatch':
    case 'broadcast':
    case 'alert': {
      const target = args[0];
      const text = args.slice(1).join(' ');
      if (!target || !text) { toast(`usage: /${cmd} <target> <text>`, 'warn'); return true; }
      if (cmd === 'broadcast' && !target.startsWith('#')) { toast('/broadcast takes a #room', 'warn'); return true; }
      if (cmd === 'dispatch' && target.startsWith('#')) { toast('/dispatch takes a peer — use /broadcast for a room', 'warn'); return true; }
      try {
        await sendMessage(target, text, cmd === 'alert' ? 'alert' : 'dispatch');
        toast(`sent to ${target}`, 'info');
        await refresh();
      } catch (e) { toast(`${cmd} failed: ${e.message}`, 'error'); }
      return true;
    }
    case 'kick': {
      const peer = args[0];
      if (!peer) { toast('usage: /kick <peer>', 'warn'); return true; }
      await kickPeer(peer);
      return true;
    }
    case 'delete': {
      const room = args[0];
      if (!room || !room.startsWith('#')) { toast('usage: /delete #room', 'warn'); return true; }
      await deleteRoomEntry(room);
      return true;
    }
    default:
      toast(`unknown command: /${cmd}   (try /help)`, 'warn');
      return true;
  }
}

// ── Composer ─────────────────────────────────────────────────────────────

el.composerInput.addEventListener('input', () => {
  // Auto-grow up to CSS max-height.
  el.composerInput.style.height = 'auto';
  el.composerInput.style.height = el.composerInput.scrollHeight + 'px';
  // applyHistory sets .value directly, which fires no input event, so this
  // only runs for a real keystroke.
  leaveHistory();
  updateSuggest();
});

el.composerInput.addEventListener('blur', closeSuggest);

el.composerInput.addEventListener('keydown', (ev) => {
  // 🛑 Ahead of the Enter-sends rule below, or accepting a suggestion would
  // send the half-typed command instead.
  if (state.suggest) {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); return moveSuggest(1); }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); return moveSuggest(-1); }
    // The popover owns the arrows while it is open, same as the CLI.
    if (ev.key === 'Escape') { ev.preventDefault(); leaveHistory(); return closeSuggest(); }
    // 🛑 These move the caret WITHOUT firing input, so the open list would
    // still describe the token the caret just left, and Tab would splice the
    // name at the old offsets.
    if (CARET_KEYS.has(ev.key)) return closeSuggest();
    if (ev.key === 'Tab' || (ev.key === 'Enter' && !ev.shiftKey)) {
      // 🛑 Nothing left to complete: the input ALREADY equals what accepting
      // would insert. Enter has to send, or a finished command is stuck until
      // you type a space. "/who" still reaches "/whoami" with ArrowDown,
      // because that item's insert differs from the input.
      const done = enterShouldSend(state.suggest, el.composerInput.value);
      if (!done) {
        ev.preventDefault();
        return acceptSuggestion();
      }
      closeSuggest();
      if (ev.key === 'Tab') { ev.preventDefault(); return; }
      // Enter falls through to the send rule below.
    }
  } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
    const delta = ev.key === 'ArrowUp' ? -1 : 1;
    const caret = el.composerInput.selectionStart ?? 0;
    if (historyKeyApplies(el.composerInput.value, caret, delta)) {
      const step = historyStep(state.history, delta, el.composerInput.value);
      // Nothing to recall, so leave the key to the browser.
      if (step) { ev.preventDefault(); return applyHistory(step); }
    }
  }
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    el.composer.requestSubmit();
  }
});

el.composer.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  closeSuggest();
  const body = el.composerInput.value.trim();
  if (!body) return;
  state.history.entries = pushHistory(state.history.entries, body);
  leaveHistory();
  el.composerSend.disabled = true;
  try {
    // Slash commands dispatch client-side without hitting sendMessage.
    // They work regardless of whether a target is selected — /dm and /join
    // in particular are how you get INTO a target.
    if (await tryDispatchSlashCommand(body)) {
      el.composerInput.value = '';
      el.composerInput.style.height = 'auto';
      return;
    }
    if (!state.currentTarget) {
      toast('select a peer or room first (/dm <peer> or /join #room)', 'warn');
      return;
    }
    await sendMessage(state.currentTarget, body);
    el.composerInput.value = '';
    el.composerInput.style.height = 'auto';
    await refresh();
  } catch (e) {
    console.error('send failed', e);
    toast(`send failed: ${e.message}`, 'error');
  } finally {
    el.composerSend.disabled = false;
    el.composerInput.focus();
  }
});

// ── SSE ──────────────────────────────────────────────────────────────────

function connectSse() {
  const source = new EventSource('/api/events');
  source.addEventListener('wake', () => { refresh(); });

  // 🛑 A SEPARATE EVENT, SERVER-POLLED, NOT FILE-WATCHED. A dropped `wake`
  // costs a chat message some latency; a dropped approval means a blocked
  // agent the operator never sees.
  source.addEventListener('approvals', async () => {
    await fetchApprovals();
    renderApprovals();
  });
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

  // 🛑 BOOT DOES NOT CALL refresh(), SO EVERY NEW VIEW MUST BE LISTED HERE
  // TOO. The approvals card was added to refresh() only, which meant a
  // blocked agent was invisible until some unrelated wake event arrived. No
  // unit test could see it; opening the page did.
  await fetchApprovals();

  renderSidebar();
  renderPaneHeader();
  renderApprovals();
  renderMessages({ forceBottom: true });
  connectSse();
}

// Scrolling back down by hand is the same intent as pressing the jump.
el.messages.addEventListener('scroll', () => {
  if (state.unreadBelow !== 0 && isPinnedToBottom(streamGeometry())) state.unreadBelow = 0;
  // Every scroll, not just the ones that clear unread: the badge also has to
  // appear when you scroll up with nothing new waiting.
  renderJumpNewest();
});

el.jumpNewest.addEventListener('click', jumpToNewest);

// Anywhere else closes an open (...) menu. The button and the menu both
// stopPropagation, so this only ever fires for a click outside them.
document.addEventListener('click', closeItemMenu);
// 🛑 ONE LADDER, ONE HANDLER. Escape means "back out of the innermost thing",
// and focusing the composer is the outermost case of that. Split across two
// handlers it would close a menu AND move focus on the same keystroke.
//
// The composer's own keydown handles the popover case and stops there, so by
// the time this runs the popover is already dealt with.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (state.suggest) return;          // the composer handler owns this one
  if (state.openMenuFor !== null) { closeItemMenu(); return; }
  // ⚠️ Deliberately does NOT clear the input. Escape must never discard a
  // draft, and focusing a field that is already focused is a harmless no-op.
  el.composerInput.focus();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'End' || e.ctrlKey || e.metaKey || e.altKey) return;
  // End is a caret key in the composer. Only claim it when there is no text
  // for the caret to move through.
  if (document.activeElement === el.composerInput && el.composerInput.value !== '') return;
  e.preventDefault();
  jumpToNewest();
});

boot();
