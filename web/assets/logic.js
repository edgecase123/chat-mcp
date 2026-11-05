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

/**
 * A position this close to the end counts as the bottom.
 *
 * 🛑 NOT ZERO, AND NO LONGER 24. Zero is unsafe: a fractional `scrollHeight`
 * makes an exact test read false on a view that looks pinned. 24 was wide
 * enough that nudging up by one short line still counted as pinned, so the
 * next arrival yanked the view back while you were reading. 4 covers
 * sub-pixel rounding and nothing a reader would do on purpose.
 */
export const BOTTOM_TOLERANCE_PX = 4;

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

/**
 * Whether the stream can be grown in place, or has to be rebuilt.
 *
 * 🛑 A REBUILD DESTROYS WHAT THE READER IS DOING. `innerHTML = ''` collapses
 * any text selection in the transcript, so before this existed, highlighting a
 * code block and having a peer say anything lost the selection.
 *
 * Append is only safe when the rendered prefix is still exactly the head of
 * the new list. A different target, a page of older messages loaded above, or
 * a shorter list all rebuild.
 *
 * 🛑 THIS COMPARES IDS, NOT CONTENT. A message whose BODY changed under the
 * same id is not detected, and its stale text would stay on screen. Nothing
 * edits a message today, so there is no such path to guard; an edit feature
 * has to carry a version in the id comparison or force a rebuild itself.
 * Raised by claude1 reviewing PR 99, against a docblock that claimed
 * otherwise.
 *
 * 🛑 A REBUILD STILL HAS TO NAME ITS ARRIVALS, OR THEY CANNOT SHIMMER. The
 * server serves at most 100 rows, so past that a new message drops the oldest
 * and the prefix moves. That rebuilt, and a rebuild rendered every node with
 * no `fresh` flag — so no conversation past 100 messages ever shimmered.
 * Reported by lee: #leagues at 235 messages never did, a 3-message DM always
 * did.
 *
 * ⚠️ A SLID WINDOW AND A PAGE OF OLDER HISTORY BOTH MOVE THE PREFIX, so the
 * mismatch alone cannot tell them apart. Only ids AFTER the last one the DOM
 * already held are arrivals; a scroll-up adds ids before it and names none.
 *
 * @param {{ target: string|null, ids: number[] }} prev  what the DOM holds
 * @param {{ target: string|null, ids: number[] }} next  what state now holds
 * @returns {{ mode: 'full', freshIds?: number[] } | { mode: 'append', from: number }}
 */
export function streamPlan(prev, next) {
  if (prev.target !== next.target) return { mode: 'full' };
  if (prev.ids.length === 0) return { mode: 'full' };
  if (next.ids.length < prev.ids.length) return { mode: 'full' };

  for (let i = 0; i < prev.ids.length; i++) {
    if (prev.ids[i] !== next.ids[i]) return rebuildNamingArrivals(prev, next);
  }

  return { mode: 'append', from: prev.ids.length };
}

/**
 * A rebuild, plus the ids that arrived since the DOM was last filled.
 *
 * `freshIds` is OMITTED rather than empty when there are none, so an ordinary
 * rebuild stays exactly `{ mode: 'full' }`.
 *
 * @param {{ target: string|null, ids: number[] }} prev
 * @param {{ target: string|null, ids: number[] }} next
 */
function rebuildNamingArrivals(prev, next) {
  const lastHeld = prev.ids[prev.ids.length - 1];
  const at = next.ids.lastIndexOf(lastHeld);

  // Not found means the window moved past everything the DOM held, so which
  // rows are new is unknowable. Shimmering all of them is worse than none.
  if (at === -1) return { mode: 'full' };

  const freshIds = next.ids.slice(at + 1);

  return freshIds.length === 0 ? { mode: 'full' } : { mode: 'full', freshIds };
}

/** @param {number} unread */
export function jumpLabel(unread) {
  if (unread > 0) return `${unread} new message${unread === 1 ? '' : 's'} ↓  (End)`;

  return 'Jump to newest ↓  (End)';
}

/**
 * How loud the jump affordance should be, from how long the OLDEST unread
 * message has been waiting (#121).
 *
 * 🛑 TIME, NOT COUNT. lee's words were "brighten louder UNTIL it is clicked",
 * and a count-driven level stops climbing the moment arrivals stop — so ONE
 * message ignored for ten minutes would stay as dim as one ignored for one
 * second. Rejected for that reason, not for cost.
 *
 * ⚠️ PURE, AND IT DOES NOT READ A CLOCK. The caller passes elapsed time, so a
 * test can reach every level without waiting and without faking `Date.now`.
 *
 * Levels are STEPS, never a pulse: nothing animates, so
 * `prefers-reduced-motion` needs no second code path and a glance at any
 * moment shows the current level. Chosen by lee, 2026-11-04.
 *
 * @param {number} waitingForMs  how long the oldest unread has been waiting
 * @returns {0|1|2|3} 0 means "no louder than the resting border"
 */
export function jumpUrgency(waitingForMs) {
  if (!Number.isFinite(waitingForMs) || waitingForMs <= 0) return 0;

  let level = 0;
  for (const threshold of JUMP_URGENCY_MS) {
    if (waitingForMs >= threshold) level += 1;
  }

  return /** @type {0|1|2|3} */ (level);
}

/**
 * The thresholds, ascending. The last one is the CAP — past it the border
 * holds, so an ignored message never escalates forever.
 */
export const JUMP_URGENCY_MS = [3000, 8000, 15000];

/**
 * When the current run of unread messages STARTED, or null if none is waiting.
 *
 * 🛑 THE OLDEST UNREAD SETS THE CLOCK, NOT THE NEWEST. A later arrival must
 * not restart it: in a busy room a steady trickle would then hold the border
 * at level 0 forever, which is the exact case the feature exists for.
 *
 * @param {number|null} previousSince
 * @param {number} unread
 * @param {number} nowMs
 * @returns {number|null}
 */
export function nextUnreadSince(previousSince, unread, nowMs) {
  if (unread <= 0) return null;

  return previousSince ?? nowMs;
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
 * Commands a sidebar menu may open in the composer.
 *
 * ⚠️ NOT DERIVED FROM THE COMMAND TABLE, which lives in app.js. A rename
 * there leaves a prefill here pointing at a command that no longer exists,
 * and nothing fails. The test below pins these three names so the rename at
 * least breaks a test; grep this file when renaming a command.
 */
const MENU_COMMANDS = { dispatch: 'dispatch', broadcast: 'broadcast', alert: 'alert' };

/**
 * What the `...` menu on a sidebar row offers.
 *
 * 🛑 THE DESTRUCTIVE ENTRY IS LAST AND THERE IS EXACTLY ONE. It used to be
 * the only entry, so the menu could not be opened by accident into anything
 * but Kick or Delete. Now that it has neighbours, position is what keeps a
 * mis-click off it.
 *
 * A peer and a room take different verbs throughout: dispatch against
 * broadcast, kick against delete. Leave has no peer equivalent, because a DM
 * is not a membership.
 *
 * An entry carrying `prefill` writes that text into the composer and sends
 * nothing. Its label ends in an ellipsis to say so.
 *
 * @param {'room' | 'peer'} kind
 * @param {string} label
 * @returns {{ text: string, title: string, action: string, prefill?: string,
 *             destructive?: boolean }[]}
 */
export function menuEntriesFor(kind, label) {
  if (kind === 'room') {
    return [
      {
        text: 'Broadcast\u2026',
        title: `Hand a task to everyone in ${label}`,
        action: 'prefill',
        prefill: `/${MENU_COMMANDS.broadcast} ${label} `,
      },
      {
        text: 'Alert\u2026',
        title: `Send ${label} something urgent`,
        action: 'prefill',
        prefill: `/${MENU_COMMANDS.alert} ${label} `,
      },
      { text: 'Copy name', title: `Copy ${label} to the clipboard`, action: 'copyName' },
      {
        text: 'Leave',
        title: `Leave ${label}. It stays for everyone else.`,
        action: 'leaveRoom',
      },
      {
        text: 'Delete',
        title: `Delete ${label} for everyone`,
        action: 'deleteRoom',
        destructive: true,
      },
    ];
  }

  return [
    {
      text: 'Dispatch\u2026',
      title: `Hand a task to ${label}`,
      action: 'prefill',
      prefill: `/${MENU_COMMANDS.dispatch} ${label} `,
    },
    {
      text: 'Alert\u2026',
      title: `Send ${label} something urgent`,
      action: 'prefill',
      prefill: `/${MENU_COMMANDS.alert} ${label} `,
    },
    { text: 'Copy handle', title: `Copy ${label} to the clipboard`, action: 'copyName' },
    { text: 'Kick', title: `Remove ${label} from the bus`, action: 'kickPeer', destructive: true },
  ];
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

/** `/name <arg>`, with the space dropped when a command takes no argument. */
export function commandUsage(command) {
  return `/${command.name} ${command.arg}`.trimEnd();
}

/**
 * The dash column for a set of labels.
 *
 * 🛑 MEASURED, NEVER A CONSTANT, AND MEASURED OVER EVERY SECTION THAT SHARES
 * THE COLUMN. A hardcoded 24 let `/broadcast <#room> <text>` run into its own
 * description. Fixing only the command rows then split the sheet into two
 * columns, 28 and 26, which is the same defect one section lower.
 * The +1 is the space before the dash at the widest label.
 */
export function dashColumn(labels) {
  return labels.length ? Math.max(...labels.map((l) => l.length)) + 1 : 0;
}

/**
 * 🛑 GENERATED FROM THE COMMAND TABLE, NOT TYPED OUT. A hand-written list of
 * commands goes stale the first time one is added and nobody notices.
 *
 * 🛑 BOTH `/help` AND `/cheat-sheet` PRINT THIS. One builder, two surfaces —
 * a toast and the stream. A second builder is how one new command ends up
 * described two different ways depending on which you typed. A test asserts
 * the two surfaces carry the same rows, space-collapsed.
 *
 * `width` and `headingIndent` are what the two surfaces may differ on. The
 * sheet passes a width measured over its gesture rows too, and indents its
 * headings; the toast takes the default width and outdents.
 *
 * @param {{ name: string, arg: string, desc: string, cat: string }[]} commands
 * @param {Record<string, string>} labels category key -> heading
 */
export function commandBlock(commands, labels, { width, headingIndent = '  ' } = {}) {
  const w = width ?? dashColumn(commands.map(commandUsage));

  return Object.keys(labels)
    .map((cat) => {
      const rows = commands
        .filter((c) => c.cat === cat)
        .map((c) => '  ' + commandUsage(c).padEnd(w) + `— ${c.desc}`);

      return rows.length ? [`${headingIndent}${labels[cat]}`, ...rows].join('\n') : null;
    })
    .filter(Boolean)
    .join('\n\n');
}

/** Gestures, as data, so one measurement can cover them and the commands. */
const GESTURE_SECTIONS = [
  ['COMPOSER', [
    ['Enter', 'send'],
    ['Shift-Enter', 'newline, without sending'],
    ['#', 'complete a peer or room name'],
    ['Tab or Enter', 'accept the highlighted completion'],
    ['Up / Down', 'move through the completion list'],
    ['Esc', 'dismiss the completion list'],
    ['Up / Down', 'with no list open, step through lines you sent'],
    ['drop a file on the window', 'insert its path at the caret'],
    { cont: 'relative to the project folder, "~/" under home', pad: 2 },
  ]],
  ['MESSAGES', [
    ['click the copy icon', 'copy the message markdown as typed'],
    ['Shift-click it', 'copy it under the author and the time'],
  ]],
  ['SIDEBAR', [
    ['click a row', 'open that peer or room'],
    ['(3) beside a row', 'unread messages waiting there'],
    ['... on a peer', 'Dispatch, Alert, Copy handle, Kick'],
    ['... on a room', 'Broadcast, Alert, Copy name, Leave, Delete'],
    ['an entry ending "..."', 'opens in the composer, sends nothing'],
    ['the entry below the rule', 'destructive, and asks first'],
  ]],
  ['READING', [
    ['End', 'jump to the newest message'],
    { cont: 'only while the composer is empty, because End', pad: 0 },
    { cont: 'otherwise moves the caret', pad: 0 },
    ['the jump badge', 'appears when messages arrive below the view'],
  ]],
];

/**
 * The command block, plus the gesture sections no table can generate.
 *
 * 🛑 ONE DASH COLUMN FOR THE WHOLE SHEET, measured over the commands AND the
 * gesture labels together. Two independently padded sections read as two
 * tables. A test asserts every dash in the output sits at one column.
 *
 * Each gesture line was checked against app.js when written.
 *
 * @param {{ name: string, arg: string, desc: string, cat: string }[]} commands
 * @param {Record<string, string>} labels category key -> heading
 */
export function cheatSheet(commands, labels) {
  const gestureLabels = GESTURE_SECTIONS.flatMap(([, rows]) =>
    rows.filter(Array.isArray).map(([label]) => label));
  const width = dashColumn([...commands.map(commandUsage), ...gestureLabels]);

  const gestures = GESTURE_SECTIONS.flatMap(([heading, rows]) => [
    heading,
    ...rows.map((row) => Array.isArray(row)
      ? '  ' + row[0].padEnd(width) + `— ${row[1]}`
      : '  ' + ' '.repeat(width + 2 + row.pad) + row.cont),
    '',
  ]);

  return [
    'CHEAT SHEET',
    '',
    'SLASH COMMANDS',
    commandBlock(commands, labels, { width }),
    '',
    ...gestures,
    'This sheet is not saved. It disappears when you switch away.',
  ].join('\n');
}

/** Path chars. Includes "/" and "~", which the "#" token deliberately excludes. */
const PATH_BODY = /[A-Za-z0-9._~\-/]/;

/** The same class as a run, for checking a gap holds only path chars and spaces. */
const PATH_BODY_RUN = /[A-Za-z0-9._~\-/]+/g;

/**
 * The `@path` token under the caret, or null.
 *
 * 🛑 "@" IS FOR FILE PATHS AND "#" IS FOR NAMES. Ruled by lee. The two tokens
 * must not both answer, or accepting one inserts the other's text.
 *
 * Same two rules as the "#" token: the trigger opens a word, and the token
 * runs to the end of that word rather than stopping at the caret.
 *
 * @param {string} value
 * @param {number} caret
 * @returns {{ query: string, start: number, end: number } | null}
 */
export function atTokenAt(value, caret) {
  if (value.startsWith('/') && !value.includes('\n')) return null;

  const pos = Math.max(0, Math.min(caret, value.length));
  const upto = value.slice(0, pos);
  const at = upto.lastIndexOf('@');
  if (at < 0) return null;

  const before = at === 0 ? '' : upto[at - 1];
  if (before !== '' && !/\s/.test(before)) return null;

  let end = at + 1;
  while (end < value.length && PATH_BODY.test(value[end])) end += 1;

  if (end < pos) {
    // 🛑 A SPACE ENDS THE TOKEN UNLESS IT IS INSIDE A PATH. Every macOS
    // screenshot is "Screenshot <date> at <time>.png", so the space arrives
    // right after the first word anyone types and the popover closed on it.
    //
    // 🛑 THE "/" IS WHAT MAKES THIS SAFE. Without it "@claude1 are you there"
    // would become one token and every mention would break. A path has a
    // separator; a handle does not.
    const typed = value.slice(at + 1, pos);
    // 🛑 THE "/" MUST ARRIVE BEFORE THE FIRST SPACE, not anywhere in the text.
    // Searching the whole string let "@claude1 look in src/foo" qualify on a
    // slash four words later, so a mention swallowed the sentence behind it.
    // Path-ness has to be established by the time the first space is reached.
    // Found by claude1 reviewing the first cut.
    const firstSpace = typed.search(/[ \t]/);
    const head = firstSpace < 0 ? typed : typed.slice(0, firstSpace);
    if (!head.includes('/')) return null;
    if (!/^[ \t]*$/.test(value.slice(end, pos).replace(PATH_BODY_RUN, ' '))) return null;

    // The caret is the end. A path with spaces has no unambiguous end while
    // it is still being typed, so anything after the caret stays put.
    return { query: typed, start: at, end: pos };
  }

  return { query: value.slice(at + 1, pos), start: at, end };
}

/**
 * Turns the server's hints into composer items.
 *
 * Each hint's `value` already carries its own "@" and its directory, so it
 * replaces the whole token rather than being appended to it.
 *
 * 🛑 A DIRECTORY GETS NO TRAILING SPACE, so accepting it reopens the list and
 * you keep drilling down. A file gets one, because it is finished.
 *
 * @param {{ value: string, kind: 'dir' | 'file' }[]} hints
 * @param {string} value
 * @param {number} caret
 */
export function pathSuggestionsFor(hints, value, caret) {
  const token = atTokenAt(value, caret);
  if (!token || hints.length === 0) return null;

  const tail = value.slice(token.end);

  const items = hints.map((hint) => {
    const dir = hint.kind === 'dir';
    const pad = dir || /^\s/.test(tail) ? '' : ' ';
    const head = value.slice(0, token.start) + hint.value + pad;

    // 🛑 reopen is EXPLICIT, not sniffed from a trailing space. A directory
    // inserts no space, so acceptReopens would close the list and the
    // drill-down would stop at the first level.
    return {
      insert: head + tail,
      caret: head.length,
      name: hint.value,
      arg: '',
      desc: hint.kind,
      reopen: dir,
    };
  });

  return { items, index: 0, kind: 'path', typed: `@${token.query}` };
}

/**
 * The paths carried by a drag, newest browsers first.
 *
 * 🛑 THE FILE LIST CANNOT ANSWER THIS. `DataTransfer.files` yields `File`
 * objects, and a `File` exposes `.name` and no path at all — that is a
 * deliberate browser privacy boundary, not an oversight. The full path
 * arrives only in the drag's `text/uri-list`, which Finder and VS Code set
 * as `file:///...` URLs.
 *
 * Per RFC 2483 a uri-list is one URI per line and a line opening with "#" is
 * a comment. Anything that is not a `file:` URL is dropped: a drag from a
 * browser carries `https:` and there is no path in it.
 *
 * @param {string} uriList the drag's text/uri-list payload
 * @returns {string[]} absolute paths, decoded
 */
export function pathsFromUriList(uriList) {
  return (uriList || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    // 🛑 NO SEPARATE "#" COMMENT FILTER. RFC 2483 says a line opening with
    // "#" is a comment, and one is unreachable here: a line cannot both open
    // with "#" and open with "file://". A filter for it was written, could
    // not be killed by any mutant, and was removed rather than kept as a
    // guard that cannot fire.
    .filter((line) => line.toLowerCase().startsWith('file://'))
    .map(pathFromFileUri)
    .filter((path) => path !== null);
}

/**
 * `file:///a/b` and `file://localhost/a/b` both mean `/a/b`.
 *
 * ⚠️ A HOST THAT IS NOT THIS MACHINE IS REFUSED. `file://server/share` is a
 * remote path and inserting it as a local one would be a lie.
 */
function pathFromFileUri(uri) {
  const rest = uri.slice('file://'.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;

  const host = rest.slice(0, slash);
  if (host !== '' && host.toLowerCase() !== 'localhost') return null;

  try {
    return decodeURIComponent(rest.slice(slash));
  } catch {
    // A malformed percent-escape is not a path. Dropping it beats inserting
    // a mangled one.
    return null;
  }
}

/**
 * What a dropped path becomes in the composer.
 *
 * Ruled by lee: relative to the project folder when it can be, `~/` when it
 * is under home, and the absolute path when it is under neither.
 *
 * 🛑 THE PROJECT FOLDER IS TESTED FIRST AND THE ORDER IS LOAD-BEARING. The
 * project folder is normally INSIDE home, so testing home first would turn
 * every project file into a `~/dev/...` path and the `@` hints would
 * disagree with the drop for the same file.
 *
 * @param {string} abs an absolute path
 * @param {{ cwd: string, home: string }} roots
 */
export function droppedPathValue(abs, { cwd, home }) {
  const underCwd = relativeTo(abs, cwd);
  if (underCwd !== null) return underCwd === '' ? '.' : underCwd;

  const underHome = relativeTo(abs, home);
  if (underHome !== null) return underHome === '' ? '~' : `~/${underHome}`;

  return abs;
}

/** The part of `abs` below `root`, or null when it is not under it. */
function relativeTo(abs, root) {
  if (!root) return null;
  const base = root.endsWith('/') ? root.slice(0, -1) : root;
  if (abs === base) return '';
  // 🛑 The trailing slash is what stops "/proj-other" matching "/proj".
  if (!abs.startsWith(`${base}/`)) return null;

  return abs.slice(base.length + 1);
}

/**
 * The text a drop inserts, for one or many files.
 *
 * ⚠️ SEPARATED BY A SPACE AND NOT QUOTED. A path containing a space is
 * therefore ambiguous when several are dropped at once. The composer is
 * prose read by a person rather than a shell, so this is a known limit and
 * not a bug to work around with quoting nobody asked for.
 */
/**
 * The text a drop inserts when the browser handed over no path.
 *
 * 🛑 A BROWSER FILE DROP CARRIES `File.name` AND NOTHING ELSE. Measured on a
 * real Finder drag of "Screenshot 2026-10-20 at 7.15.09 PM.png": no
 * `text/uri-list`, no `text/plain`, so there is no path to insert and there
 * never will be from that gesture.
 *
 * ⚠️ QUOTED WHEN IT CONTAINS A SPACE, unlike `dropInsertText`. A name is the
 * whole token here, so two unquoted names with spaces cannot be told apart.
 * A path keeps its directory separators to lean on and does not need this.
 *
 * 🛑 AND AN EMBEDDED QUOTE IS ESCAPED, because a filename may contain one —
 * `touch 'two "q" .png'` succeeds on macOS. Quoting without escaping ends the
 * token early, so two names become unreadable as a pair. Raised by claude1.
 */
export function dropNameText(names) {
  return names
    .map((name) => (/\s|"/.test(name) ? `"${name.replace(/"/g, '\\"')}"` : name))
    .join(' ');
}

export function dropInsertText(paths, roots) {
  return paths.map((p) => droppedPathValue(p, roots)).join(' ');
}

// ── /clear ───────────────────────────────────────────────────────────────

/** A `#` prefix is the only thing separating a room target from a DM peer. */
const isRoomTarget = (target) => target.startsWith('#');

/**
 * The browser confirms first; the server's 403 is the second line, not the
 * only one. Same shape as the `/delete` and `/kick` confirms above it in
 * `app.js`.
 *
 * The two wordings differ because the blast radius does. A room clear resets
 * every member's unread mark; a DM clear removes both directions of the
 * conversation, so it is never one-sided.
 */
export function clearConfirmText(target) {
  if (isRoomTarget(target)) {
    return `Clear ${target}?\n\n`
      + `Every message ever sent to ${target} is deleted for EVERYONE, not `
      + 'just you, and every member\'s unread mark resets. The room and its '
      + 'memberships stay. This cannot be undone.';
  }
  return `Clear your conversation with ${target}?\n\n`
    + `Every message between you and ${target} is deleted, in both `
    + 'directions, for BOTH of you. This cannot be undone.';
}

/**
 * Zero is a SUCCESS. The DAO returns a row count, so it cannot tell an empty
 * room from a missing one — and the route answers 403 before a missing room
 * could ever reach here.
 */
export function clearResultText(count, target) {
  const where = isRoomTarget(target) ? `from ${target}` : `with ${target}`;
  if (count === 0) return `${target} was already empty`;
  return `cleared ${count} message${count === 1 ? '' : 's'} ${where}`;
}

/**
 * What the style selector should do with a chosen value (#92).
 *
 * 🛑 DECIDED FROM VALUES ALONE, so it is testable without a DOM — the rule
 * app.js states at the top of itself. Returns the action and, for a revert, the
 * value to put back.
 *
 * `custom` opens the editor rather than saving, because the server demands
 * markdown alongside it.
 */
export function styleSelection(chosen, currentStyle) {
  if (chosen === 'custom') {
    return { action: 'edit', revertTo: currentStyle ?? '' };
  }

  return { action: 'save', style: chosen === '' ? null : chosen };
}

/**
 * Whether a room on this style needs its own way back into the editor.
 *
 * 🛑 RE-PICKING THE SELECTED OPTION FIRES NO `change`, so the selector cannot
 * reopen the editor for a room already on `custom`. Measured in Chromium: a
 * keypress selecting `custom` over `custom` fired 0 change events where a real
 * change fired one.
 */
export function styleEditAffordance(style) {
  return style === 'custom';
}

/**
 * Whether the markdown in the editor can be saved, and why not when it cannot.
 *
 * Mirrors the server's own guard so the operator hears about an empty or
 * oversized style before a round trip, not after a 400.
 */
export const STYLE_CUSTOM_MAX_BYTES = 65536;

export function customStyleSubmission(markdown) {
  const text = (markdown ?? '').trim();

  if (text === '') {
    return { ok: false, error: 'A custom style needs some markdown.' };
  }

  // The server measures BYTES, not characters, so a style of emoji or accented
  // text is larger than its length suggests.
  const bytes = new TextEncoder().encode(text).length;

  if (bytes > STYLE_CUSTOM_MAX_BYTES) {
    return { ok: false, error: `Too long: ${bytes} bytes, the cap is ${STYLE_CUSTOM_MAX_BYTES}.` };
  }

  return { ok: true, style: 'custom', custom: text };
}

/**
 * What to render for a peer's context gauge.
 *
 * 🛑 A STALE READING RENDERS AS UNKNOWN, NOT AS ITS LAST VALUE. Measured
 * 2026-11-04: both agents sat at exactly `1000000/1000000` with a 27.7-day-old
 * timestamp, and every reader took it as current because nothing subtracted
 * the age. Showing the number greyed would repeat that — the digits are what
 * people act on.
 *
 * `fresh` and `age_ms` are computed server-side (`/api/whoami`), so the
 * 15-minute window has ONE home and this file never hard-codes it.
 *
 * @param {{context_used?: number|null, context_total?: number|null, fresh?: boolean, age_ms?: number|null}} peer
 * @returns {{show: boolean, percent: number|null, band: string, title: string}}
 */
export function gaugeDisplay(peer) {
  const used = peer?.context_used;
  const total = peer?.context_total;
  const reported = used != null && total != null && total > 0;

  if (!reported) {
    return { show: false, percent: null, band: 'none', title: 'Context usage not reported' };
  }

  if (peer.fresh !== true) {
    return {
      show: true,
      percent: null,
      band: 'stale',
      title: `Context usage is ${ageLabel(peer.age_ms)} old — the agent has stopped reporting`,
    };
  }

  const percent = Math.round((used / total) * 100);

  // 🛑 EVERY BUS BAND EXCEPT THE PLANNING ONE. Not "the bands the bus warns
  // on" (it warns at 50 too) and not "the bands it posts to a room" (70 is a
  // DM and is coloured here). Both of those were written and both were false.
  // The rule is the exclusion: 50 asks for a plan, and a plan is not an
  // escalation, so it earns no colour. Pinned by `the web gauge colours every
  // band EXCEPT the planning one` in test/shim/gauge-bands.test.ts.
  const band = percent >= 95 ? 'crit' : percent >= 85 ? 'warn' : percent >= 70 ? 'soft' : 'ok';

  return { show: true, percent, band, title: `Context ${percent}% — ${used.toLocaleString()} of ${total.toLocaleString()} tokens` };
}

/** A duration a human reads at a glance. Exported for its own test. */
export function ageLabel(ms) {
  if (ms == null) return 'never reported';

  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;

  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;

  return `${Math.floor(hours / 24)}d`;
}

/**
 * One row of the claims panel (#101).
 *
 * 🛑 A CLAIM IS A LOCK, SO THE AGE IS THE INTERESTING NUMBER. "held 41m" is
 * what tells an operator a gate has overrun; the expiry is a failsafe nobody
 * should be planning around, so it is the quieter half.
 *
 * 🛑 PURE, AND EXPORTED FOR ITS OWN TEST. The bus computes the minutes; this
 * only decides what the operator reads, which is the part that was prose in a
 * chat message before #101.
 */
export function claimRow(claim, { me } = {}) {
  const held = claim.held_for_minutes;
  const left = claim.expires_in_minutes;

  return {
    resource: claim.resource,
    holder: claim.holder,
    mine: claim.holder === me,
    note: claim.note || null,
    // ⚠️ The age, never a clock time. An operator reading "held 41m" does not
    // have to subtract anything, which is the whole reason the panel exists.
    age: `held ${durationLabel(held)}`,
    expiry: `failsafe in ${durationLabel(left)}`,
    // 🛑 STALE IS A CLAIM OUTLIVING ANY LEGITIMATE HOLD, not one near expiry.
    // The failsafe is four hours; a full gate is about 23 minutes. So an hour
    // is the line where "still running" stops being the likely explanation.
    stale: held >= 60,
  };
}

/** Minutes as something read at a glance. Shared by both halves of a claim row. */
function durationLabel(mins) {
  if (mins < 60) return `${mins}m`;

  const h = Math.floor(mins / 60);
  const m = mins % 60;

  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

/**
 * What the claims panel says when it is empty.
 *
 * 🛑 NOT A BLANK. An empty panel and a panel that failed to load look
 * identical, and that ambiguity is the #103 incident in a different place.
 */
export function claimsPanelEmpty() {
  return '(nothing claimed)';
}

/**
 * The id shown beside a message's timestamp (#104).
 *
 * 🛑 THE WORDS, NOT A BARE NUMBER. "see 12582" is how one agent points another
 * at a message, and a lone number in the meta row is indistinguishable from a
 * count or a duration. lee asked for this wording, 2026-11-04.
 *
 * @param {number} id
 */
export function messageIdLabel(id) {
  return `Message ID: ${id}`;
}

/**
 * The next match to focus when the reader presses Enter in the filter.
 *
 * 🛑 WRAPS, AND THE FIRST PRESS GOES TO THE FIRST MATCH. Starting at -1 means
 * `current + 1` is 0, so no special case is needed for "nothing focused yet".
 *
 * ⚠️ RETURNS -1 WHEN THERE IS NOTHING TO FOCUS, rather than 0. A caller that
 * got 0 for an empty list would reveal a row that does not exist.
 *
 * @param {number} current  the focused index, or -1 for none
 * @param {number} total    how many matches there are
 * @param {1|-1} delta      forward on Enter, back on Shift-Enter
 */
export function nextMatchIndex(current, total, delta = 1) {
  if (!Number.isFinite(total) || total <= 0) return -1;

  const from = Number.isFinite(current) ? current : -1;

  // 🛑 "NOTHING FOCUSED" IS NOT INDEX -1 FOR BOTH DIRECTIONS. Forward from
  // nothing is the first match; BACK from nothing is the LAST, the way
  // find-in-page behaves. Modular arithmetic alone gave index 1 of 3 here,
  // which a test caught.
  if (from < 0) return delta > 0 ? 0 : total - 1;

  // `+ total` because -1 % n is -1 in JS, which would index off the front.
  return (((from + delta) % total) + total) % total;
}

/**
 * What the filter box reports about the focused match.
 *
 * 🛑 BOTH NUMBERS, ALWAYS. "3" alone does not say whether more follow, which
 * is the whole question a reader pressing Enter is asking.
 *
 * @param {number} index  the focused index, or -1
 * @param {number} total
 */
export function matchPositionLabel(index, total) {
  if (total <= 0) return '';
  if (index < 0) return `${total} match${total === 1 ? '' : 'es'}`;

  return `${index + 1} of ${total}`;
}

/**
 * The fragment that links to one message (#104).
 *
 * 🛑 THE ID ALONE, NOT THE CONVERSATION TOO. Ids are globally unique and the
 * server resolves the target, so a link cannot name a conversation that
 * disagrees with the message in it.
 *
 * @param {number} id
 */
export function messageHash(id) {
  return `#m${id}`;
}

/**
 * The id a fragment points at, or null if it points at nothing.
 *
 * ⚠️ REFUSES WHAT `parseInt` WOULD TAKE. `#m12x` and `#m` would otherwise
 * become 12 and NaN, so a hand-edited or truncated link would either open the
 * wrong message or send NaN to the server. Mirrors `parseAroundId` on the
 * server deliberately — the two have to agree about what an id is.
 *
 * @param {string} hash  `location.hash`, with or without the leading #
 * @returns {number|null}
 */
export function messageIdFromHash(hash) {
  const m = /^#?m([0-9]+)$/.exec(hash ?? '');

  if (m === null) return null;

  const id = Number(m[1]);

  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Every place a search term appears in a string (#102).
 *
 * 🛑 RANGES, NOT A REPLACED STRING. Returning marked-up text would mean
 * injecting `<mark>` either into markdown source — which corrupts a code span
 * or a link — or into rendered HTML, where it can land inside a tag and is an
 * injection hazard. The caller wraps TEXT NODES using these offsets, which
 * cannot do either.
 *
 * 🛑 LITERAL AND CASE-INSENSITIVE, matching how the bus found the row. A regex
 * built from user text would treat `100%` and `context_used` as patterns, the
 * same defect `likePattern` exists to stop on the SQL side.
 */
export function matchRanges(text, term) {
  const needle = (term || '').trim().toLowerCase();
  if (needle.length === 0) return [];

  const hay = text.toLowerCase();
  const out = [];
  let from = 0;

  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) return out;

    out.push({ start: at, end: at + needle.length });
    // ⚠️ Advance past the whole match, never by one. Overlapping ranges
    // produce nested <mark> elements around the same characters.
    from = at + needle.length;
  }
}

/**
 * A string split into the parts that match a term and the parts that do not.
 *
 * 🛑 SEGMENTS, NOT MARKED-UP TEXT, FOR THE SAME REASON `matchRanges` RETURNS
 * OFFSETS. Injecting `<mark>` into markdown source corrupts a code span or a
 * link; injecting it into rendered HTML can land inside a tag and is an
 * injection hazard. The caller turns these into text nodes and `<mark>`
 * elements, which can do neither.
 *
 * 🛑 NO EMPTY SEGMENTS. A `<mark>` wrapping nothing is a stray element, and an
 * empty text node is a child that renders nothing. A term that matches nothing
 * still returns ONE segment, because an empty list would erase the text.
 *
 * ⚠️ THE ORIGINAL CASE SURVIVES. The match is case-insensitive, but the
 * segment carries the text as written — slicing the needle in would rewrite
 * the operator's own transcript.
 *
 * @param {string} text
 * @param {string} term
 * @returns {{ text: string, hit: boolean }[]}
 */
export function highlightSegments(text, term) {
  const ranges = matchRanges(text, term);
  if (ranges.length === 0) return [{ text, hit: false }];

  const out = [];
  let at = 0;

  for (const r of ranges) {
    if (r.start > at) out.push({ text: text.slice(at, r.start), hit: false });
    out.push({ text: text.slice(r.start, r.end), hit: true });
    at = r.end;
  }
  if (at < text.length) out.push({ text: text.slice(at), hit: false });

  return out;
}

/**
 * Whether a message belongs in a filtered view.
 *
 * 🛑 THE SAME MATCH RULE AS THE HIGHLIGHT. A filter that kept a message the
 * highlighter then found nothing in would render a hit with no visible reason,
 * which reads as a bug in the search.
 */
export function messageMatchesSearch(body, term) {
  return matchRanges(body || '', term).length > 0;
}

/** What the message pane says when a filter hides everything. */
export function searchFilterEmpty(term, scanned) {
  return `no match for "${term}" in ${scanned} loaded message${scanned === 1 ? '' : 's'}`;
}

/**
 * The string a search must match: what the reader sees, plus the URLs they do
 * not (#102).
 *
 * 🛑 A MARKDOWN LINK'S URL IS INVISIBLE TO `textContent`. `[label](url)`
 * renders as `<a href=url>label</a>`, so the URL lives in an attribute and
 * nowhere in the text. Matching rendered text alone made every PR reference in
 * `#leagues` unfindable by its URL, and finding an old decision is what the box
 * is for. Found by claude1 reviewing PR 118.
 *
 * 🛑 SO "EVERY SHOWN ROW CARRIES A MARK" IS NOW IMPOSSIBLE, NOT MERELY UNDONE.
 * `highlightInPlace` walks `NodeFilter.SHOW_TEXT`, and an attribute value is
 * not a text node — an href-only hit is unmarkable by construction. Findable
 * is a strictly larger set than markable once URLs are searchable. claude1
 * named this and withdrew the union on it.
 *
 * ⚠️ A UNION WITH THE MARKDOWN SOURCE WAS REJECTED FOR NOISE, NOT FOR MARKS.
 * `body` carries every backtick, `*` and `[`, so searching `**` would match
 * every bold message in the room. Appending only hrefs adds what a reader
 * would actually look for.
 *
 * The join is a NEWLINE because the search input is single-line, so no term can
 * straddle the boundary and match text that is not contiguous on screen.
 *
 * @param {string} text   `textContent` of the rendered body
 * @param {string[]} hrefs  every `a[href]` value in it, in document order
 */
export function searchableText(text, hrefs = []) {
  const extra = [];

  for (const href of hrefs) {
    if (typeof href !== 'string' || href.length === 0) continue;
    // 🛑 `#` IS WHAT A NEUTERED LINK RENDERS AS, not a destination. `safeUrl`
    // turns a `javascript:` or `data:` target into `#`, and appending that made
    // the term "#" match every message holding a dead link. Found by claude1.
    if (href === '#') continue;
    // A bare URL is already its own label, so appending it would double it.
    if (text.includes(href)) continue;
    if (extra.includes(href)) continue;
    extra.push(href);
  }

  return extra.length === 0 ? text : `${text}\n${extra.join('\n')}`;
}

/**
 * Does this keystroke mean "focus the conversation filter"?
 *
 * 🛑 THE PLATFORM SPLIT IS LOAD-BEARING, NOT COSMETIC. On macOS `Ctrl-F` is a
 * system text binding that moves the caret one character right, so claiming it
 * would break the composer. `metaKey || ctrlKey` reads as tolerant and is the
 * bug. Each platform gets exactly one modifier.
 *
 * Cmd-F and Ctrl-F are the BROWSER's find-in-page, which is an app shortcut the
 * page outranks. The caller owes the `preventDefault()`.
 *
 * ⚠️ `shiftKey` and `altKey` are rejected rather than ignored. Cmd-Shift-F is
 * unbound today, and swallowing it now would make a later binding look broken.
 *
 * @param {{ key: string, metaKey?: boolean, ctrlKey?: boolean, shiftKey?: boolean, altKey?: boolean }} e
 * @param {boolean} isMac
 */
export function focusSearchKeyApplies(e, isMac) {
  if (typeof e?.key !== 'string' || e.key.toLowerCase() !== 'f') return false;
  if (e.shiftKey || e.altKey) return false;

  return isMac
    ? e.metaKey === true && e.ctrlKey !== true
    : e.ctrlKey === true && e.metaKey !== true;
}
