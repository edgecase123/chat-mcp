/**
 * 🛑 THE DECISIONS, WITH NO DOM UNDER THEM.
 *
 * `app.js` owns the DOM and the events. Everything here is a pure function of
 * its arguments, so it is testable under `node --test` with nothing mocked.
 *
 * ⚠️ THIS SPLIT IS NOT AESTHETIC. Measured 2026-11-01 on chat-mcp#52: a fake
 * DOM (happy-dom) reports `clientHeight` and `scrollHeight` as 0 for an
 * element that overflows. Scroll tests written against one would pass while
 * proving nothing. Taking the geometry as an ARGUMENT is what makes the
 * decision testable at all.
 */

/** A position this close to the end counts as the bottom. A fractional
 *  scrollHeight makes an equality test false when it looks true. */
export const BOTTOM_TOLERANCE_PX = 24;

/** How far up counts as "reading history" rather than "glancing back". */
export const JUMP_VISIBLE_AFTER_PX = 240;

/** @typedef {{ scrollTop: number, scrollHeight: number, clientHeight: number }} Geometry */

/** @param {Geometry} geo */
export function distanceFromBottom(geo) {
  return geo.scrollHeight - geo.scrollTop - geo.clientHeight;
}

/** @param {Geometry} geo */
export function isPinnedToBottom(geo) {
  return distanceFromBottom(geo) <= BOTTOM_TOLERANCE_PX;
}

/**
 * Whether the jump affordance belongs on screen. Two independent reasons:
 * something arrived while you were away from the bottom, or you are simply
 * far enough up that getting back by hand is work.
 *
 * @param {number} unread
 * @param {Geometry} geo
 */
export function shouldShowJump(unread, geo) {
  if (unread > 0) return true;

  return distanceFromBottom(geo) > Math.max(JUMP_VISIBLE_AFTER_PX, geo.clientHeight);
}

/** @param {number} unread */
export function jumpLabel(unread) {
  if (unread > 0) return `${unread} new message${unread === 1 ? '' : 's'} ↓  (End)`;

  return 'Jump to newest ↓  (End)';
}

/**
 * The unread tally after a render. Pinned means you were already looking at
 * the newest line, so nothing was missed.
 *
 * @param {number} previous
 * @param {number} arrived
 * @param {boolean} wasPinned
 */
export function nextUnreadBelow(previous, arrived, wasPinned) {
  if (wasPinned) return 0;

  return previous + Math.max(0, arrived);
}

/**
 * What to offer for the current composer value, or null for nothing.
 *
 * Two cases: the command name itself, and the argument of a command that
 * takes one. Anything that is not a lone slash-line suggests nothing, so
 * ordinary typing is never interrupted.
 *
 * @param {string} value
 * @param {{ commands: any[], peers: string[], rooms: string[] }} ctx
 */
export function suggestionsFor(value, ctx) {
  if (!value.startsWith('/') || value.includes('\n')) return null;
  const m = value.match(/^\/(\S*)(\s+)?(.*)$/);
  if (!m) return null;
  const [, name, space, rest] = m;

  if (!space) {
    const items = ctx.commands
      .filter((c) => c.name.startsWith(name.toLowerCase()))
      .map((c) => ({ insert: `/${c.name}${c.arg ? ' ' : ''}`, name: `/${c.name}`, arg: c.arg, desc: c.desc, cat: c.cat }));

    return items.length ? { items, index: 0, kind: 'command' } : null;
  }

  const cmd = ctx.commands.find((c) => c.name === name.toLowerCase());
  if (!cmd || !cmd.suggest || rest.includes(' ')) return null;
  const pool = cmd.suggest === 'peer' ? ctx.peers
    : cmd.suggest === 'room' ? ctx.rooms
      : [...ctx.peers, ...ctx.rooms];
  const q = rest.toLowerCase().replace(/^#/, '');
  const items = [...new Set(pool)]
    .filter((h) => h.toLowerCase().replace(/^#/, '').startsWith(q))
    .map((h) => ({ insert: `/${cmd.name} ${h}`, name: h, arg: '', desc: cmd.suggest }));

  return items.length ? { items, index: 0, kind: 'arg' } : null;
}

/**
 * 🛑 THE RULE THAT UNSTUCK "/help". The input already equals what accepting
 * would insert, so there is nothing to complete and Enter must SEND. Without
 * it a finished command sits there until you type a space.
 *
 * @param {{ items: {insert: string}[], index: number } | null} suggest
 * @param {string} value
 */
export function enterShouldSend(suggest, value) {
  if (!suggest) return true;
  const item = suggest.items[suggest.index];

  // 🛑 A MENTION CANNOT USE THE WHOLE-VALUE TEST. Its insert carries the rest
  // of the line, so "hey #ali" never equals "alice" and Enter would re-accept
  // forever. That is the stuck-command bug this rule was written to fix,
  // returning through the rule itself. Compare the TYPED TOKEN instead.
  //
  // 🛑 THE TOKEN INCLUDES THE "#". Comparing the bare name let "#gate" send
  // with a stray "#" when gate was a PEER, while "#clau" completed to
  // "claude1" with none. How much you had typed decided what got sent.
  if (suggest.kind === 'mention') return suggest.typed === item.name;

  return item.insert === value;
}

/** Accepting only reopens for a command that TAKES an argument. "/help"
 *  reopening on itself is what left Enter unable to send. */
export function acceptReopens(insert) {
  return insert.endsWith(' ');
}

/** Wrapping move through the suggestion list. */
export function moveIndex(index, delta, length) {
  if (length === 0) return 0;

  return (index + delta + length) % length;
}

/**
 * A peer and a room take different verbs. Kick removes a peer from the bus;
 * a room's equivalent is deleting the room for everyone.
 *
 * @param {'room' | 'peer'} kind
 * @param {string} label
 * @returns {{ text: string, title: string, action: 'deleteRoom' | 'kickPeer' }[]}
 */
export function menuEntriesFor(kind, label) {
  if (kind === 'room') {
    return [{ text: 'Delete', title: `Delete ${label} for everyone`, action: 'deleteRoom' }];
  }

  return [{ text: 'Kick', title: `Remove ${label} from the bus`, action: 'kickPeer' }];
}

/** Chars a handle or room name can contain, so the token ends where one does. */
const MENTION_BODY = /[A-Za-z0-9._-]/;

/**
 * 🛑 "#" IS THE ONLY NAME TRIGGER. "@" is reserved for relative file paths.
 * A peer and a room share one pool, because a name is a name to the person
 * typing it.
 *
 * 🛑 THE TRIGGER MUST OPEN A WORD, NOT SIT INSIDE ONE, or a C# or an issue
 * reference opens the list on every keystroke after it.
 *
 * 🛑 THE TOKEN EXTENDS PAST THE CARET to the end of the word. Measured while
 * writing this: querying only the text to the LEFT completes "tell #cla|u now"
 * to "tell claude1 u now" and leaves an orphan "u" behind.
 *
 * @param {string} value
 * @param {number} caret
 * @returns {{ query: string, start: number, end: number } | null}
 */
export function mentionTokenAt(value, caret) {
  // A command line belongs to suggestionsFor, in full. Leaving this to the
  // caller let "/dm #clau" complete through the mention path instead.
  if (value.startsWith('/') && !value.includes('\n')) return null;

  const pos = Math.max(0, Math.min(caret, value.length));
  const upto = value.slice(0, pos);
  const at = upto.lastIndexOf('#');
  if (at < 0) return null;

  const before = at === 0 ? '' : upto[at - 1];
  if (before !== '' && !/\s/.test(before)) return null;

  let end = at + 1;
  while (end < value.length && MENTION_BODY.test(value[end])) end += 1;
  if (end < pos) return null;

  return { query: value.slice(at + 1, pos), start: at, end };
}

/**
 * The peer or room completion for the token under the caret.
 *
 * A room name already carries its own "#" and keeps it. A peer handle does
 * not, so the "#" was only a trigger and is dropped on accept. A bare "#"
 * lists everything, so it is a name picker.
 *
 * @param {string} value
 * @param {number} caret
 * @param {{ peers: string[], rooms: string[] }} ctx
 */
export function mentionSuggestionsFor(value, caret, ctx) {
  const token = mentionTokenAt(value, caret);
  if (!token) return null;

  const q = token.query.toLowerCase();
  const tail = value.slice(token.end);
  // Only pad when nothing follows, so completing before a space does not
  // leave two of them.
  const pad = /^\s/.test(tail) ? '' : ' ';

  const sorted = (xs) => [...xs].sort((a, b) => a.localeCompare(b));
  // Rooms first, then peers. Deterministic inside each group so the top item
  // does not depend on bus join order.
  const items = [...new Set([...sorted(ctx.rooms), ...sorted(ctx.peers)])]
    .filter((h) => bareName(h).toLowerCase().startsWith(q))
    .map((h) => {
      const head = value.slice(0, token.start) + h + pad;

      return {
        insert: head + tail,
        caret: head.length,
        name: h,
        arg: '',
        desc: h.startsWith('#') ? 'room' : 'peer',
      };
    });

  return items.length ? { items, index: 0, kind: 'mention', typed: `#${token.query}` } : null;
}

/** A room's own "#" is part of its name; the trigger "#" is not. */
function bareName(handle) {
  return handle.replace(/^#/, '');
}

/** The CLI's ring size, mirrored so both surfaces forget at the same point. */
export const HISTORY_CAP = 100;

/** @typedef {{ entries: string[], index: number | null, draft: string | null }} History */

/** Consecutive duplicates collapse, because sending the same line twice is
 *  one thing to recall, not two. */
export function pushHistory(entries, line, cap = HISTORY_CAP) {
  const trimmed = line.trim();
  if (!trimmed) return entries;

  const next = entries[entries.length - 1] === trimmed ? entries : [...entries, trimmed];

  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * One step through the ring. `delta` is -1 for older and +1 for newer.
 *
 * 🛑 THE FIRST PRESS SAVES THE DRAFT. Without it, reaching for an old line
 * destroys the one you were writing, and stepping back down cannot restore it.
 *
 * Returns null when nothing should change, so the caller needs no guards.
 *
 * @param {History} hist
 * @param {number} delta
 * @param {string} current what the composer holds right now
 * @returns {{ index: number | null, draft: string | null, value: string } | null}
 */
export function historyStep({ entries, index, draft }, delta, current) {
  if (delta < 0) {
    if (entries.length === 0) return null;
    if (index === null) {
      const newest = entries.length - 1;

      return { index: newest, draft: current, value: entries[newest] };
    }
    if (index === 0) return null;

    return { index: index - 1, draft, value: entries[index - 1] };
  }

  if (index === null) return null;
  // Past the newest entry is the draft you were writing, not an entry.
  if (index >= entries.length - 1) return { index: null, draft: null, value: draft ?? '' };

  return { index: index + 1, draft, value: entries[index + 1] };
}

/**
 * 🛑 THE CLI COMPOSER IS ONE LINE AND THIS ONE IS NOT. Shift-Enter makes a
 * newline, so taking ArrowUp unconditionally would stop the caret moving
 * between lines. History only claims the key at the edge it would leave.
 *
 * @param {string} value
 * @param {number} caret
 * @param {number} delta -1 for older, +1 for newer
 */
export function historyKeyApplies(value, caret, delta) {
  const pos = Math.max(0, Math.min(caret, value.length));

  return delta < 0
    ? !value.slice(0, pos).includes('\n')
    : !value.slice(pos).includes('\n');
}

/**
 * What a message's copy button puts on the clipboard.
 *
 * 🛑 THE STORED BODY IS ALREADY MARKDOWN. The browser renders `body_html`,
 * which the SERVER derives from `body`, so copying the body is the message's
 * own source rather than a reconstruction of the rendered output.
 *
 * `time` is passed in preformatted, so this stays free of the DOM and of the
 * machine's timezone.
 *
 * @param {{ from: string, time: string, body: string }} message
 * @param {{ attributed?: boolean }} [opts]
 */
export function messageMarkdown({ from, time, body }, { attributed = false } = {}) {
  // Plain copy is byte-exact on purpose: it is what the sender typed.
  if (!attributed) return body;

  return `**${from}** · ${time}\n\n${body.trimEnd()}`;
}
