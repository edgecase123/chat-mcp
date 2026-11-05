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
  streamPlan,
  suggestionsFor,
  enterShouldSend,
  styleSelection,
  styleEditAffordance,
  customStyleSubmission,
  menuEntriesFor,
  mentionSuggestionsFor,
  pushHistory,
  historyStep,
  historyKeyApplies,
  messageMarkdown,
  cheatSheet,
  commandBlock,
  atTokenAt,
  pathSuggestionsFor,
  pathsFromUriList,
  dropInsertText,
  dropNameText,
  clearConfirmText,
  clearResultText,
  gaugeDisplay,
  claimRow,
  claimsPanelEmpty,
  messageIdLabel,
  highlightSegments,
  jumpUrgency,
  messageMatchesSearch,
  nextUnreadSince,
  searchableText,
  searchFilterEmpty,
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
  claims: [],  // #101 — live claims on shared resources
  rooms: [],
  discoverRooms: [],
  currentTarget: null, // e.g. "#poker" or "@alice"
  messages: [],
  renderedCount: 0, // list length at last render, so a delta gives the unread count
  // What the DOM currently holds, so `streamPlan` can tell "two more arrived"
  // from "a different room" or "older messages loaded above".
  renderedTarget: null,
  renderedIds: [],
  // #102 — the filter term for the OPEN conversation. Not persisted: a filter
  // left on across a room switch hides messages for a reason the reader has
  // forgotten setting.
  searchTerm: '',
  unreadBelow: 0,   // messages that arrived while the reader was scrolled up
  unreadSince: null, // when the OLDEST of them arrived (#121), ms, or null
  suggest: null,     // { items, index, kind, token } while the composer popover is open
  history: { entries: [], index: null, draft: null },
  // 🛑 NOT in `messages`. refresh() reassigns that wholesale on every wake,
  // so anything parked there vanishes the moment a peer says something.
  ephemeral: [],
  openMenuFor: null, // sidebar target whose (...) menu is open. NOT in the DOM:
                     // renderSidebar() wipes it on every peer status change.
  approvals: [],
  // The project folder and home, from /api/whoami. A dropped file's path is
  // shown relative to these.
  roots: null,
  theme: null, // set below
};

const el = {
  app: document.getElementById('app'),
  loading: document.getElementById('loading'),
  myHandle: document.getElementById('my-handle'),
  sidebar: document.getElementById('sidebar'),
  paneTitle: document.getElementById('pane-title'),
  paneMeta: document.getElementById('pane-meta'),
  paneStyleWrap: document.getElementById('pane-style-wrap'),
  paneStyle: document.getElementById('pane-style'),
  paneStyleEdit: document.getElementById('pane-style-edit'),
  styleEditor: document.getElementById('style-editor'),
  styleEditorRoom: document.getElementById('style-editor-room'),
  styleEditorText: document.getElementById('style-editor-text'),
  styleEditorSave: document.getElementById('style-editor-save'),
  styleEditorCancel: document.getElementById('style-editor-cancel'),
  styleEditorError: document.getElementById('style-editor-error'),
  messages: document.getElementById('messages'),
  jumpNewest: document.getElementById('jump-newest'),
  suggest: document.getElementById('composer-suggest'),
  approvals: document.getElementById('approvals'),
  paneSearch: document.getElementById('pane-search'),
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
  state.roots = data.roots ?? null;
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

  // Claims (#101) — ABOVE Peers on purpose. Who holds the gate is the thing
  // an agent has to know before starting anything, and it used to live only
  // in chat scrollback.
  const claims = state.claims.map((c) => claimRow(c, { me: state.handle }));
  const claimsSection = h('div', { className: 'sidebar__section' }, [
    h('div', { className: 'sidebar__heading' }, ['Claims']),
    ...(claims.length === 0
      // 🛑 SAYS it is empty. A blank panel and a panel that failed to load
      // look identical, which is #103's frozen gauge in a different place.
      ? [h('div', { className: 'sidebar__empty' }, [claimsPanelEmpty()])]
      : claims.map((c) => h('div', {
        className: `claim${c.stale ? ' claim--stale' : ''}${c.mine ? ' claim--mine' : ''}`,
        title: `${c.holder} · ${c.age} · ${c.expiry}${c.note ? ` · ${c.note}` : ''}`,
      }, [
        h('div', { className: 'claim__resource' }, [c.resource]),
        h('div', { className: 'claim__meta' }, [`${c.holder} · ${c.age}`]),
      ]))),
  ]);
  el.sidebar.appendChild(claimsSection);

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
        gauge: gaugeDisplay(p),
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

function sidebarItem({ label, target, online, active, kind, unread = 0, gauge = null }) {
  const open = state.openMenuFor === target;
  return h('div', {
    className: `sidebar__item${online ? ' is-online' : ''}${active ? ' is-active' : ''}`,
    onclick: () => selectTarget(target),
  }, [
    h('span', { className: 'sidebar__item-dot' }),
    h('span', { className: 'sidebar__item-label' }, [label]),
    unread > 0 ? h('span', { className: 'sidebar__item-unread' }, [`(${unread})`]) : null,
    // #103 — a stale reading shows a dash, never its last number. The digits
    // are what people act on, so a greyed-out 100% would repeat the 28-day
    // incident rather than end it.
    gauge?.show
      ? h('span', {
          className: `sidebar__item-gauge is-${gauge.band}`,
          title: gauge.title,
        }, [gauge.percent === null ? '–' : `${gauge.percent}%`])
      : null,
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
    prefill: (e) => prefillComposer(e.prefill),
    copyName: () => copyTargetName(label),
    leaveRoom: () => leaveRoomEntry(label),
    deleteRoom: () => deleteRoomEntry(label),
    kickPeer: () => kickPeer(label),
  };

  return h('div', {
    className: 'item-menu',
    role: 'menu',
    onclick: (e) => e.stopPropagation(),
  }, menuEntriesFor(kind, label).map((e) => menuEntry(e, handlers[e.action])));
}

function menuEntry(entry, action) {
  // 🛑 A MISSING HANDLER IS A DEAD BUTTON, NOT AN ERROR. onclick closes the
  // menu before it would throw, so an action added in logic.js and never
  // wired here reads as "the app is fine". Disabled says otherwise. Not a
  // throw: one bad key must not blank the sidebar. Found by claude1.
  if (!action) {
    console.error(`sidebar menu: no handler for action "${entry.action}"`);

    return h('button', {
      className: 'item-menu__entry',
      type: 'button',
      role: 'menuitem',
      disabled: true,
      title: `${entry.text} is not wired up`,
    }, [entry.text]);
  }

  return h('button', {
    // 🛑 is-destructive is per-entry now. Every entry carried it while Kick
    // and Delete were the only two, so a new neighbour would have rendered
    // in the danger colour and read as destructive.
    className: `item-menu__entry${entry.destructive ? ' is-destructive' : ''}`,
    type: 'button',
    role: 'menuitem',
    title: entry.title,
    onclick: () => { closeItemMenu(); action(entry); },
  }, [entry.text]);
}

/**
 * Opens a command in the composer rather than running it.
 *
 * 🛑 NOTHING IS SENT. The menu cannot know the message text, and a window
 * .prompt would lose name completion, sent-line history and Shift-Enter.
 * Ruled by lee.
 *
 * Replaces whatever is there: the menu is a fresh start, and appending to a
 * half-typed line produces a command in the middle of a sentence.
 */
function prefillComposer(text) {
  el.composerInput.value = text;
  el.composerInput.focus();
  el.composerInput.setSelectionRange(text.length, text.length);
  // The composer's own input handler drives the completion list, and setting
  // .value does not fire it.
  el.composerInput.dispatchEvent(new Event('input', { bubbles: true }));
}

async function copyTargetName(label) {
  try {
    await writeClipboard(label);
    toast(`copied ${label}`, 'info');
  } catch (e) {
    // Never a success toast on a failed write; the clipboard is unreadable
    // from here, so the toast is the only thing that could mislead.
    toast(`copy failed: ${e.message}`, 'error');
  }
}

/**
 * Leaves a room from its own row, which the `/leave` command cannot do —
 * that one acts on the CURRENT target, so leaving another room meant
 * switching to it first.
 */
async function leaveRoomEntry(room) {
  try {
    await api('/api/rooms/leave', { method: 'POST', body: JSON.stringify({ room }) });
    // Only the room you were IN leaves you with nothing to look at.
    if (state.currentTarget === room) state.currentTarget = null;
    toast(`left ${room}`, 'info');
    await fetchWhoami();
    renderSidebar(); renderPaneHeader(); renderMessages();
  } catch (e) {
    toast(`leave failed: ${e.message}`, 'error');
  }
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

async function clearConversation(target) {
  const ok = window.confirm(clearConfirmText(target));
  if (!ok) return;
  try {
    const { cleared } = await api('/api/messages/clear', {
      method: 'POST',
      body: JSON.stringify({ target }),
    });
    // A count of 0 is a success — see `clearResultText`.
    toast(clearResultText(cleared, target), 'info');
    await refresh();
  } catch (e) {
    toast(`clear failed: ${e.message}`, 'error');
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

/**
 * The one timer behind the escalation (#121).
 *
 * 🛑 ONE INTERVAL, RE-ARMED, NEVER ONE PER ARRIVAL. A timer started per
 * message would stack: ten arrivals would tick ten times a second and each
 * would outlive the clear.
 */
let urgencyTimer = null;

function stopUrgencyTimer() {
  if (urgencyTimer === null) return;
  clearInterval(urgencyTimer);
  urgencyTimer = null;
}

/**
 * ⚠️ POLLED, NOT SCHEDULED PER THRESHOLD. One second is well under the 3s
 * first step, and a `setTimeout` per threshold has to be cancelled on three
 * separate clear paths — this one is idempotent and stops itself.
 */
function startUrgencyTimer() {
  if (urgencyTimer !== null) return;
  urgencyTimer = setInterval(renderJumpNewest, 1000);
}

function renderJumpNewest() {
  el.jumpNewest.hidden = !shouldShowJump(state.unreadBelow, streamGeometry());

  // 🛑 THE CLOCK IS CLEARED EVEN WHEN THE PILL IS HIDDEN. `shouldShowJump` is
  // true for "scrolled far up with nothing new" too, so hidden and
  // "nothing waiting" are different states and only the latter stops the timer.
  state.unreadSince = nextUnreadSince(state.unreadSince, state.unreadBelow, Date.now());

  if (state.unreadSince === null) {
    stopUrgencyTimer();
    el.jumpNewest.removeAttribute('data-urgency');
  } else {
    startUrgencyTimer();
    const level = jumpUrgency(Date.now() - state.unreadSince);
    if (level === 0) el.jumpNewest.removeAttribute('data-urgency');
    else el.jumpNewest.setAttribute('data-urgency', String(level));
  }

  if (el.jumpNewest.hidden) return;
  const label = jumpLabel(state.unreadBelow);
  if (el.jumpNewest.textContent !== label) el.jumpNewest.textContent = label;
}

function resetStreamPosition() {
  state.renderedCount = 0;
  state.renderedTarget = null;
  state.renderedIds = [];
  state.unreadBelow = 0;
  renderJumpNewest();
}

/**
 * How long `.is-fresh` stays on a node, read from the stylesheet so the
 * duration has ONE home. Hard-coding it here too is how the two drift.
 */
function freshDurationMs() {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--msg-fresh-ms');
  const ms = Number.parseInt(raw, 10);

  return Number.isFinite(ms) && ms > 0 ? ms + 60 : 500;
}

/**
 * The message as the reader SEES it, not as it was typed (#102).
 *
 * 🛑 THE FILTER AND THE HIGHLIGHTER MUST MATCH THE SAME STRING. They did not:
 * the filter read markdown SOURCE and the highlighter walked RENDERED text, so
 * a term crossing a code span hid a row whose exact text was on screen.
 * Measured on `see \`--color-card\` here`: the term "see --color-card" returned
 * ZERO rows while those characters were visible. Found by claude1.
 *
 * ⚠️ PARSED IN THE BROWSER, NOT STRIPPED ON THE SERVER. A server-side tag
 * strip has to decode entities to agree with what a text node holds — `&amp;`
 * against `&` — which is the same mismatch one layer down. `textContent` of a
 * parse is what the highlighter walks, by construction.
 *
 * ⚠️ PLUS EVERY `a[href]`, WHICH `textContent` CANNOT SEE. See
 * `searchableText` for why that is worth an unmarkable hit.
 *
 * Cached per message object. `refresh()` replaces `state.messages` wholesale on
 * every wake, so this costs one parse per fetch rather than one per keystroke.
 */
function renderedText(m) {
  if (m.__renderedText === undefined) {
    const probe = document.createElement('div');
    probe.innerHTML = m.body_html || '';
    const hrefs = [...probe.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? '');
    m.__renderedText = searchableText(probe.textContent ?? '', hrefs);
  }

  return m.__renderedText;
}

/**
 * Wrap every occurrence of `term` in a node's TEXT NODES with `<mark>` (#102).
 *
 * 🛑 TEXT NODES, NEVER THE HTML STRING. A regex over `body_html` can match
 * inside a tag or an attribute, which breaks the markup and is an injection
 * hazard; `highlightSegments` works on text that is already parsed, so neither
 * is reachable.
 *
 * ⚠️ THE NODES ARE COLLECTED BEFORE ANY ARE REPLACED. A TreeWalker advanced
 * while the tree is being rewritten under it skips siblings, and the symptom
 * is a hit highlighted in one paragraph and missed in the next.
 */
function highlightInPlace(root, term) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const texts = [];
  for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) texts.push(n);

  for (const node of texts) {
    const segments = highlightSegments(node.nodeValue ?? '', term);
    // One unhit segment means nothing matched in this node; replacing it would
    // churn the DOM for no change.
    if (segments.length === 1 && !segments[0].hit) continue;

    const frag = document.createDocumentFragment();
    for (const seg of segments) {
      frag.appendChild(seg.hit ? h('mark', {}, [seg.text]) : document.createTextNode(seg.text));
    }
    node.replaceWith(frag);
  }
}

function messageNode(m, { fresh: arriving = false, term = '' } = {}) {
  const isSelf = m.from_handle === state.handle;
  // 🛑 YOUR OWN MESSAGE IS NEVER FRESH. `is-fresh` means "this arrived while
  // you were reading"; you already know you sent it, so both the shimmer and
  // the slide are noise. Decided by lee, 2026-11-04, after the slide alone
  // still read as a flash.
  const fresh = arriving && !isSelf;
  const kind = m.kind || 'chat';
  const cls = ['message', isSelf ? 'is-self' : '', kind === 'dispatch' ? 'is-dispatch' : '', kind === 'alert' ? 'is-alert' : '', fresh ? 'is-fresh' : '']
    .filter(Boolean).join(' ');
  const meta = h('div', { className: 'message__meta' }, [
    h('span', { className: 'message__from' }, [m.from_handle]),
    h('span', { className: 'message__time' }, [fmtTime(m.sent_at)]),
    // #104 — the id was unreachable from the UI, so "see 12582" meant nothing
    // to the human reading it.
    h('span', { className: 'message__id' }, [messageIdLabel(m.id)]),
    kind !== 'chat' ? h('span', { className: 'message__kind' }, [kind.toUpperCase()]) : null,
    copyButton(m),
  ]);
  const body = h('div', { className: 'message__body', html: m.body_html || '' });
  if (term.length > 0) highlightInPlace(body, term);
  const li = h('li', { className: cls }, [meta, body]);

  // 🛑 DROP THE CLASS ONCE IT HAS PLAYED. Left on, the next reflow replays the
  // shimmer on an old message, and `prefers-reduced-motion` fires no
  // animationend at all — so a timer, not only the event.
  // 🛑 A TIMER, NOT `animationend`. `.is-fresh` drives TWO animations — the
  // 160ms slide on the element and the longer shimmer on its `::after` — and
  // a one-shot `animationend` listener fired on the first of them, stripping
  // the class and cutting the shimmer off at 160ms. `prefers-reduced-motion`
  // is the other reason: it fires no `animationend` at all.
  if (fresh) {
    setTimeout(() => li.classList.remove('is-fresh'), freshDurationMs());
  }

  return li;
}

/** Ephemeral panels sit after the messages, so growing the list means lifting
 *  them off and putting them back. */
function detachEphemeral() {
  for (const node of el.messages.querySelectorAll('li.is-ephemeral')) node.remove();
}

function renderMessages({ forceBottom = false } = {}) {
  // Measured BEFORE either path below moves anything.
  const wasPinned = forceBottom || isPinnedToBottom(streamGeometry());
  const prevScrollTop = el.messages.scrollTop;

  if (!state.currentTarget) {
    el.messages.innerHTML = '';
    el.messages.appendChild(h('div', { className: 'messages__empty' }, ['Select a peer or room from the sidebar.']));
    // 🛑 BEFORE the return. /cheat-sheet works with no target selected, and
    // an early return here is what would have swallowed it.
    appendEphemeral();
    resetStreamPosition();
    return;
  }
  if (state.messages.length === 0) {
    el.messages.innerHTML = '';
    el.messages.appendChild(h('div', { className: 'messages__empty' }, ['No messages yet.']));
    appendEphemeral();
    resetStreamPosition();
    return;
  }

  // #102 — the filter applies to what is LOADED, which is why the empty state
  // says how many messages were scanned. "no match" alone reads as "it is not
  // in the transcript", and the transcript is longer than this view.
  const term = state.searchTerm.trim();
  // 🛑 `renderedText`, NOT `m.body`. Matching markdown SOURCE while marking
  // RENDERED text hid rows whose exact characters were on screen: the term
  // "see --color-card" returned nothing against `see \`--color-card\` here`.
  //
  // ⚠️ A SHOWN ROW DOES NOT ALWAYS CARRY A MARK, and an earlier version of this
  // comment claimed it always would. Two independent reasons, both measured at
  // 1 row and 0 marks: a term spanning a code span appears in no single text
  // node, and an href hit lives in an attribute. See `searchableText`.
  const visible =
    term.length === 0 ? state.messages : state.messages.filter((m) => messageMatchesSearch(renderedText(m), term));

  if (visible.length === 0) {
    el.messages.innerHTML = '';
    el.messages.appendChild(
      h('div', { className: 'messages__empty' }, [searchFilterEmpty(term, state.messages.length)]),
    );
    appendEphemeral();
    resetStreamPosition();
    return;
  }

  const ids = visible.map((m) => m.id);
  // 🛑 THE FILTER TERM IS PART OF THE VIEW IDENTITY, NOT A SEPARATE BRANCH.
  // Clearing a filter makes the list longer with a different prefix, which
  // `streamPlan` would otherwise read as a slid window and shimmer every
  // message the filter had been hiding. Folding the term into the target
  // reuses the existing "different conversation" guard instead.
  const viewKey = `${state.currentTarget}\u0000${state.searchTerm}`;
  const plan = streamPlan(
    { target: state.renderedTarget, ids: state.renderedIds },
    { target: viewKey, ids },
  );

  // 🛑 ONLY AN APPEND HAS ARRIVALS. On a rebuild the previous count belongs to
  // another conversation, so a 3-message DM followed by a 40-message room
  // would read as 37 arrivals. Every rebuild path happens to pass
  // `forceBottom`, which zeroes the count downstream — this makes it
  // structural rather than lucky. Raised by claude1 reviewing PR 99.
  // 🛑 A REBUILD CAN HAVE ARRIVALS TOO, past the server's 100-row cap. The
  // window slides, the prefix moves, and the plan names what is new — see
  // `streamPlan`. Treating a rebuild as zero arrivals is what stopped #leagues
  // shimmering while a short DM still did.
  const freshIds = plan.mode === 'full' ? new Set(plan.freshIds ?? []) : null;
  const arrived = plan.mode === 'append' ? visible.length - plan.from : freshIds.size;

  if (plan.mode === 'full') {
    el.messages.innerHTML = '';
    for (const m of visible) el.messages.appendChild(messageNode(m, { fresh: freshIds.has(m.id), term }));
  } else {
    detachEphemeral();
    for (const m of visible.slice(plan.from)) {
      el.messages.appendChild(messageNode(m, { fresh: true, term }));
    }
  }

  state.renderedCount = visible.length;
  state.renderedTarget = viewKey;
  state.renderedIds = ids;
  appendEphemeral();

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

function copyButton(m) {
  const label = `Copy message from ${m.from_handle} as markdown. Hold Shift to include who sent it and when.`;

  return h('button', {
    className: 'message__copy',
    type: 'button',
    title: label,
    'aria-label': label,
    onclick: (e) => copyMessage(m, e.shiftKey),
  }, ['\u29c9']);
}

async function copyMessage(m, attributed) {
  const text = messageMarkdown(
    { from: m.from_handle, time: fmtTime(m.sent_at), body: m.body },
    { attributed },
  );
  try {
    await writeClipboard(text);
  } catch (err) {
    // 🛑 Never a success toast on a failed write. The clipboard is the only
    // place the result shows, so a wrong toast is undetectable.
    console.error('copy failed', err);
    toast('could not copy — clipboard blocked', 'warn');

    return;
  }
  toast(attributed ? 'copied with author' : 'copied', 'info');
}

/** navigator.clipboard needs a secure context. 127.0.0.1 counts as one, but a
 *  host served over plain http by name does not, so keep the old path. */
async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);

  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    if (!document.execCommand('copy')) throw new Error('execCommand copy refused');
  } finally {
    ta.remove();
  }
}

/** Client-only panels, rendered as TEXT. There is no server-side markdown
 *  pass for these, and text children mean no innerHTML and nothing to escape. */
function appendEphemeral() {
  for (const e of state.ephemeral) {
    el.messages.appendChild(h('li', { className: 'message is-ephemeral' }, [
      h('div', { className: 'message__meta' }, [
        h('span', { className: 'message__from' }, [e.title]),
        h('span', { className: 'message__kind' }, ['NOT SAVED']),
        h('button', {
          className: 'message__dismiss',
          type: 'button',
          title: `Dismiss ${e.title}`,
          'aria-label': `Dismiss ${e.title}`,
          onclick: () => dismissEphemeral(e.id),
        }, ['\u00d7']),
      ]),
      h('pre', { className: 'message__pre' }, [e.text]),
    ]));
  }
}

function showEphemeral(title, text) {
  state.ephemeral = [...state.ephemeral, { id: `eph-${Date.now()}`, title, text }];
  renderMessages({ forceBottom: true });
}

function dismissEphemeral(id) {
  state.ephemeral = state.ephemeral.filter((e) => e.id !== id);
  renderMessages();
}

function renderPaneHeader() {
  el.composerInput.disabled = false;
  el.composerSend.disabled = false;
  if (!state.currentTarget) {
    el.paneTitle.textContent = 'select a peer or room';
    el.paneMeta.textContent = 'type /help for commands';
    if (el.paneStyleWrap) el.paneStyleWrap.hidden = true;
    if (el.paneStyleEdit) el.paneStyleEdit.hidden = true;
    el.composerInput.placeholder = 'Type /dm <peer> or /join #room to get started. /help for commands.';
    return;
  }
  el.composerInput.placeholder = 'Type a message. Shift-Enter for newline.';
  if (state.currentTarget.startsWith('#')) {
    el.paneTitle.textContent = state.currentTarget;
    const room = state.rooms.find((r) => r.name === state.currentTarget);
    el.paneMeta.textContent = room ? `${room.member_count ?? '?'} members` : '';
    // #92 — the style selector belongs to rooms only. A DM has no shared room
    // to carry one, and the empty state has no target at all.
    if (el.paneStyleWrap && el.paneStyle) {
      el.paneStyleWrap.hidden = !room;
      if (room) el.paneStyle.value = room.style ?? '';
      if (el.paneStyleEdit) el.paneStyleEdit.hidden = !room || !styleEditAffordance(room.style);
      if (el.styleEditor && el.styleEditor.hidden === false && state.currentTarget !== el.styleEditorRoom.textContent) closeStyleEditor();
    }
  } else {
    el.paneTitle.textContent = `DM · ${state.currentTarget}`;
    const peer = state.peers.find((p) => p.handle === state.currentTarget);
    el.paneMeta.textContent = peer ? (peer.online ? 'online' : 'offline') : '';
    if (el.paneStyleWrap) el.paneStyleWrap.hidden = true;
    if (el.paneStyleEdit) el.paneStyleEdit.hidden = true;
  }
  el.composerInput.focus();
}

// ── Actions ──────────────────────────────────────────────────────────────

async function selectTarget(target) {
  state.currentTarget = target;
  // 🛑 THE FILTER DOES NOT FOLLOW YOU. A term left on across a switch hides
  // messages in the new conversation for a reason the reader has forgotten
  // setting, and an empty-looking room reads as a broken one.
  state.searchTerm = '';
  el.paneSearch.value = '';
  state.ephemeral = [];
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

async function fetchClaims() {
  const data = await api('/api/claims');
  state.claims = data.claims;
}

async function refresh() {
  try {
    await fetchWhoami();
    await fetchApprovals();
    await fetchClaims();
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
  { name: 'clear', arg: '<target>', desc: 'delete every message in a room or DM, for everyone in it', suggest: 'any', cat: 'admin' },

  { name: 'help', arg: '', desc: 'the commands, as a toast', cat: 'system' },
  { name: 'cheat-sheet', arg: '', desc: 'the same commands plus every gesture, in the stream', cat: 'system' },
];

// Grouped, because a flat list reads as unrelated things. Same builder as the
// cheat sheet, so a new command's description cannot come out two ways.
// The toast outdents its headings; the sheet indents them to sit under its own.
const HELP_TEXT = commandBlock(COMMANDS, CATEGORY_LABELS, { headingIndent: '' });

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
  const hint = s.truncated
    ? `showing ${s.items.length} of ${s.truncated} · keep typing to narrow · Tab or Enter to accept · Esc to dismiss`
    : 'Tab or Enter to accept · Esc to dismiss';
  el.suggest.appendChild(h('div', { className: 'composer-suggest__hint' }, [hint]));
}

function updateSuggest() {
  const value = el.composerInput.value;
  const caret = el.composerInput.selectionStart ?? value.length;
  const peers = state.peers.filter((p) => p.handle !== state.handle).map((p) => p.handle);
  const rooms = [...state.rooms.map((r) => r.name), ...state.discoverRooms.map((r) => r.name)];
  // A slash line is a command line. Only when it is not does # mean a name.
  const sync = suggestionsFor(value, { commands: COMMANDS, peers, rooms })
    ?? mentionSuggestionsFor(value, caret, { peers, rooms });
  if (sync) {
    state.suggest = sync;
    renderSuggest();

    return;
  }
  // "@" needs the server, because the browser cannot read the disk.
  if (!atTokenAt(value, caret)) {
    state.suggest = null;
    renderSuggest();

    return;
  }
  // Deliberately NOT cleared first. Clearing here makes the popover blink
  // shut on every keystroke while the next listing is in flight.
  requestHints(value, caret);
}

// 🛑 A STALE REPLY MUST NOT LAND. Each keystroke starts a request, and they
// can finish out of order, so the newest sequence number wins and the value
// is re-checked. Without this, typing fast shows hints for a path you have
// already moved past, and Tab then splices THAT path in.
let hintSeq = 0;

async function requestHints(value, caret) {
  const seq = hintSeq + 1;
  hintSeq = seq;
  const token = atTokenAt(value, caret);
  let hints = [];
  let total = 0;
  try {
    const body = await api(`/api/files?q=${encodeURIComponent(token.query)}`);
    hints = body.hints ?? [];
    total = body.total ?? hints.length;
  } catch (e) {
    console.error('file hints failed', e);
  }
  if (seq !== hintSeq) return;
  if (el.composerInput.value !== value) return;
  state.suggest = pathSuggestionsFor(hints, value, caret);
  // 🛑 A SILENT CAP READS AS A MISSING FILE. 30 of 30 and 30 of 34 looked
  // identical, so a file that was there looked absent.
  if (state.suggest) state.suggest.truncated = total > hints.length ? total : 0;
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
  // A path item says so for itself: a directory reopens to offer its
  // contents, and it inserts no trailing space for acceptReopens to find.
  // Otherwise, only a command that TAKES an argument reopens. "/help"
  // reopening on itself is what left Enter unable to send.
  if (item.reopen ?? acceptReopens(item.insert)) updateSuggest();
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
    case 'cheat-sheet': {
      showEphemeral('/cheat-sheet', cheatSheet(COMMANDS, CATEGORY_LABELS));
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
    case 'clear': {
      // Named explicitly, like /delete, and NOT taken from the open pane. One
      // click reaches this in the web UI, so the target is never implied.
      const target = args[0];
      if (!target) { toast('usage: /clear <#room|peer>', 'warn'); return true; }
      await clearConversation(target);
      return true;
    }
    default:
      toast(`unknown command: /${cmd}   (try /help)`, 'warn');
      return true;
  }
}

// ── Composer ─────────────────────────────────────────────────────────────

// #102 — filter and highlight the open conversation as the term is typed.
el.paneSearch.addEventListener('input', () => {
  state.searchTerm = el.paneSearch.value;
  // 🛑 NOT forceBottom. Filtering while scrolled up must not yank the reader
  // to the newest hit; the jump affordance already offers that.
  renderMessages();
});

// Escape clears the filter rather than closing anything, because an empty box
// and a hidden message list look the same and only one of them is a mistake.
el.paneSearch.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  el.paneSearch.value = '';
  state.searchTerm = '';
  renderMessages();
});

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

// ── dropping a file onto the window ─────────────────────────────────────

/**
 * 🛑 THE PATH IS IN text/uri-list, NOT IN dataTransfer.files.
 *
 * A dropped `File` exposes `.name` and no path — a browser privacy boundary,
 * not an oversight. Finder and VS Code also put `file:///...` URLs on the
 * drag, and that is the only place a full path appears.
 *
 * 🛑 dragover MUST preventDefault or no drop event fires at all. That is the
 * commonest reason a drop handler looks dead.
 */
function wireFileDrop() {
  let depth = 0;

  // dragenter/dragleave fire for every child element the pointer crosses, so
  // a plain toggle flickers. Counting is what makes the highlight stable.
  window.addEventListener('dragenter', (e) => {
    if (!carriesFiles(e)) return;
    depth += 1;
    el.app.classList.add('is-dropping');
  });

  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) el.app.classList.remove('is-dropping');
  });

  window.addEventListener('dragover', (e) => {
    if (!carriesFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('drop', (e) => {
    depth = 0;
    el.app.classList.remove('is-dropping');
    if (!carriesFiles(e)) return;
    // Without this the browser NAVIGATES to the dropped file and the page is
    // gone, unsent message and all.
    e.preventDefault();
    insertDroppedPaths(e.dataTransfer);
  });
}

/** A drag from a browser carries text and no files; it has no path to give. */
function carriesFiles(e) {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}

function insertDroppedPaths(dt) {
  const paths = pathsFromUriList(dt.getData('text/uri-list') || dt.getData('text/plain'));

  if (paths.length === 0) {
    // 🛑 THE NAME IS WHAT A FILE DROP ACTUALLY CARRIES, so insert that rather
    // than nothing. A warning over an empty composer left the gesture looking
    // broken when it had delivered everything the browser allows.
    const names = Array.from(dt.files ?? []).map((f) => f.name);
    if (names.length === 0) {
      toast('nothing droppable in that drop', 'warn');

      return;
    }

    insertAtCaret(`${dropNameText(names)} `);
    toast('name only — the browser does not reveal the path', 'info');

    return;
  }

  insertAtCaret(`${dropInsertText(paths, state.roots ?? { cwd: '', home: '' })} `);
}

/**
 * Inserts at the caret rather than replacing, because a drop lands in the
 * middle of a half-written message and replacing would eat it.
 */
function insertAtCaret(text) {
  const input = el.composerInput;
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  input.focus();
  const caret = start + text.length;
  input.setSelectionRange(caret, caret);
  // The composer's own input handler drives the completion list, and setting
  // .value does not fire it.
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

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
  wireFileDrop();
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

// #92 — the custom-style editor.
function openStyleEditor(room, markdown) {
  if (!el.styleEditor) return;
  el.styleEditorRoom.textContent = room;
  el.styleEditorText.value = markdown;
  el.styleEditorError.textContent = '';
  el.styleEditor.hidden = false;
  el.styleEditorText.focus();
}

function closeStyleEditor() {
  if (el.styleEditor) el.styleEditor.hidden = true;
}

if (el.paneStyleEdit) {
  el.paneStyleEdit.addEventListener('click', () => {
    const room = state.rooms.find((r) => r.name === state.currentTarget);
    if (room) openStyleEditor(room.name, room.style_custom ?? '');
  });
}

if (el.styleEditorCancel) {
  el.styleEditorCancel.addEventListener('click', () => {
    closeStyleEditor();
    // Put the selector back to what the room actually holds, so cancelling
    // does not leave it reading "custom" over an unsaved style.
    const current = state.rooms.find((r) => r.name === state.currentTarget);
    if (el.paneStyle) el.paneStyle.value = current?.style ?? '';
  });
}

if (el.styleEditorSave) {
  el.styleEditorSave.addEventListener('click', async () => {
    const room = state.currentTarget;
    const check = customStyleSubmission(el.styleEditorText.value);

    if (!check.ok) {
      el.styleEditorError.textContent = check.error;
      return;
    }

    try {
      await api('/api/rooms/style', {
        method: 'POST',
        body: JSON.stringify({ room, style: check.style, custom: check.custom }),
      });
      closeStyleEditor();
      await refresh();
    } catch (e) {
      el.styleEditorError.textContent = String(e.message ?? e);
    }
  });
}

// #92 — saving a room's conversation style. `custom` opens the editor instead
// of saving, because the server demands markdown alongside it.
if (el.paneStyle) {
  el.paneStyle.addEventListener('change', async () => {
    const room = state.currentTarget;
    const chosen = el.paneStyle.value;

    if (!room || !room.startsWith('#')) return;

    const current = state.rooms.find((r) => r.name === room);
    const decision = styleSelection(chosen, current?.style ?? null);

    if (decision.action === 'edit') {
      openStyleEditor(room, current?.style_custom ?? '');
      return;
    }

    closeStyleEditor();

    try {
      await api('/api/rooms/style', {
        method: 'POST',
        body: JSON.stringify({ room, style: decision.style }),
      });
      await refresh();
    } catch (e) {
      console.error('could not save the style', e);
      el.paneStyle.value = current?.style ?? '';
    }
  });
}

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
