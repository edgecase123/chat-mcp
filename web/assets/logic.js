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

  return suggest.items[suggest.index].insert === value;
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
