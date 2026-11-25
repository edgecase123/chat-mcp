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

  return (
    distanceFromBottom(geo) > Math.max(JUMP_VISIBLE_AFTER_PX, geo.clientHeight)
  );
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
  if (prev.target !== next.target) return { mode: "full" };
  if (prev.ids.length === 0) return { mode: "full" };
  if (next.ids.length < prev.ids.length) return { mode: "full" };

  for (let i = 0; i < prev.ids.length; i++) {
    if (prev.ids[i] !== next.ids[i]) return rebuildNamingArrivals(prev, next);
  }

  return { mode: "append", from: prev.ids.length };
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
  if (at === -1) return { mode: "full" };

  const freshIds = next.ids.slice(at + 1);

  return freshIds.length === 0 ? { mode: "full" } : { mode: "full", freshIds };
}

/** @param {number} unread */
export function jumpLabel(unread) {
  if (unread > 0)
    return `${unread} new message${unread === 1 ? "" : "s"} ↓  (End)`;

  return "Jump to newest ↓  (End)";
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
  if (!value.startsWith("/") || value.includes("\n")) return null;
  const m = value.match(/^\/(\S*)(\s+)?(.*)$/);
  if (!m) return null;
  const [, name, space, rest] = m;

  if (!space) {
    const items = ctx.commands
      .filter((c) => c.name.startsWith(name.toLowerCase()))
      .map((c) => ({
        insert: `/${c.name}${c.arg ? " " : ""}`,
        name: `/${c.name}`,
        arg: c.arg,
        desc: c.desc,
        cat: c.cat,
      }));

    return items.length ? { items, index: 0, kind: "command" } : null;
  }

  const cmd = ctx.commands.find((c) => c.name === name.toLowerCase());
  if (!cmd || !cmd.suggest || rest.includes(" ")) return null;
  const pool =
    cmd.suggest === "peer"
      ? ctx.peers
      : cmd.suggest === "room"
        ? ctx.rooms
        : [...ctx.peers, ...ctx.rooms];
  const q = rest.toLowerCase().replace(/^#/, "");
  const items = [...new Set(pool)]
    .filter((h) => h.toLowerCase().replace(/^#/, "").startsWith(q))
    .map((h) => ({
      insert: `/${cmd.name} ${h}`,
      name: h,
      arg: "",
      desc: cmd.suggest,
    }));

  return items.length ? { items, index: 0, kind: "arg" } : null;
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
  if (suggest.kind === "mention") return suggest.typed === item.name;

  return item.insert === value;
}

/** Accepting only reopens for a command that TAKES an argument. "/help"
 *  reopening on itself is what left Enter unable to send. */
export function acceptReopens(insert) {
  return insert.endsWith(" ");
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
const MENU_COMMANDS = {
  dispatch: "dispatch",
  broadcast: "broadcast",
  alert: "alert",
};

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
  if (kind === "room") {
    return [
      {
        text: "Broadcast\u2026",
        title: `Hand a task to everyone in ${label}`,
        action: "prefill",
        prefill: `/${MENU_COMMANDS.broadcast} ${label} `,
      },
      {
        text: "Alert\u2026",
        title: `Send ${label} something urgent`,
        action: "prefill",
        prefill: `/${MENU_COMMANDS.alert} ${label} `,
      },
      {
        text: "Copy name",
        title: `Copy ${label} to the clipboard`,
        action: "copyName",
      },
      {
        text: "Leave",
        title: `Leave ${label}. It stays for everyone else.`,
        action: "leaveRoom",
      },
      {
        text: "Delete",
        title: `Delete ${label} for everyone`,
        action: "deleteRoom",
        destructive: true,
      },
    ];
  }

  return [
    {
      text: "Dispatch\u2026",
      title: `Hand a task to ${label}`,
      action: "prefill",
      prefill: `/${MENU_COMMANDS.dispatch} ${label} `,
    },
    {
      text: "Alert\u2026",
      title: `Send ${label} something urgent`,
      action: "prefill",
      prefill: `/${MENU_COMMANDS.alert} ${label} `,
    },
    {
      text: "Copy handle",
      title: `Copy ${label} to the clipboard`,
      action: "copyName",
    },
    {
      // #397 slice 3b — ONE entry on the DEFAULT branch, which serves agent
      // rows and peer rows both because they already share `kind: "peer"`.
      //
      // 🛑 NO ELLIPSIS, AND IT IS NOT AN OVERSIGHT. In this menu the ellipsis
      // means "opens in the composer" — `menu-entries.test.ts` asserts it iff
      // a `prefill` is present. This opens a MODAL, so the ellipsis would
      // promise the wrong surface. lee's own wording carried none either.
      //
      // 🛑 NO ARGUMENT AND NO PREFILL. The handler reads the gate and the
      // current fill out of state by handle, because `menuEntriesFor` is pure
      // and `label` is the only thing it is given.
      text: "Set Threshold",
      title: `Set the context restart threshold for ${label}`,
      action: "setThreshold",
    },
    {
      text: "Kick",
      title: `Remove ${label} from the bus`,
      action: "kickPeer",
      destructive: true,
    },
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
  if (value.startsWith("/") && !value.includes("\n")) return null;

  const pos = Math.max(0, Math.min(caret, value.length));
  const upto = value.slice(0, pos);
  const at = upto.lastIndexOf("#");
  if (at < 0) return null;

  const before = at === 0 ? "" : upto[at - 1];
  if (before !== "" && !/\s/.test(before)) return null;

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
  const pad = /^\s/.test(tail) ? "" : " ";

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
        arg: "",
        desc: h.startsWith("#") ? "room" : "peer",
      };
    });

  return items.length
    ? { items, index: 0, kind: "mention", typed: `#${token.query}` }
    : null;
}

/** A room's own "#" is part of its name; the trigger "#" is not. */
function bareName(handle) {
  return handle.replace(/^#/, "");
}

/** The CLI's ring size, mirrored so both surfaces forget at the same point. */
export const HISTORY_CAP = 100;

/** @typedef {{ entries: string[], index: number | null, draft: string | null }} History */

/** Consecutive duplicates collapse, because sending the same line twice is
 *  one thing to recall, not two. */
export function pushHistory(entries, line, cap = HISTORY_CAP) {
  const trimmed = line.trim();
  if (!trimmed) return entries;

  const next =
    entries[entries.length - 1] === trimmed ? entries : [...entries, trimmed];

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
  if (index >= entries.length - 1)
    return { index: null, draft: null, value: draft ?? "" };

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
    ? !value.slice(0, pos).includes("\n")
    : !value.slice(pos).includes("\n");
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
export function messageMarkdown(
  { from, time, body },
  { attributed = false } = {},
) {
  // Plain copy is byte-exact on purpose: it is what the sender typed.
  if (!attributed) return body;

  return `**${from}** · ${time}\n\n${body.trimEnd()}`;
}

/**
 * `<prefix>name <arg>`, with the space dropped when a command takes no
 * argument.
 *
 * 🛑 THE DEFAULT PREFIX IS WHAT KEEPS `/help` AND `/cheat-sheet` UNCHANGED.
 * Both reach this through `commandBlock`, and both describe slash commands.
 * `commandRows` passes a per-table prefix instead, because a CLI row is
 * pasted into a terminal verbatim and a leading slash makes it unrunnable.
 */
export function commandUsage(command, prefix = "/") {
  return `${prefix}${command.name} ${command.arg}`.trimEnd();
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
export function commandBlock(
  commands,
  labels,
  { width, headingIndent = "  " } = {},
) {
  const w = width ?? dashColumn(commands.map((c) => commandUsage(c)));

  return Object.keys(labels)
    .map((cat) => {
      const rows = commands
        .filter((c) => c.cat === cat)
        .map((c) => "  " + commandUsage(c).padEnd(w) + `— ${c.desc}`);

      return rows.length
        ? [`${headingIndent}${labels[cat]}`, ...rows].join("\n")
        : null;
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * The same command table as `commandBlock`, but as DATA rather than a padded
 * string, so a surface can hang a control off each row.
 *
 * 🛑 `/help` AND `/cheat-sheet` CANNOT CARRY A BUTTON. Both render into a
 * single `<pre>`, and text has nowhere to put a click target. That is the
 * whole reason this builder exists beside `commandBlock` rather than
 * replacing it.
 *
 * 🛑 `usage` AND `copy` ARE DIFFERENT STRINGS ON PURPOSE. The row must SHOW
 * `/dm <peer>` so the reader knows an argument is wanted, and must COPY `/dm`
 * so a paste is sendable. A clipboard carrying `<peer>` is invisible until
 * someone pastes it and sends.
 *
 * A category with no commands is dropped. An empty heading and a heading
 * whose rows failed to build look identical on screen.
 *
 * @param {{ name: string, arg: string, desc: string, cat: string }[]} commands
 * @param {Record<string, string>} labels category key -> heading
 */
export function commandRows(commands, labels, prefixes) {
  // flatMap, not map-then-filter: dropping an empty category with
  // `.filter(Boolean)` widens the return type to include null, and every
  // caller then has to narrow a value this builder never emits.
  return Object.keys(labels).flatMap((cat) => {
    const inCat = commands.filter((c) => c.cat === cat);
    if (!inCat.length) return [];

    const prefix = prefixes[cat];
    // 🛑 THE SEPARATOR IS DATA, NOT FORMATTING. `cli: "chat-mcp"` renders AND
    // copies `chat-mcpsend`. It is a string, so a typeof check passes it and
    // nothing on screen reads as wrong.
    // The rule is "does not END IN A WORD CHARACTER", not "ends in a space":
    // `/` separates itself, `chat-mcp ` needs the space, and `` is the MCP
    // case, where a tool is named rather than typed.
    if (typeof prefix !== "string") {
      const known = Object.keys(prefixes).join(", ") || "(none)";
      throw new Error(
        `commandRows: category "${cat}" has no prefix. Known: ${known}`,
      );
    }
    if (/\w$/.test(prefix)) {
      throw new Error(
        `commandRows: prefix "${prefix}" for "${cat}" runs into the command name; it needs a trailing space`,
      );
    }

    return [
      {
        cat,
        heading: labels[cat],
        rows: inCat.map((c) => ({
          usage: commandUsage(c, prefix),
          desc: c.desc,
          // Same builder, argument dropped. The two strings differ by exactly
          // the placeholder, and a second concatenation here is what drifts.
          copy: commandUsage({ ...c, arg: "" }, prefix),
        })),
      },
    ];
  });
}

/** Gestures, as data, so one measurement can cover them and the commands. */
const GESTURE_SECTIONS = [
  [
    "COMPOSER",
    [
      ["Enter", "send"],
      ["Shift-Enter", "newline, without sending"],
      ["#", "complete a peer or room name"],
      ["Tab or Enter", "accept the highlighted completion"],
      ["Up / Down", "move through the completion list"],
      ["Esc", "dismiss the completion list"],
      ["Up / Down", "with no list open, step through lines you sent"],
      ["drop a file on the window", "insert its path at the caret"],
      { cont: 'relative to the project folder, "~/" under home', pad: 2 },
    ],
  ],
  [
    "MESSAGES",
    [
      ["click the copy icon", "copy the message markdown as typed"],
      ["Shift-click it", "copy it under the author and the time"],
    ],
  ],
  [
    "SIDEBAR",
    [
      ["click a row", "open that peer or room"],
      ["(3) beside a row", "unread messages waiting there"],
      ["... on a peer", "Dispatch, Alert, Copy handle, Kick"],
      ["... on a room", "Broadcast, Alert, Copy name, Leave, Delete"],
      ['an entry ending "..."', "opens in the composer, sends nothing"],
      ["the entry below the rule", "destructive, and asks first"],
    ],
  ],
  [
    "READING",
    [
      ["End", "jump to the newest message"],
      { cont: "only while the composer is empty, because End", pad: 0 },
      { cont: "otherwise moves the caret", pad: 0 },
      ["the jump badge", "appears when messages arrive below the view"],
    ],
  ],
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
    rows.filter(Array.isArray).map(([label]) => label),
  );
  const width = dashColumn([
    ...commands.map((c) => commandUsage(c)),
    ...gestureLabels,
  ]);

  const gestures = GESTURE_SECTIONS.flatMap(([heading, rows]) => [
    heading,
    ...rows.map((row) =>
      Array.isArray(row)
        ? "  " + row[0].padEnd(width) + `— ${row[1]}`
        : "  " + " ".repeat(width + 2 + row.pad) + row.cont,
    ),
    "",
  ]);

  return [
    "CHEAT SHEET",
    "",
    "SLASH COMMANDS",
    commandBlock(commands, labels, { width }),
    "",
    ...gestures,
    "This sheet is not saved. It disappears when you switch away.",
  ].join("\n");
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
  if (value.startsWith("/") && !value.includes("\n")) return null;

  const pos = Math.max(0, Math.min(caret, value.length));
  const upto = value.slice(0, pos);
  const at = upto.lastIndexOf("@");
  if (at < 0) return null;

  const before = at === 0 ? "" : upto[at - 1];
  if (before !== "" && !/\s/.test(before)) return null;

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
    if (!head.includes("/")) return null;
    if (!/^[ \t]*$/.test(value.slice(end, pos).replace(PATH_BODY_RUN, " ")))
      return null;

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
    const dir = hint.kind === "dir";
    const pad = dir || /^\s/.test(tail) ? "" : " ";
    const head = value.slice(0, token.start) + hint.value + pad;

    // 🛑 reopen is EXPLICIT, not sniffed from a trailing space. A directory
    // inserts no space, so acceptReopens would close the list and the
    // drill-down would stop at the first level.
    return {
      insert: head + tail,
      caret: head.length,
      name: hint.value,
      arg: "",
      desc: hint.kind,
      reopen: dir,
    };
  });

  return { items, index: 0, kind: "path", typed: `@${token.query}` };
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
  return (
    (uriList || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      // 🛑 NO SEPARATE "#" COMMENT FILTER. RFC 2483 says a line opening with
      // "#" is a comment, and one is unreachable here: a line cannot both open
      // with "#" and open with "file://". A filter for it was written, could
      // not be killed by any mutant, and was removed rather than kept as a
      // guard that cannot fire.
      .filter((line) => line.toLowerCase().startsWith("file://"))
      .map(pathFromFileUri)
      .filter((path) => path !== null)
  );
}

/**
 * `file:///a/b` and `file://localhost/a/b` both mean `/a/b`.
 *
 * ⚠️ A HOST THAT IS NOT THIS MACHINE IS REFUSED. `file://server/share` is a
 * remote path and inserting it as a local one would be a lie.
 */
function pathFromFileUri(uri) {
  const rest = uri.slice("file://".length);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;

  const host = rest.slice(0, slash);
  if (host !== "" && host.toLowerCase() !== "localhost") return null;

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
  if (underCwd !== null) return underCwd === "" ? "." : underCwd;

  const underHome = relativeTo(abs, home);
  if (underHome !== null) return underHome === "" ? "~" : `~/${underHome}`;

  return abs;
}

/** The part of `abs` below `root`, or null when it is not under it. */
function relativeTo(abs, root) {
  if (!root) return null;
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  if (abs === base) return "";
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
    .map((name) =>
      /\s|"/.test(name) ? `"${name.replace(/"/g, '\\"')}"` : name,
    )
    .join(" ");
}

export function dropInsertText(paths, roots) {
  return paths.map((p) => droppedPathValue(p, roots)).join(" ");
}

// ── /clear ───────────────────────────────────────────────────────────────

/** A `#` prefix is the only thing separating a room target from a DM peer. */
const isRoomTarget = (target) => target.startsWith("#");

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
    return (
      `Clear ${target}?\n\n` +
      `Every message ever sent to ${target} is deleted for EVERYONE, not ` +
      "just you, and every member's unread mark resets. The room and its " +
      "memberships stay. This cannot be undone."
    );
  }
  return (
    `Clear your conversation with ${target}?\n\n` +
    `Every message between you and ${target} is deleted, in both ` +
    "directions, for BOTH of you. This cannot be undone."
  );
}

/**
 * Zero is a SUCCESS. The DAO returns a row count, so it cannot tell an empty
 * room from a missing one — and the route answers 403 before a missing room
 * could ever reach here.
 */
export function clearResultText(count, target) {
  const where = isRoomTarget(target) ? `from ${target}` : `with ${target}`;
  if (count === 0) return `${target} was already empty`;
  return `cleared ${count} message${count === 1 ? "" : "s"} ${where}`;
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
  if (chosen === "custom") {
    return { action: "edit", revertTo: currentStyle ?? "" };
  }

  return { action: "save", style: chosen === "" ? null : chosen };
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
  return style === "custom";
}

export const STYLE_CUSTOM_MAX_BYTES = 65536;

/**
 * Whether the markdown in the editor can be saved, and why not when it cannot.
 *
 * Mirrors the server's own guard so the operator hears about an empty or
 * oversized style before a round trip, not after a 400.
 *
 * @param {string | null | undefined} markdown
 * @returns {{ ok: true, style: "custom", custom: string } | { ok: false, error: string }}
 */
export function customStyleSubmission(markdown) {
  const text = (markdown ?? "").trim();

  if (text === "") {
    return { ok: false, error: "A custom style needs some markdown." };
  }

  // The server measures BYTES, not characters, so a style of emoji or accented
  // text is larger than its length suggests.
  const bytes = new TextEncoder().encode(text).length;

  if (bytes > STYLE_CUSTOM_MAX_BYTES) {
    return {
      ok: false,
      error: `Too long: ${bytes} bytes, the cap is ${STYLE_CUSTOM_MAX_BYTES}.`,
    };
  }

  return { ok: true, style: "custom", custom: text };
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
 * `context_ramp` arrives the same way, for the same reason: `rampFor` owns
 * lee's fractions and a copy of them here would be free to drift from the
 * ones the restart measures against.
 *
 * @param {{context_used?: number|null, context_total?: number|null, fresh?: boolean, age_ms?: number|null, context_ramp?: number[]|null, reports_context?: boolean|null}} peer
 * @returns {{show: boolean, percent: number|null, band: string, title: string}}
 */
/**
 * Which ramp band a fill has reached, as a class suffix.
 *
 * 🛑 THE TICKS ARE RELATIVE TO THE HANDLE'S GATE, NEVER ABSOLUTE. The previous
 * cut coloured at a hardcoded 70/85/95. A handle gated at 50 is restarted
 * before it can reach 70, so two of those three were unreachable and the third
 * was the restart itself — the ramp rendered nothing on the default gate.
 *
 * 🛑 NO HYSTERESIS. lee ruled "A-Stateless" on 2026-11-18, against a reading of
 * "up to reset threshold" that would have kept the colour until the fill fell
 * below a reset point. `gauge.ts` BANDS do carry resets; those exist to stop
 * NOTIFICATION chatter, and a colour has none to stop.
 *
 * 🛑 COMPARED AT ONE DECIMAL, BECAUSE `contextPercent` IS ONE DECIMAL AND THE
 * SUPERVISOR'S RESTART BANDS AGAINST THAT NUMBER. Full precision here and one
 * decimal there disagree on the tick itself: 49920 of 200000 is 24.96 raw and
 * 25.0 rounded, so a gate of 50 fired band 1 while this gauge stayed default.
 * The rounded INTEGER is wrong in the other direction — a tick carries one
 * decimal, so an integer crosses it up to half a point early.
 *
 * ⚠️ NO RAMP MEANS NO COLOUR, AND THE GUARD FOR THAT IS UPSTREAM. Deriving a
 * gate here would put a second home for lee's default beside
 * `DEFAULT_CONTEXT_GATE`. That the payload always carries one is asserted by
 * `test/web/whoami-ramp.test.ts`.
 */
function rampBand(percentTenths, ramp) {
  if (!Array.isArray(ramp)) return "ok";

  let band = "ok";
  ramp.forEach((tick, i) => {
    if (typeof tick === "number" && percentTenths >= tick)
      band = `ramp${i + 1}`;
  });

  return band;
}

export function gaugeDisplay(peer) {
  const used = peer?.context_used;
  const total = peer?.context_total;
  const reported = used != null && total != null && total > 0;

  if (!reported) {
    // 🛑 TWO CAUSES, AND AN OPERATOR NEEDS OPPOSITE RESPONSES TO THEM (#371).
    // A vendor that reports no window will never fill this in, so waiting for
    // it is wasted. A vendor that does report one has simply not reported yet,
    // and that resolves itself. `reports_context === false` is the only value
    // that distinguishes them — `null` means the handle has no registration,
    // so the vendor is unknown and the older blank is the honest answer.
    if (peer?.reports_context === false) {
      return {
        show: true,
        percent: null,
        band: "unreported",
        title:
          "This agent's CLI reports no context window, so no percentage is possible",
      };
    }

    return {
      show: false,
      percent: null,
      band: "none",
      title: "Context usage not reported",
    };
  }

  if (peer.fresh !== true) {
    return {
      show: true,
      percent: null,
      band: "stale",
      title: `Context usage is ${ageLabel(peer.age_ms)} old — the agent has stopped reporting`,
    };
  }

  // ⚠️ TWO NUMBERS ON PURPOSE, AND ROUNDING `percent` FROM `tenths` WOULD BE
  // WRONG. 24.45 is 24.5 at one decimal and 25 after a second round, where the
  // raw fill rounds to 24. The label keeps its own rule; only the BAND has to
  // agree with the supervisor.
  const percent = Math.round((used / total) * 100);
  const tenths = Math.round((used / total) * 1000) / 10;

  return {
    show: true,
    percent,
    band: rampBand(tenths, peer.context_ramp),
    title: `Context ${percent}% — ${used.toLocaleString()} of ${total.toLocaleString()} tokens`,
  };
}

/**
 * Turn what the operator typed into a gate, a clear, or a refusal (#135 unit 4).
 *
 * An EMPTY box is a CLEAR, not a zero. `setHandleContextGate(…, null)` returns
 * a handle to the global default, and that is the only way to undo an override,
 * so the control needs a spelling for it.
 *
 * 🛑 THE FOUR REFUSAL CLAUSES MATCH `isLegalGate` IN
 * `src/storage/context-gate.ts`, CLAUSE FOR CLAUSE. This is a second copy of
 * that rule and it exists only to answer the operator before a round trip —
 * the route refuses the same shapes, and a test asserts the stored value did
 * not move. If one side changes, both must.
 *
 * 🛑 `scope` EXISTS BECAUSE THE EMPTY BOX MEANS TWO DIFFERENT THINGS. Clearing
 * a HANDLE returns it to the global default. The global has no layer below it,
 * so `handleContextGateSet` answers 400 — and a validator whose job is to
 * answer before a round trip must not wave through the one shape that is
 * guaranteed to fail.
 */
export function gateSubmission(raw, { scope = "handle" } = {}) {
  const text = String(raw ?? "").trim();

  if (text === "") {
    return scope === "global"
      ? {
          ok: false,
          reason:
            "the default gate cannot be cleared; every agent without an " +
            "override of its own resolves it",
        }
      : { ok: true, gate: null };
  }

  if (!/^\d+$/.test(text)) {
    return {
      ok: false,
      reason: /^-?\d*\.\d+$/.test(text)
        ? "a gate must be a whole percentage, not a fraction"
        : "a gate must be a number from 1 to 100",
    };
  }

  const gate = Number(text);

  if (gate < 1 || gate > 100) {
    return { ok: false, reason: "a gate must be from 1 to 100" };
  }

  return { ok: true, gate };
}

/** How close a gate sits to the fill the peer is already reporting. */
const SOON_MARGIN = 5;

/**
 * What a gate will do to a peer that is already at `fillPercent`, or null when
 * there is nothing worth saying.
 *
 * 🛑 THE BROWSER CANNOT SEE THE SPAWN FLOOR, SO THIS USES CURRENT FILL. The
 * supervisor compares a gate against `childFloor`, a local in its own process
 * that reaches no table. Current fill is always at or above that floor, so a
 * gate under current fill may fire at once OR silence the child permanently,
 * and this cannot tell those apart. The `silent` copy names the worse one
 * because it is the one an operator would not predict.
 *
 * ⚠️ `>=`, NOT `>`. A gate exactly equal to the floor silences the child —
 * `checkContextGate` tests `childFloor >= gate`. Proven by "a gate under the
 * child's spawn fill does NOT restart it, and says why".
 *
 * ⚠️ A NULL GATE IS A CLEAR, NOT A ZERO, SO IT WARNS NOTHING. `null <= fill`
 * is true, which put the clear in the `silent` branch and said the opposite of
 * what a clear does. Proven by "a cleared gate warns nothing, because falling
 * back to the global default still restarts".
 */
export function gateRisk(gate, fillPercent) {
  if (!Number.isFinite(gate) || !Number.isFinite(fillPercent)) {
    return null;
  }

  if (gate <= fillPercent) {
    return {
      severity: "silent",
      message:
        `this agent already reports ${fillPercent}% — a gate at or below its ` +
        `spawn fill means nothing will restart it, and the supervisor says so once`,
    };
  }

  if (gate - fillPercent <= SOON_MARGIN) {
    return {
      severity: "soon",
      message: `this agent is at ${fillPercent}%, so a gate of ${gate}% fires within a few turns`,
    };
  }

  return null;
}

/**
 * How each of the three layers reads to an operator (#135 slice 4c).
 *
 * 🛑 "this agent" IS LOAD-BEARING, NOT DECORATION. It is the only word that
 * distinguishes the one state where `[Clear]` does something, and a test
 * asserts the two inherited layers do NOT carry it.
 */
const GATE_LAYER_LABEL = {
  override: "set for this agent",
  global: "from the default",
  builtin: "built-in default",
};

/**
 * One gate control's rendered state — the label, whether a clear is offered,
 * and the risk note (#135 slice 4c).
 *
 * 🛑 THE NUMBER ALONE CANNOT SAY WHETHER `[Clear]` DOES ANYTHING. A row
 * showing 50 may be overridden to 50, following a global 50, or on the
 * built-in. Only `source` separates them, and only the first has an override
 * to remove — so offering a clear on the other two is a button that reports
 * success and changes nothing.
 *
 * 🛑 THE GLOBAL SCOPE CARRIES NO RISK NOTE. `gateRisk` is keyed on ONE agent's
 * fill, and every agent resolves the default against its own, so a warning
 * there would name a number belonging to nobody. It also never offers a clear:
 * there is no layer below the global, which is the same rule
 * `gateSubmission(…, { scope: "global" })` enforces on the empty box.
 *
 * @param {{ gate?: number, source?: string }} [resolved]
 * @param {{ scope?: string, fillPercent?: number | null }} [opts]
 */
export function gateControlDisplay(
  { gate, source } = {},
  { scope = "handle", fillPercent = null } = {},
) {
  const global = scope === "global";
  const layer = GATE_LAYER_LABEL[source] ?? GATE_LAYER_LABEL.builtin;

  return {
    gate,
    label: global
      ? `Default gate ${gate}%${source === "builtin" ? " \u00b7 built-in" : ""}`
      : `Gate ${gate}% \u00b7 ${layer}`,
    canClear: !global && source === "override",
    risk: global ? null : gateRisk(gate, fillPercent),
  };
}

/** A duration a human reads at a glance. Exported for its own test. */
export function ageLabel(ms) {
  if (ms == null) return "never reported";

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
  return "(nothing claimed)";
}

/**
 * One row of the running-agents panel (#40).
 *
 * 🛑 TWO HANDLES ON ONE ROW. `label` is what a human reads and messages, which
 * is the CHILD; `handle` is the supervisor and is the only thing
 * `/api/agents/stop` accepts. Collapsing them to one field is how a stop comes
 * to answer a tested, honest-looking `ok: false`.
 *
 * 🛑 NO SOCKET AGE. `bound Nm` was the supervisor's socket age sitting beside
 * the child's handle, and lee read it as the agent's run time — which it never
 * was. He ruled it out on 2026-11-21 rather than relabelled, because an
 * operator acts on no part of it (#374).
 *
 * ⚠️ `defaultStopMode` IS OPTIONAL IN THE TYPE ON PURPOSE. A response from a
 * server older than #415 slice 2 carries no such field, which is exactly the
 * case the `?? "graceful"` below handles — so the TYPE has to admit what the
 * CODE already handles, or the fallback reads as dead.
 *
 * @param {{handle: string, defaultStopMode?: string|null, child?: object|null}} agent
 */
export function agentRow(agent) {
  return {
    handle: agent.handle,
    childHandle: agent.child?.handle ?? null,
    // 🛑 FALLS BACK TO THE SUPERVISOR, because a supervisor binds its socket
    // before its child's first bus touch. Without the fallback a just-spawned
    // agent renders as a nameless row for that window.
    label: agent.child?.handle ?? agent.handle,
    gauge: gaugeDisplay(agent.child),
    // #135 slice 4c — the CHILD's gate, resolved server-side. Null with no
    // child: there is no agent to gate, and inventing a number here would put
    // a second copy of the three-layer default in the browser.
    gate: agent.child?.context_gate ?? null,
    gateSource: agent.child?.context_gate_source ?? null,
    // #415 slice 2 — the SUPERVISOR's vendor decides this, and the stop posts
    // the supervisor, so it sits beside `handle` rather than under `child`.
    // Absent on a response older than this slice, where `graceful` is what
    // that server would itself have used.
    defaultStopMode: agent.defaultStopMode ?? "graceful",
  };
}

/**
 * What the threshold modal needs for one handle, from whichever row it sits on.
 *
 * 🛑 ONE LOOKUP FOR BOTH ROW TYPES. An agent row's gate lives under
 * `state.agents[].child` and a peer row's lives on `state.peers[]` directly,
 * but the SERVER writes both through `gateFields()`, so the field names agree.
 * Two call sites reading two shapes is how they drift.
 *
 * 🛑 AGENTS ARE SEARCHED FIRST, AND THAT ORDER IS LOAD-BEARING. A supervised
 * child is filtered OUT of the peers section but is still present in
 * `state.peers`, so a handle that is both must resolve as the agent row the
 * operator clicked.
 *
 * ⚠️ `fillPercent` IS `gaugeDisplay().percent`, WHICH IS NULL WHENEVER THE
 * GAUGE CANNOT SHOW A NUMBER — a vendor that reports no window returns
 * `show: true` with a null percent, so reading `percent` alone is not a
 * shortcut past the `show` flag.
 *
 * ⚠️ `null` IS IN THE TYPE ON PURPOSE. `state.agents` and `state.peers` are
 * both initialised before the first fetch and a failed fetch leaves them as
 * they were, but a caller passing a half-built state object is exactly the
 * case the `Array.isArray` guards below exist for — so the TYPE has to admit
 * what the CODE already handles, or the guard reads as dead.
 *
 * @param {string} handle
 * @param {{ agents?: unknown[] | null, peers?: unknown[] | null }} [state]
 */
export function gateTargetFor(handle, { agents = [], peers = [] } = {}) {
  const fromAgent = (Array.isArray(agents) ? agents : [])
    .map((a) => a?.child)
    .find((c) => c?.handle === handle);

  const row =
    fromAgent ??
    (Array.isArray(peers) ? peers : []).find((p) => p?.handle === handle);

  if (row === undefined || row === null) return null;

  return {
    gate: row.context_gate ?? null,
    source: row.context_gate_source ?? null,
    fillPercent: gaugeDisplay(row).percent,
  };
}

/**
 * Every handle that is the CHILD of a live supervisor.
 *
 * 🛑 CHILDREN ONLY, NEVER THE SUPERVISOR HANDLE. A supervisor never registers
 * on the bus, so including it would be a filter key that matches nothing today
 * and silently starts matching a real peer the day one does register.
 */
export function supervisedChildHandles(agents) {
  if (!Array.isArray(agents)) return [];

  return agents
    .map((agent) => agent?.child?.handle)
    .filter((handle) => typeof handle === "string");
}

/**
 * Whether a supervised child is answering on the bus right now (#374).
 *
 * 🛑 THE AGENT ROW MUST NOT HARDCODE THIS. A running SUPERVISOR is not a
 * connected CHILD: `cursorSpawn.processPerTurn` is true, so a Cursor handle is
 * genuinely offline between turns while its supervisor stays up. A row that is
 * always green is exactly what lee ruled against — a peer row's dot tells the
 * truth, and this one has to as well.
 *
 * ⚠️ ABSENT READS AS OFFLINE, which is what a peers row does for a handle it
 * cannot find. `fresh` on the child is NOT the substitute: `agentsWithoutClock`
 * strips it from the signature, so the dot would move with nothing announcing
 * it to the planner.
 */
export function childOnline(peers, childHandle) {
  if (!Array.isArray(peers) || typeof childHandle !== "string") return false;

  return peers.some(
    (peer) => peer?.handle === childHandle && peer?.online === true,
  );
}

/**
 * The peers list with supervised children removed (#374).
 *
 * 🛑 THE CHILD IS A REAL PEER, WHICH IS WHY IT WAS DRAWN TWICE. `listAgents`
 * returns it like any other registration, so the Peers section drew a second
 * row for an agent the Agents section had already drawn — under a different
 * handle, with nothing on screen saying they were one agent.
 *
 * ⚠️ THE AGENTS ROW IS THE ONE THAT SURVIVES, not the peer row. Only it can
 * carry Stop, Stop now and the #135 context gate.
 */
export function peersMinusSupervised(peers, agents) {
  if (!Array.isArray(peers)) return peers;

  const supervised = new Set(supervisedChildHandles(agents));

  return peers.filter((peer) => !supervised.has(peer?.handle));
}

/**
 * What the running-agents panel says when nothing is running.
 *
 * 🛑 NOT A BLANK, for the same reason as the claims panel.
 */
export function agentsPanelEmpty() {
  return "(no supervised agents running)";
}

/**
 * The confirm an operator reads before a stop (#40).
 *
 * 🛑 BOTH OUTCOMES, UNCONDITIONALLY. Nothing in the browser can tell
 * whether a turn is running, so neither branch may assert that one is. lee
 * ruled this over a server-reported in-flight field on 2026-11-23 (#415).
 *
 * ⚠️ REJECTED: branch on `processPerTurn`. It says a turn COULD be absent,
 * never that one IS.
 *
 * ⚠️ REJECTED: "exits immediately". The containerized driver awaits
 * `dockerTeardownFor`, so the wait is up to the grace window plus 5s.
 */
export function stopConfirmText(handle, mode) {
  return mode === "now"
    ? `Stop ${handle} NOW?\n\n` +
        "If a turn is running, it is cut mid-stream and the tokens it has " +
        "already spent produce nothing.\n" +
        "If none is running, nothing is spent.\n" +
        "Either way the supervisor does not wait for a turn to end."
    : `Stop ${handle}?\n\n` +
        "If a turn is running, it finishes first.\n" +
        "If none is running, this starts one and bills it.\n" +
        "Either way the supervisor then exits.";
}

/**
 * What to tell the operator after a stop (#40).
 *
 * 🛑 BRANCHES ON `reason`, NEVER ON `error`. `reason` is a discriminant;
 * `error` is prose and free to be reworded, which is the drift PR 298 fixed
 * in the CLI.
 *
 * ⚠️ FAILURES LEAD. A mixed result read as "stopped 2" is how an operator
 * walks away from an agent that is still running.
 *
 * @param {Array<{handle: string, ok: boolean, reason?: string, error?: string,
 *   graceSeconds?: number}>} results
 * @returns {{kind: "info"|"error", text: string}}
 */
export function stopOutcomeText(results) {
  // 🛑 AN EMPTY SET IS NOT A SUCCESS. "stopped 0 agents" reads as a stop that
  // worked; nothing was running.
  if (results.length === 0) {
    return { kind: "info", text: "nothing was running" };
  }

  const failed = results.filter((r) => !r.ok);
  const stopped = results.length - failed.length;

  if (failed.length === 0) {
    if (results.length > 1) {
      return { kind: "info", text: `stopped ${results.length} agents` };
    }

    const [only] = results;

    // A grace window means the agent is not gone yet, so the verb changes.
    return {
      kind: "info",
      text:
        only.graceSeconds === undefined
          ? `stopped ${only.handle}`
          : `stopping ${only.handle} — ${only.graceSeconds}s grace`,
    };
  }

  const named = failed
    .map((r) => `${r.handle} ${r.reason ?? "failed for no stated reason"}`)
    .join(", ");

  return {
    kind: "error",
    text:
      stopped === 0
        ? `not stopped — ${named}`
        : `${named} · stopped ${stopped} of ${results.length}`,
  };
}

/**
 * The class a stop button wears (#40).
 *
 * 🛑 ONLY THE CUT-MID-STREAM ONE IS COLOURED. Both buttons of a pair in the
 * danger colour would say the graceful stop costs what the immediate one
 * costs, and there are two pairs now.
 *
 * @param {"graceful"|"now"} mode
 */
export function stopButtonClass(mode) {
  return mode === "now" ? "agent__stop is-destructive" : "agent__stop";
}

/**
 * The row's two stop buttons, DEFAULT FIRST (#415).
 *
 * 🛑 THE ORDER IS THE WHOLE MECHANISM. lee ruled on 2026-11-24 that a per-turn
 * vendor defaults to `now`, and an operator only feels that ruling if the
 * cheaper stop is the button their hand lands on first.
 *
 * 🛑 READS A DECISION, NOT A CAPABILITY. `defaultStopMode` arrives already
 * resolved from the server's `defaultStopModeFor`, so no vendor map is
 * hand-typed here and nothing in the browser can drift from the adapters.
 *
 * ⚠️ ANYTHING OTHER THAN `now` KEEPS THE SHIPPED ORDER. A cached page or a
 * server older than this slice sends no field at all, and making an immediate
 * kill the default on a missing value is the larger claim.
 *
 * @param {string|null|undefined} defaultMode
 */
export function stopButtonOrder(defaultMode) {
  const graceful = { label: "Stop", mode: "graceful" };
  const immediate = { label: "Stop now", mode: "now" };

  return defaultMode === "now" ? [immediate, graceful] : [graceful, immediate];
}

/**
 * Whether the Stop all sweep is offered at all (#40).
 *
 * 🛑 NOT OFFERED FOR ONE AGENT. That row's own Stop already stops it, so a
 * sweep beside it would be a second control for the same outcome.
 *
 * @param {number} count
 */
export function stopAllVisible(count) {
  return count > 1;
}

/**
 * The confirm an operator reads before a sweep (#40).
 *
 * 🛑 THE COUNT IS WHAT THE PANEL SHOWS, NOT A PROMISE. The route enumerates
 * live sockets when it runs, so a supervisor that bound or exited since the
 * last poll joins or leaves the sweep regardless of this number.
 *
 * 🛑 BOTH OUTCOMES, UNCONDITIONALLY, for the same reason as
 * `stopConfirmText` — and a sweep cannot know it for any single agent either.
 *
 * @param {number} count
 * @param {"graceful"|"now"} mode
 */
export function stopAllConfirmText(count, mode) {
  const shown =
    `The panel shows ${count} agent${count === 1 ? "" : "s"}, and the ` +
    "sweep stops whatever is answering when it runs.";

  return mode === "now"
    ? `Stop all agents NOW?\n\n${shown}\n\n` +
        "Any turn in flight is cut mid-stream and its spent tokens produce " +
        "nothing.\n" +
        "An idle agent spends nothing.\n" +
        "Either way no supervisor waits for a turn to end."
    : `Stop all agents?\n\n${shown}\n\n` +
        "Each one with a turn running finishes it first.\n" +
        "Each one idle starts a turn and bills it.\n" +
        "Either way each supervisor then exits.";
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
  if (total <= 0) return "";
  if (index < 0) return `${total} match${total === 1 ? "" : "es"}`;

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
 * @param {string | null | undefined} hash  `location.hash`, with or without
 *   the leading #. Absent when nothing has set a fragment.
 * @returns {number|null}
 */
export function messageIdFromHash(hash) {
  const m = /^#?m([0-9]+)$/.exec(hash ?? "");

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
  const needle = (term || "").trim().toLowerCase();
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
  return matchRanges(body || "", term).length > 0;
}

/** What the message pane says when a filter hides everything. */
/**
 * The request that reaches past the loaded window (#447).
 *
 * 🛑 NULL ON A BLANK TERM, BECAUSE THE SERVER REFUSES ONE. `/api/search`
 * answers 400 on an empty `q` on purpose — a blank pattern matches every row,
 * and the whole transcript is indistinguishable from a search that worked. So
 * the caller must not fire at all rather than handle a 400 per keystroke.
 *
 * 🛑 `encodeURIComponent`, NOT A TEMPLATE JOIN. A term is operator input and
 * `&limit=1` inside it would otherwise become a second parameter.
 *
 * A null target is OMITTED rather than sent blank: `parseSearch` treats an
 * empty `target` as absent, but sending one states a scope that is not there.
 */
export function searchRequestUrl(term, target, limit) {
  const q = (term ?? "").trim();
  if (q.length === 0) return null;

  const parts = [`q=${encodeURIComponent(q)}`];
  if (target) parts.push(`target=${encodeURIComponent(target)}`);
  parts.push(`limit=${encodeURIComponent(String(limit))}`);

  return `/api/search?${parts.join("&")}`;
}

/**
 * The server hits worth offering: the ones not already on screen (#447).
 *
 * 🛑 "EARLIER IN THIS CONVERSATION" HAS TO BE TRUE. A hit whose id is in the
 * loaded window is not earlier, it is in view, so counting it would make the
 * label lie about where the message is.
 *
 * ⚠️ THIS ALSO HIDES A LOADED ROW THE LOCAL FILTER REJECTED, and that is
 * deliberate. The two match rules differ — `searchableText` reads rendered text
 * plus hrefs while the server reads the raw body — so a markdown-only hit can
 * match remotely and not locally. Dropping it restores the old behaviour for
 * that row, which beats pointing the operator somewhere it is not.
 *
 * 🛑 `loadedIds` IS THE LOADED WINDOW, NEVER THE FILTERED ROWS. The first cut
 * passed `state.renderedIds`, which holds what the filter PRODUCED — so a
 * loaded row the local filter rejected was absent from it, survived this
 * filter, and got counted as off-screen while sitting in view. That is the
 * exact case the paragraph above says it hides. Found answering claude2's
 * question on PR 453, which is why the wiring test pins the argument.
 */
export function remoteOnlyHits(hits, loadedIds) {
  const loaded = new Set(loadedIds);
  return hits.filter((h) => !loaded.has(h.id));
}

/**
 * The one line that says how much is out of reach (#447).
 *
 * 🛑 A CAPPED LIST STILL SPEAKS AT ZERO. `truncated` describes the list the
 * SERVER capped; `count` describes what survived dropping the hits already on
 * screen. A term with more matches than the fetch limit, every one of them in
 * view, therefore emptied `count` while `truncated` stayed true — and
 * returning null there rendered exactly like "there is nothing more", the one
 * answer #447 exists to stop giving. Raised by claude2 on PR 453 and
 * reproduced against this function before it was believed.
 *
 * 🛑 NULL ONLY WHEN THE LIST WAS NEITHER CAPPED NOR LEFT WITH ANYTHING. That
 * is the single case where silence is true.
 *
 * 🛑 IT NEVER SAYS "EARLIER", AND THE FIRST CUT DID. `openHashTarget` replaces
 * the loaded window with one AROUND an anchor, so a hit outside that window
 * can be NEWER than everything in view. The direction is not provable from
 * what the client holds, so the label does not claim one.
 *
 * 🛑 THE `+` IS LOAD-BEARING. `returned === limit` cannot tell an exact count
 * from a cap, which is why the server sends `truncated` beside it — see
 * `handleSearch`. Reporting a capped list as a total understates the history.
 */
export function remoteHitsLabel(count, truncated) {
  if (count <= 0)
    return truncated
      ? "more matches in this conversation than shown here"
      : null;

  const n = truncated ? `${count}+` : `${count}`;
  const noun = count === 1 && !truncated ? "match" : "matches";

  return `${n} more ${noun} in this conversation`;
}

export function searchFilterEmpty(term, scanned) {
  return `no match for "${term}" in ${scanned} loaded message${scanned === 1 ? "" : "s"}`;
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
    if (typeof href !== "string" || href.length === 0) continue;
    // 🛑 `#` IS WHAT A NEUTERED LINK RENDERS AS, not a destination. `safeUrl`
    // turns a `javascript:` or `data:` target into `#`, and appending that made
    // the term "#" match every message holding a dead link. Found by claude1.
    if (href === "#") continue;
    // A bare URL is already its own label, so appending it would double it.
    if (text.includes(href)) continue;
    if (extra.includes(href)) continue;
    extra.push(href);
  }

  return extra.length === 0 ? text : `${text}\n${extra.join("\n")}`;
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
  if (typeof e?.key !== "string" || e.key.toLowerCase() !== "f") return false;
  if (e.shiftKey || e.altKey) return false;

  return isMac
    ? e.metaKey === true && e.ctrlKey !== true
    : e.ctrlKey === true && e.metaKey !== true;
}

/**
 * The filter box's placeholder, naming the shortcut that reaches it.
 *
 * 🛑 THE COMBO CANNOT LIVE IN THE HTML, because it differs per platform and the
 * markup is served to both. The static attribute is the no-JS fallback and this
 * overwrites it at boot.
 *
 * ⚠️ READS THE SAME `isMac` AS `focusSearchKeyApplies`. A second platform test
 * here could disagree with the binding, and then the box would advertise a key
 * that does nothing.
 *
 * @param {boolean} isMac
 */
export function searchPlaceholder(isMac) {
  return `Search (${searchCombo(isMac)})`;
}

/** The combo both labels name, so they cannot disagree with each other. */
function searchCombo(isMac) {
  return isMac ? "Cmd-F" : "Ctrl-F";
}

/**
 * The filter box's accessible name, which must ALSO name the shortcut.
 *
 * 🛑 THE PLACEHOLDER REACHES SIGHTED USERS ONLY. `aria-label` wins over
 * `placeholder` in the accessible-name computation, so with the hint in the
 * placeholder alone an assistive-tech user is never told the key exists.
 * Measured in Chromium: the accessible name was the aria-label and
 * `getByRole('searchbox', { name: 'Search (Cmd-F)' })` matched nothing.
 *
 * ⚠️ THE DESCRIPTION IS KEPT, NOT REPLACED. "Filter and highlight" is what the
 * box does, and a name trimmed to "Search" would lose the highlighting half.
 *
 * @param {boolean} isMac
 */
export function searchAriaLabel(isMac) {
  return `Filter and highlight messages in this conversation (${searchCombo(isMac)})`;
}

/**
 * The room line under the pane title: member count, then who owns it (#89).
 *
 * 🛑 `created_by` WAS WRITE-ONLY. The column has existed since rooms were
 * added and nothing read it, so no surface could say who owns a room. It
 * already reaches the client in `/api/whoami`, so this consumes a field rather
 * than adding one.
 *
 * ⚠️ THE OWNER MAY HAVE LEFT, and this does not say so. The label states who
 * created the room, which is what the column means; whether they are still
 * present is what `roomDeleteVerdict` decides, server-side, and duplicating
 * that judgement here would be free to drift from it.
 *
 * @param {{ member_count?: number, created_by?: string } | null | undefined} room
 *   `undefined` or `null` when `renderPaneHeader`'s `.find()` missed.
 */
export function roomMetaLabel(room) {
  if (room === undefined || room === null) return "";

  const members = `${room.member_count ?? "?"} members`;

  return room.created_by ? `${members} · owned by ${room.created_by}` : members;
}

// ── the activity pulse, #240 ────────────────────────────────────────────

/**
 * How long a pulse survives with no further event.
 *
 * ⚠️ IT IS A FAILSAFE, NOT THE NORMAL PATH. `onTurnEnd`, `onExit` and
 * `replaceChild` each send an `end`, so this only has to outlast a child that
 * dies without reaching any of them. A short value would re-introduce the
 * mid-turn blackout it replaced: a single long `Bash` emits no event for its
 * whole duration, so the dot would stop while the agent is working.
 */
export const PULSE_FAILSAFE_MS = 30_000;

/**
 * Read one `event: activity` frame, or decide it is not one.
 *
 * 🛑 AN EXCEPTION IN AN SSE LISTENER IS SILENT AND PERMANENT. EventSource does
 * not reconnect when a handler throws, so one malformed frame would freeze the
 * pulse for the rest of the page's life with nothing in the UI to say so.
 *
 * @param {string} raw the frame's `data:` payload
 * @returns {{handle: string, phase: 'tick'|'end'} | null}
 */
export function activityEvent(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }

  if (data === null || typeof data !== "object" || Array.isArray(data))
    return null;

  const { handle, phase } = data;

  if (typeof handle !== "string" || handle.length === 0) return null;
  // An enumerated set, mirroring server.ts's own check. A phase this file does
  // not know must not become a third state downstream.
  if (phase !== "tick" && phase !== "end") return null;

  return { handle, phase };
}

/**
 * Fold one activity event into the set of handles currently working.
 *
 * 🛑 AN UNCHANGED RESULT IS THE SAME REFERENCE, AND CALLERS RELY ON IT. A tick
 * arrives every 250ms for a whole turn and all but the first say nothing new.
 * Returning a fresh equal Set would hand the caller no way to tell, so the
 * sidebar would be rewritten four times a second to look identical.
 *
 * @param {Set<string>} prev
 * @param {{handle: string, phase: 'tick'|'end'} | null} event
 * @returns {Set<string>} `prev` itself when nothing changed
 */
export function nextPulses(prev, event) {
  if (event === null || event === undefined) return prev;

  const { handle, phase } = event;

  if (phase === "tick") {
    if (prev.has(handle)) return prev;
    return new Set(prev).add(handle);
  }

  if (!prev.has(handle)) return prev;

  const next = new Set(prev);
  next.delete(handle);
  return next;
}

/**
 * What the sidebar dot means, in words.
 *
 * 🛑 ONLY THE WORKING STATE IS NAMED, BY lee'S RULING OF 2026-11-14: "no
 * title". The dot has carried "online" in colour alone since it was written,
 * and that stays as it is. This names the ONE state #240 added, so the pulse
 * does not become a second meaning carried by colour alone.
 *
 * 🛑 THIS DOES NOT SETTLE `prefers-reduced-motion`, AND IT READ AS IF IT DID.
 * A title answers WCAG 1.4.1, meaning carried in colour alone. 2.2.2 asks
 * whether motion running over five seconds can be STOPPED, which no amount of
 * text answers. `style.css` reduces the animation separately. Found by claude1.
 *
 * ⚠️ IT TAKES NO `online`. The online and offline states are deliberately
 * unnamed, so reading that flag would be reading something this function
 * cannot act on.
 *
 * @param {{kind: string, working: boolean}} row
 * @returns {string | null} null when the dot carries no meaning
 */
export function dotTitle({ kind, working }) {
  // Every room is passed `online: true` because the dot is decoration there.
  // A shared title would label each one "Online", which asserts nothing.
  if (kind !== "peer") return null;

  // 🛑 ONLY THE WORKING STATE IS NAMED. lee, 2026-11-14: "no title". Online and
  // offline stay as they have always been, carried by the dot's colour alone.
  // The consequence is deliberate: the tooltip appears and disappears with the
  // work, so a reader who hovers an idle agent gets nothing rather than "idle".
  if (!working) return null;

  return "Working — producing output now";
}

// ── Agent registration card (#132 slice 4a) ──────────────────────────────

/**
 * The two sandbox modes, and what each one GRANTS rather than what it is
 * called.
 *
 * 🛑 "host" ALONE DOES NOT TELL AN OPERATOR WHAT IT COSTS. It is the loosest
 * setting in the file and reads like a neutral default, so the consequence is
 * spelled out everywhere the word appears.
 */
const MODE_LABELS = {
  docker: "docker — contained",
  host: "host — FULL HOST ACCESS",
};

/**
 * What a withheld `mode` reads as.
 *
 * 🛑 `undefined` IS THE ONLY WAY TO REACH THIS, so the label cannot be shown
 * to someone who already holds admin. `readRegistrations` THROWS on an
 * unrecognised mode rather than passing it through, which is pinned by
 * "an unrecognised mode is refused, never read as host" in
 * `test/supervise/registrations.test.ts`. Raised by claude2 on PR 375 as a
 * conflation; it is not reachable while that guard holds.
 */
const MODE_WITHHELD = "(needs admin)";

/** The modes a draft may name. Matches `MODES` in `registrations.ts`. */
const FORM_MODES = ["host", "docker"];

/**
 * One row per registered handle, ordered by handle.
 *
 * 🛑 AN ABSENT `mode` RENDERS AS WITHHELD, NEVER AS EITHER MODE.
 * `/api/agents` drops the field below `admin`, so guessing would show a
 * contained agent as loose or a loose one as contained. Both are wrong and
 * the second is the dangerous one.
 *
 * ⚠️ ORDERED, BECAUSE `agents.json` IS AN OBJECT. Insertion order would
 * reshuffle the list under the operator on the refresh after a write.
 *
 * @param {{agents?: Record<string, {vendor: string, mode?: string}>}} [payload]
 * @param {readonly string[]} capabilities the CALLER's own, from /api/whoami
 */
export function registrationRows(payload, capabilities = []) {
  const agents = payload?.agents ?? {};
  const admin = capabilities.includes("admin");

  return Object.keys(agents)
    .sort()
    .map((handle) => {
      const stored = agents[handle]?.mode;

      return {
        handle,
        vendor: agents[handle]?.vendor ?? "(unknown)",
        mode: MODE_LABELS[stored] ?? MODE_WITHHELD,
        // The raw value, for the form the row populates. Null when withheld,
        // so nothing downstream can read the label back as a mode.
        storedMode: MODE_LABELS[stored] ? stored : null,
        // 🛑 THE CAPABILITY, NOT THE PRESENCE OF `mode`. An admin looking at a
        // handle whose mode somehow failed to serve still holds the tier, and
        // keying on the field would hide a control the route would accept.
        canForget: admin,
      };
    });
}

/**
 * Whether a registered row offers Start (#423).
 *
 * 🛑 DOCKER ONLY, on lee's ruling of 2026-11-25. The asymmetry is not cosmetic:
 * `src/index.ts:695` gates the container plan's confirmation on
 * `selection.mode === "docker"`, so the HOST path has nothing to approve. A
 * host Start would therefore be one click to an agent holding the operator's
 * whole filesystem and logins, with no consent step anywhere in it.
 *
 * 🛑 KEYED ON `storedMode`, WHICH IS NULL FOR A WITHHELD MODE. Reading the
 * label instead would let an unreadable mode render as docker, which is the
 * failure `registrationRows` already refuses one field up.
 *
 * 🛑 AN AFFORDANCE, NOT A PRECONDITION — the same shape as `stopAllVisible`.
 * `refuseIfSupervisorLive` rejects a second supervisor cross-process, so a
 * handle that goes live between this render and the click is answered with a
 * 409 rather than started twice. Hiding the button is courtesy; the route is
 * the guard.
 *
 * @param {{handle: string, storedMode: string|null}} row
 * @param {boolean} admin
 * @param {readonly string[]} liveHandles
 */
export function startVisible(row, admin, liveHandles = []) {
  // The capability, not the row, for the same reason as `canForget`:
  // `POST /api/agents/start` is `admin`, so a lower tier would be offered a
  // control the route answers with a 403.
  if (admin !== true) return false;
  if (row?.storedMode !== "docker") return false;

  return !liveHandles.includes(row.handle);
}

/**
 * What the card says when nothing is registered.
 *
 * 🛑 NOT A BLANK, for the same reason as the claims panel: an empty card and
 * one that failed to load look identical.
 */
export function registrationsPanelEmpty() {
  return "(no agents registered — every handle starts on the default)";
}

/**
 * What a caller below `admin` is not being shown.
 *
 * 🛑 SAID OUT LOUD. `/api/agents` withholds `mode` and refuses the writes, so
 * a silent card would read as "no agent is contained".
 *
 * @returns {string | null} null when nothing is withheld
 */
export function registrationNotice(capabilities = []) {
  if (capabilities.includes("admin")) return null;

  return (
    "Read-only: each agent's mode is withheld, and registering or forgetting " +
    "one needs admin."
  );
}

/**
 * Why a draft cannot be submitted, named field by field.
 *
 * 🛑 THE VENDOR IS CHECKED AGAINST WHAT THE BUILD CAN SPAWN, which the server
 * sends. `POST /api/agents` takes any non-empty string and `spawnFor` throws
 * at START time, so without this the operator learns of a typo one step
 * removed from the form that made it.
 *
 * @returns {string | null} null when the draft is submittable
 */
export function registrationFormError(draft, vendors = []) {
  const handle = (draft?.handle ?? "").trim();

  if (handle.length === 0) return "A handle is required.";

  if (!vendors.includes(draft?.vendor)) {
    return (
      `This build cannot spawn "${draft?.vendor}". It has: ` +
      `${vendors.join(", ")}.`
    );
  }

  if (!FORM_MODES.includes(draft?.mode)) {
    return `"${draft?.mode}" is not a mode. Pick one of: ${FORM_MODES.join(", ")}.`;
  }

  return null;
}

/**
 * The confirm shown when a write would LOOSEN a handle's sandbox.
 *
 * 🛑 ONE DIRECTION ONLY. Slice 2 settled that a flag may tighten the mode and
 * never loosen it, so the card's write is the only way out of `docker` — and
 * it is the one that needs reading twice.
 *
 * 🛑 A NEW HANDLE IS NOT A LOOSENING and is deliberately not confirmed. There
 * is no recorded decision to undo, and a dialog on every registration is how
 * the one that matters gets clicked through.
 *
 * @returns {string | null} null unless the mode goes docker -> host
 */
export function loosenConfirmText(handle, from, to) {
  if (from !== "docker" || to !== "host") return null;

  return (
    `Give ${handle} FULL HOST ACCESS?\n\n` +
    "It runs contained today. On its next start it will run directly on this " +
    "machine, with the same reach as the operator."
  );
}

/**
 * The confirm shown before a registration is removed.
 *
 * ⚠️ FORGETTING IS NOT TIGHTENING. The handle falls back to whatever the
 * start-time default resolves to, which may be looser than the record being
 * deleted.
 */
export function forgetConfirmText(handle) {
  return (
    `Forget the registration for ${handle}?\n\n` +
    "It will start on the default for its driver instead, which may not be " +
    "the mode recorded here."
  );
}

/**
 * What a handle's container-plan verdict reads as — #132 slice 4b.
 *
 * 🛑 AN UNRECOGNISED VERDICT MUST NOT READ AS APPROVED. A kind added to
 * `ConfirmVerdict` and not added here would otherwise render as nothing beside
 * a handle that then refuses to start, and silence is the direction that reads
 * as "fine".
 *
 * 🛑 `changed` IS NOT NEUTRAL. The plan moved under a recorded approval, which
 * is the one case where an operator has already decided something and the
 * decision no longer covers what will run.
 */
const PLAN_VERDICT_LABELS = {
  confirmed: "container plan approved",
  unseen: "container plan not approved yet",
  legacy: "approved before the plan was recorded",
  changed: "container plan CHANGED since it was approved",
};

const PLAN_VERDICT_UNKNOWN = "container plan state unknown";

export function planVerdictLabel(verdict) {
  return PLAN_VERDICT_LABELS[verdict] ?? PLAN_VERDICT_UNKNOWN;
}

/**
 * Whether the row offers an approve control.
 *
 * 🛑 EVERYTHING THAT IS NOT `confirmed` NEEDS ONE, INCLUDING AN UNKNOWN. The
 * list is of the one verdict that needs nothing, so a new kind arrives needing
 * approval rather than silently start-ready.
 */
export function planNeedsApproval(verdict) {
  return verdict !== "confirmed";
}

/**
 * The approve button's words, or null when there is nothing to approve.
 *
 * 🛑 A RE-APPROVAL SAYS SO. "Approve" on a handle whose plan moved reads as a
 * first approval, and which approval is being re-taken is the operator's
 * actual question.
 */
export function planApproveLabel(verdict) {
  if (!planNeedsApproval(verdict)) return null;

  return verdict === "unseen" ? "Approve plan" : "Re-approve plan";
}

/**
 * The modifier the row's plan line carries, so CSS can warn on it.
 *
 * ⚠️ `legacy` IS NOT WARNED ON. There is nothing to compare it against, so
 * flagging it the same as a moved plan would spend the warning colour on the
 * case that carries no new information.
 */
export function planVerdictClass(verdict) {
  if (
    verdict === "changed" ||
    planVerdictLabel(verdict) === PLAN_VERDICT_UNKNOWN
  )
    return " is-stale";

  return "";
}

/**
 * #397 — the settings modal's tabs, in render order.
 *
 * 🛑 A LIST, NOT TWO HARDCODED BUTTONS. lee ruled two tabs now and a third
 * later, so adding one is an entry here and nothing else. `settings-tabs.test.ts`
 * asserts the CSS names no tab and no count.
 */
export const SETTINGS_TABS = [
  { id: "agents", label: "Agents" },
  { id: "rooms", label: "Rooms" },
];

/**
 * Which tab the modal opens on.
 *
 * ⚠️ AN UNKNOWN ID FALLS BACK rather than opening nothing. The id outlives the
 * tab whenever one is renamed, and a blank modal reads as a broken dialog.
 */
export function settingsTabSelection(requested, tabs = SETTINGS_TABS) {
  const match = tabs.find((t) => t.id === requested);

  return match ? match.id : tabs[0].id;
}

/**
 * #399 — which sidebar sections a state change actually requires rebuilding.
 *
 * 🛑 THE DECISION IS PURE AND THE MUTATION IS NOT. No `document` here, for the
 * reason `logic.test.ts` already records about geometry: happy-dom reports
 * nonsense and every assertion written against it passes while proving nothing.
 *
 * ⚠️ WHAT THIS CANNOT PROVE is that `renderSidebar` then replaces the nodes the
 * planner named. That needs a browser and is #330.
 */
export const SIDEBAR_SECTIONS = [
  { key: "claims", inputs: ["claims", "handle"] },
  {
    key: "agents",
    // 🛑 `nowMinute` SURVIVED #374, AND THE COMMENT HERE SAID IT WOULD NOT.
    // It was justified as the thing that moved `bound Xm` along, so removing
    // that label read as removing its last reader. It is not: the projection
    // below drops `fresh`, so the minute bucket is the ONLY thing that
    // announces the 15-minute flip to the stale gauge band. Dropping it would
    // freeze a gauge at "ok" forever, silently.
    //
    // 🛑 THIS SECTION HOLDS A VALUE THAT LIVES ONLY IN THE DOM, so its input
    // list is NOT the peers list copied across. `gateControl`'s percent input
    // keeps what the operator typed in the element, never in state, so every
    // rebuild here DISCARDS it — #399's registration defect in a second place.
    //
    // The test for any candidate input is WHO MOVES IT:
    //
    //   operator-initiated   `currentTarget`, `openMenuFor`. The operator
    //                        clicked away from their own edit, so losing it is
    //                        their choice. Declared.
    //   background           `peers`, `activity`. These move on their own and
    //                        would eat the typing with no action at all.
    //                        ABSENT, and painted in place instead.
    //
    // ⚠️ `activity` WAS DECLARED HERE FOR ONE COMMIT and it was wrong: a child
    // starting work rebuilt the section mid-edit. `paintPulse` already reaches
    // an agent row — its selector is `.sidebar__item[data-kind="peer"]` with no
    // section scoping, and the row is built with `kind: "peer"`. Caught by
    // claude2 reviewing this PR.
    //
    // ⚠️ `peers` is the same: `paintAgentDots` paints the online dot instead.
    inputs: [
      "agents",
      "gateDefault",
      "nowMinute",
      "currentTarget",
      "openMenuFor",
    ],
    project: { agents: agentsWithoutClock },
  },
  {
    key: "peers",
    // 🛑 `agents` IS AN INPUT BECAUSE #374 FILTERS BY IT. The section hides
    // every supervised child, so a child appearing or exiting changes what
    // this section renders while `state.peers` is byte-identical.
    inputs: ["peers", "currentTarget", "activity", "openMenuFor", "agents"],
    // 🛑 PROJECTED TO THE CHILD HANDLES ALONE. Signing the whole payload would
    // rebuild the peers section on every gauge tick, which is the churn #399
    // existed to stop.
    project: { agents: supervisedChildHandles },
  },
  { key: "rooms", inputs: ["rooms", "currentTarget", "openMenuFor"] },
  { key: "discover", inputs: ["discoverRooms"] },
];

/**
 * A stable string for any state value.
 *
 * 🛑 A `Set` MUST NOT REACH `JSON.stringify`. It yields `{}` for every Set, so
 * `state.activity` would compare equal forever and the peers section would stop
 * updating — silently, in the direction that looks like success.
 */
function stableValue(value) {
  if (value instanceof Set) return JSON.stringify([...value].sort());
  if (value instanceof Map) {
    return JSON.stringify(
      [...value].sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    );
  }

  return JSON.stringify(value ?? null);
}

/**
 * The agents payload with its two CLOCK-DERIVED fields dropped.
 *
 * 🛑 `/api/agents/live` spreads `gaugeFreshness(reported_at, Date.now())` onto
 * each child, so `fresh` and `age_ms` move on every request and a signature
 * holding them can never skip. `context_reported_at` STAYS: a new report is
 * real state, and the minute bucket carries the 15-minute flip to stale.
 */
function agentsWithoutClock(agents) {
  if (!Array.isArray(agents)) return agents;

  return agents.map((agent) => {
    const child = agent?.child;
    if (child === null || typeof child !== "object") return agent;

    const kept = { ...child };
    delete kept.fresh;
    delete kept.age_ms;

    return { ...agent, child: kept };
  });
}

/**
 * One signature per section, over a DEEP read of that section's inputs.
 *
 * A section may declare a `project` per input, which is the only place a value
 * is narrowed before it is signed.
 */
export function sidebarSignatures(state, sections = SIDEBAR_SECTIONS) {
  const out = {};
  for (const { key, inputs, project } of sections) {
    out[key] = inputs
      .map((k) => {
        const read = project?.[k];

        return `${k}=${stableValue(read ? read(state[k]) : state[k])}`;
      })
      .join("&");
  }

  return out;
}

/**
 * The section keys whose inputs changed, in render order.
 *
 * A key absent from `prev` counts as changed, so the first render rebuilds
 * everything and a recovered-from-empty sidebar does too.
 */
export function sectionsToRebuild(prev, next, sections = SIDEBAR_SECTIONS) {
  return sections.map((s) => s.key).filter((key) => prev[key] !== next[key]);
}
