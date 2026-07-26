# Ink UI Tweaks — Design

Date: 2026-07-26
Scope: `src/cli/ink/App.tsx` (single-file today; may fan out during implementation).
Runtime: `chat-mcp cli --experimental --handle <handle>`.

## Goal

The Ink UI is functional but feels unfinished on three axes:

1. **Input + commands** — no autocomplete, no arg hints, no keyboard-driven navigation beyond Ctrl-C.
2. **Rooms discoverability** — sidebar only lists rooms the user has already joined; there is no in-UI way to see or join others.
3. **In-UI help / instructions** — `/help` dumps a single-line wall of text; empty panes give no guidance.

This design addresses all three together because the fixes share plumbing (keybindings, overlay pane, formatted rendering).

## Non-goals

- Message-body autocomplete / spell-check.
- Search across message history (grep-like) — separate future spec.
- Mouse support.
- Theme customisation.
- New MCP tools or DAO methods beyond those needed for room enumeration.

## Summary of changes

| Area | Change |
|---|---|
| Slash command entry | Inline autocomplete dropdown above input as user types `/`. |
| Argument completion | Tab-completes peer handles (`/dm`, `/dispatch`, `/watch`, `/alert`) and room names (`/join`, `/broadcast`, `/alert #`). |
| Command palette | Ctrl-K opens fuzzy-search overlay of all commands with one-line descriptions. |
| Hint bar | Context-aware single-line strip at the bottom of the screen. Content changes per view. |
| Number-key jumps | `1`–`9` (when input is empty) jump focus to the Nth sidebar entry. |
| Input history (↑/↓) | Session-only ring buffer (last 100 submitted entries). `↑`/`↓` recall when the autocomplete dropdown is closed. |
| Scrollable messages pane | Last 200 messages queried per view; PageUp/PageDown/Home/End navigate. Auto-follow new messages when scrolled to bottom. |
| Markdown in message bodies | Inline `**bold**`, `*italic*`, `` `code` ``, `[link](url)`, and fenced ```` ```code blocks``` ```` render styled. Non-matching text renders verbatim. |
| `/help` | Renders as a formatted, categorised table in the main pane — not a status-line dump. Also bound to `?`. |
| Rooms sidebar | Single ROOMS list: joined rooms first (cyan), a `── join ──` divider, then discoverable rooms dimmed with a `＋` prefix. |
| `/rooms` browser | Dedicated full-pane view (also opened by hotkey `R`) listing every active room with member count + handles. Enter opens (joined) or joins (not). |
| Input editing keybindings | Readline-standard cursor + word + line edits inside the input bar (Ctrl-A/E, Ctrl-W, Ctrl-U, Opt-Left/Right, Opt-Backspace, etc.). Cmd-* is unreachable on macOS — spec is honest about it. |
| Empty states | Contextual guidance in every empty pane — no more bare `(no messages)`. |

## Detailed design

### 1. Slash-command autocomplete

**When**: input text begins with `/` and has ≥1 character after the slash.
**Where**: a small `<Box>` rendered directly above the input bar, inside the same column as the input. Bordered `cyan`, up to 6 rows.
**Contents**: each match is one row: `<name>` bold-cyan, `<arg-shape>` dim, `— <one-line description>` dim.
**Matching**: prefix match on command name (case-insensitive). Order = source order in the command table.
**Interaction**:

- Typing continues to filter live.
- **Tab** completes to the longest common prefix; if a single command matches, completes fully and appends a trailing space.
- **Enter** submits the current input as-is (does not consume the dropdown).
- **Esc** clears input and closes the dropdown.

### 2. Argument completion (Tab)

Triggered when the cursor is inside an argument slot and the user presses **Tab**. Applied per-command:

| Command | Slot | Source |
|---|---|---|
| `/dm <peer>` | peer | `dao.listAgents(db, true)` where `handle !== me` |
| `/dispatch <peer> …` | peer | same |
| `/watch <peer>` | peer | same |
| `/alert <target> …` | peer or room | see below |
| `/join #<room>` | room | `dao.listAllRooms(db)` where `not member` |
| `/broadcast #<room> …` | room | rooms where user is a member |
| `/alert #<room> …` | room | rooms where user is a member |

**Behaviour**: `Tab` on a partial arg finds candidates by prefix. If one match, completes it + trailing space. If several, shows the same-style dropdown as command autocomplete, listing candidates.

**`/alert` target disambiguation**: if the partial starts with `#` → room-mode; otherwise → peer-mode.

**Implementation note**: `ink-text-input` doesn't expose an `onKeyDown` for Tab. Two options:

- Replace `ink-text-input` with a hand-rolled input built on `useInput` (already used for Ctrl-C) — full control, ~50 lines.
- Fork/patch `ink-text-input` — brittle across upgrades.

Preferred: hand-rolled input. Details in implementation plan.

### 3. Command palette (Ctrl-K)

**Trigger**: `Ctrl-K` from anywhere except an active modal.
**Rendering**: overlay `<Box>` positioned near the top of the screen, `magenta` border, background dimmed content underneath. Contains:

- A one-line query box with a `🔍` prefix.
- Up to 8 result rows: highlighted row has magenta background; row = `<name>` bold, `— <description>` dim.
- Footer: `↑↓ move · Enter run · Esc close`.

**Matching**: fuzzy match on `<name> + <description>` (subsequence). No external fuzzy lib — small case-sensitive-off subsequence match, ~20 lines.

**On Enter**:

- Commands with no args (`/back`, `/who`, `/rooms`, `/help`, `/leave`, `/unwatch`, `/ack`, `/quit`) execute immediately.
- Commands with args populate the input bar with `<name> ` (trailing space), cursor at end. Palette closes. User fills in args.

**Scope for MVP**: palette contains commands only. Peers and rooms are **not** listed as palette actions — Ctrl-K → type a command name, not a peer. (Notable future extension: "actions" — `Open DM with claude1`, `Join #planning` — but out of scope here.)

### 4. Context-aware hint bar

Single-line dim strip immediately above the input bar. Content is determined by current view:

| View | Hint content |
|---|---|
| home (`kind: 'home'`) | `Ctrl-K` commands · `↑↓` history · `/join` #room · `/dm` peer · `1-9` jump · `?` help |
| dm | `↑↓` history · `PgUp/Dn` scroll · `Tab` complete · `Ctrl-K` commands · `/watch` peer · `/back` home · `?` help |
| room | `↑↓` history · `PgUp/Dn` scroll · `Tab` complete · `Ctrl-K` commands · `/leave` · `/back` home · `?` help |
| rooms browser | `↑↓` move · `Enter` open/join · `/back` home |
| who | `/back` close · `?` help |
| help | `/back` close |

Bindings shown are **existing or added-in-this-spec** bindings — no aspirational entries. `↑↓` overloads by context: when the autocomplete dropdown is open, arrows navigate matches; otherwise they recall history (see §7.5).

### 5. Number-key jumps

**Trigger**: user presses `1`–`9` while the input buffer is empty.
**Action**: focus jumps to the Nth entry in the sidebar, in visual order (agents first, then joined rooms). Opens the corresponding DM or room view.
**Edge**: if `N` > sidebar-item count, nothing happens (silent no-op). No status-line noise.
**Escape hatch**: if the user's intent was "type '1'", they can type any other character first, then delete → normal insertion; or use `\1` (backslash-escape) as a formal escape. MVP: no escape needed given input-empty gating covers the common case.

### 6. Formatted `/help` (and `?` shortcut)

`/help` (and hotkey `?` when input is empty) opens a dedicated help view in the main pane (like `/who`). Content is a static categorised table:

```
CONVERSATION
  /dm <peer>              open a DM
  /join #<room>           join a room
  /leave                  leave current room
  /back                   return to home

MESSAGING
  /dispatch <peer> <text>       tagged [DISPATCH]
  /broadcast #<room> <text>     tagged [DISPATCH]
  /alert <target> <text>        urgent, red banner
  /ack                          dismiss alerts

STATUS & OBSERVATION
  /set-status <s> [focus]
  /who                    peer table
  /rooms                  room browser
  /watch <peer>           mirror peer traffic
  /unwatch                close watch pane

KEYBOARD
  Ctrl-K    command palette
  Tab       complete peer/room in current arg
  ↑↓        (in dropdown) navigate matches
  1-9       jump to sidebar entry (when input empty)
  ?         open this help
  Ctrl-C    quit
```

Category headers are `magenta bold`; command names are `cyan bold`; arg shapes and descriptions are `dim`.

### 7. Rooms sidebar (shape B)

Replaces the current `myRooms(…)` list with a single ROOMS section that includes **all rooms with ≥1 member**, ordered:

1. Joined rooms first, in `dao.myRooms(db, handle)` order, rendered as today: cyan name, unread badge `(N)`.
2. A dim single-line divider: `── join ──`.
3. Discoverable rooms (any room not in the joined set), dimmed, with a `＋` prefix: `＋ #planning`.

**Data source**: needs a new DAO helper, `listAllRooms(db)`. Query: `SELECT r.name FROM rooms r WHERE (SELECT COUNT(*) FROM room_members WHERE room_name = r.name) > 0 ORDER BY r.created_at`.

**Interaction**:

- Numeric jump lands on any visible room, joined or not.
- Jumping to a discoverable room opens it in the same view as `/join #<name>` would — i.e. joins and switches. (Design choice: no confirmation. Joining is cheap; the visible member-count trigger on other members is the only side effect.)

**Member counts in the sidebar**: **omitted**. `(N)` in the sidebar means unread only. Member counts live in the /rooms browser to keep the sidebar scannable.

### 7.5 Input history recall (↑ / ↓)

**Trigger**: `↑` or `↓` in the input, **only when the autocomplete dropdown is not open**. If the dropdown is open, arrows navigate matches (per §1); otherwise they navigate history.

**Behaviour**:

- **`↑`** — replace the input with the previous submitted entry (message or slash command). Repeated `↑` walks further back.
- **`↓`** — walk forward toward the most recent; past the newest entry, restores whatever the user had typed at the moment they first pressed `↑` (call this the "draft").
- **Reset**: any user edit (character insert, backspace, cursor move via Ctrl-A/E/Left/Right, etc.) resets the history pointer to "nothing recalled" and clears the saved draft.

**Scope**:

- Session-only. Not persisted across restarts.
- Ring buffer of the last 100 submitted entries — same buffer across all views. Rationale: TUI users treat history as a single stream regardless of context; per-view history is surprising when you re-run "the last thing" and get skipped over.
- Empty submissions are not recorded.
- Consecutive duplicates are collapsed (one entry, not one per repeat).

**Implementation**: an in-memory `string[]` and an integer pointer live at App.tsx state. `Input` exposes `onUp` / `onDown` callbacks (already planned for autocomplete); App wires them to autocomplete when `completions.length > 0` and to history otherwise. Reset triggers off `onChange`.

### 8. `/rooms` browser (also `R` hotkey when input empty)

A dedicated view (`kind: 'rooms'`) rendered in the main pane. Contents:

```
Rooms · 5 active
──────────────────────────────────────────
✓ #leagues     3 members · claude1, pclaude, lee
✓ #gate        2 members · you, claude1
  #planning    4 members · claude1, pclaude, lee, +1
  #deploy      2 members · claude1, pclaude
  #random      1 member  · lee
──────────────────────────────────────────
↑↓ move · Enter open/join · /back to close
```

**Row structure**: `<mark>` (`✓` if joined, blank if not) · `<name>` · `<count> members` · dim comma-list of up to 3 handles, plus `+N` if more.

**Interaction**:

- `↑`/`↓` move the highlighted row.
- `Enter` on a joined room = `setView({ kind: 'room', room })`.
- `Enter` on a not-joined room = `dao.joinRoom(db, name, handle)` (with the same notify-fanout `/join` does today), then switch.
- `/back` or `Esc` returns to home.

**Data source**: `listAllRooms` + `dao.roomMembers` per row. For MVP, N ≤ 20 rooms in practice — no pagination.

### 9. Input editing keybindings

Readline-standard editing available inside the input bar. The hand-rolled input (§2) is what makes this possible — `ink-text-input` doesn't expose the low-level keys.

**Terminal reality check.** On macOS, terminal apps (Terminal.app, iTerm2, Alacritty, Ghostty, etc.) intercept `Cmd-*` combos at the OS/app level — they do **not** reach the running Ink process. Cmd-Left, Cmd-Delete, Cmd-Backspace as literal shortcuts are unavailable. The equivalents that **do** deliver are the readline / emacs set (`Ctrl-*`) plus Mac option-key combos (`Opt-*`, delivered as ESC-prefixed sequences when the terminal is configured for "Option as Meta"). This spec uses only keys that reach the process.

| Action | Binding (Mac) | Binding (universal / Linux) |
|---|---|---|
| Move cursor to start of line | `Ctrl-A` | `Ctrl-A` |
| Move cursor to end of line | `Ctrl-E` | `Ctrl-E` |
| Move cursor one word left | `Opt-Left` | `Ctrl-Left` (if delivered) / `Alt-B` |
| Move cursor one word right | `Opt-Right` | `Ctrl-Right` (if delivered) / `Alt-F` |
| Delete previous word | `Opt-Backspace` **or** `Ctrl-W` | `Ctrl-W` |
| Delete next word | `Opt-Delete` **or** `Alt-D` | `Alt-D` |
| Delete from cursor to start of line | `Ctrl-U` | `Ctrl-U` |
| Delete from cursor to end of line | — (see conflict below) | — |
| Clear line + cancel dropdown | `Esc` | `Esc` |

**Conflict: Ctrl-K.** Readline "kill to end of line" is `Ctrl-K`, but this spec puts the command palette on `Ctrl-K`. Two viable resolutions:

- **Keep palette on `Ctrl-K`, drop kill-to-EOL.** Users get `Ctrl-U` (kill-to-start) and can retype. Simplest, least surprising for people who don't know the readline binding.
- **Move palette to `Ctrl-P`.** Palette on Ctrl-P is common (though Ctrl-P is also often "previous history" — but this spec doesn't add history recall, so no clash today).

MVP picks **keep palette on `Ctrl-K`**, note the omission of kill-to-EOL in `/help`. Revisit if users complain.

Bindings **not** implemented (called out to avoid confusion):

- `Cmd-*` anything — terminal-app-level, unreachable.
- `Ctrl-Left` / `Ctrl-Right` — delivery is terminal-dependent; falls back to `Opt-Left/Right` on Mac.
- Text selection / clipboard — Ink has no notion of selection state within an input field. Copy/paste goes through the terminal app's own mouse selection.

### 10. Empty states

Replace the bare `(no messages)` and `(select an agent or room)` placeholders with contextual multi-line panels:

**home view (no conversation open)**:
```
Nothing to show yet.

  Ctrl-K       browse commands
  /dm claude1  start a DM
  /join #x     join or discover a room
  1-9          jump to a sidebar entry
```

**DM view with no messages**:
```
No messages yet.

Say hi, or send a tagged message:
  /dispatch claude1 <text>
```

**Room view with no messages**:
```
No messages in #leagues yet.

  /broadcast #leagues <text>   post to the room
  /leave                       leave the room
```

Each empty state is inline-static — no runtime dispatch on which hints to show. Copy chosen once per view.

### 11. Scrollable message lists (messages pane + watch pane)

Both the main messages pane and the optional watch pane render a list of `Message` objects. Today the messages pane caps at 30 rows and the watch pane at 10; both cut off silently and the user cannot scroll back to see older messages. Fix: shared `ScrollableMessageList` component, used in both places.

**Data**:

- Messages pane query lifted from `LIMIT 30` to `LIMIT 200` per view (DM or room). Preserves the "latest first, reverse to chronological" pattern.
- Watch pane query lifted from `LIMIT 10` to `LIMIT 100`.
- Both are still hard caps for MVP — no infinite scroll / progressive load. A 200-message ceiling covers "the current conversation" in practice.

**Rendering**:

- Component takes `messages: Message[]` + `viewportRows: number` and internally tracks a `scrollOffset` (0 = pinned to newest, N = scrolled back N lines).
- Wrapped-line height matters for accuracy but is expensive in Ink. MVP treats each message as ~2 rows (header line + body line); overflow beyond that pushes into the next "page." Good enough — precision is a future polish.

**Keybindings** (delivered to the pane when the pane is focused; when the input is empty and the messages pane owns focus by default):

| Key | Action |
|---|---|
| `PageUp` | Scroll up by `viewportRows - 2` (near-full page, keep 2 rows for continuity). |
| `PageDown` | Scroll down by same. |
| `Home` | Jump to the top of the loaded window (oldest visible). |
| `End` | Jump to bottom (newest); re-arms auto-follow. |

**Auto-follow**: when `scrollOffset === 0` (pinned to newest), incoming messages cause the pane to stay pinned to newest. If `scrollOffset > 0` (user has scrolled back), incoming messages do NOT snap the view back — the user's read position is preserved. A dim `↓ N new` indicator at the bottom of the pane surfaces how many newer messages the user hasn't seen.

**Focus routing**: the input bar always owns character keys (typing). PageUp/PageDown/Home/End are dispatched to the currently-visible message list. When both messages and watch are visible, `PageUp` moves the messages pane; a modifier (`Shift-PageUp` / `Shift-PageDown`) targets the watch pane. If Shift-Page delivery is unreliable in a terminal, fall back to a `/watch-scroll <up|down>` slash command — but MVP tries Shift-Page first.

**Scope**: `HelpPane`, `RoomsBrowserPane`, and `WhoPane` are NOT scrollable in this pass — their content is bounded (finite command list, finite rooms count, finite peers). If they grow beyond a screen, revisit.

### 12. Markdown rendering in message bodies

Message bodies (the text posted via `/dispatch`, `/broadcast`, or plain chat) render with a minimal markdown subset:

| Syntax | Effect |
|---|---|
| `**bold**` | Bold text. |
| `*italic*` | Italic text (terminal support varies; degrades to bold-off if unsupported). |
| `` `code` `` | Inline code — dim background, monospace already default. |
| ```` ```lang\ncode\n``` ```` | Fenced code block — indented, dim-boxed. `lang` is ignored (no syntax highlight in MVP). |
| `[label](url)` | The label renders as underlined + cyan; the URL renders dim in parens after (terminals rarely support click-through OSC-8, but that's a nice future). |

**Scope of the parser**:

- Message-body text only. Header lines (sender, timestamp, `[DISPATCH]` / `[ALERT]` tags) render as today.
- Applies uniformly in the messages pane AND the watch pane.
- Alerts (`kind === 'alert'`) render body with markdown, but the alert-lane wrapping / color stays as today.
- No block-level markdown (headers, lists, blockquotes, tables). If a user posts `# foo`, it renders as literal `# foo`.

**Implementation**:

- Hand-rolled tokenizer + Ink `<Text>` renderer, no new dependencies. ~80 lines in `src/cli/ink/util/markdown.tsx` — see plan.
- Escape hatch: a leading `\` before any of the trigger characters (`*`, `` ` ``, `[`) renders it literal.

**Testing**: unit-test the tokenizer with `node:test` — verify each syntax + escape + a mixed-content case.

## Architecture / decomposition

Current `App.tsx` is 770 lines in one file. This spec grows the file materially — palette overlay, autocomplete dropdown, /rooms browser, empty-state panels — plus a hand-rolled input. Splitting is required to keep components under ~200 lines each.

Proposed split (created during implementation):

```
src/cli/ink/
  App.tsx                 root layout + view state + top-level keyboard routing
  input/
    Input.tsx             hand-rolled input (replaces ink-text-input)
    Autocomplete.tsx      slash + arg dropdown
    completions.ts        pure fn: (input, cursor, db, me) -> Completion[]
  palette/
    Palette.tsx           Ctrl-K overlay
    commands.ts           the canonical command catalogue (name, args, desc, category)
  panes/
    Sidebar.tsx           agents + rooms (joined + discover)
    MessagesPane.tsx      existing, extracted
    WhoPane.tsx           existing, extracted
    HelpPane.tsx          new
    RoomsBrowserPane.tsx  new
    EmptyState.tsx        one component with per-view children
  HintBar.tsx             context-aware footer
  AlertLane.tsx           existing, extracted
  Header.tsx              existing, extracted
  keybindings.ts          central useInput handler, delegates by focus
```

The single `commands.ts` module is load-bearing: `Autocomplete`, `Palette`, and `HelpPane` all read the same catalogue. Adding a command means editing one file.

## Data / DAO changes

New DAO helper: `listAllRooms(db: Db): Room[]` — every room with `member_count > 0`, ordered by `created_at`. Adds an index-free query but the rooms table is tiny (< 100 rows for foreseeable use).

No schema changes. No message-kind changes. No notify-bus changes.

## Testing

`chat-mcp` has no test harness today. Adding one is out of scope for this spec. Verification is manual:

1. **Autocomplete** — with two peers online, `/d<Tab>` completes to a menu of `/dm`, `/dispatch`. `/dm cla<Tab>` completes to `/dm claude1 `.
2. **Palette** — Ctrl-K, type `join`, Enter → input contains `/join `.
3. **Rooms sidebar** — with `#leagues` joined and `#planning` discoverable, sidebar shows both correctly styled. `3<Enter>` on empty input jumps to the third sidebar entry.
4. **/rooms browser** — R (or `/rooms`) opens the pane. ↑↓ selects rows. Enter on a not-joined row joins and opens.
5. **Hint bar** — hints change when switching between home, DM, room, /who, /rooms.
6. **Empty states** — new user with no conversations sees the home empty state; opening a fresh room shows the room empty state.
7. **Input editing** — with `hello world foo bar` typed, `Opt-Backspace` deletes `bar`, `Ctrl-U` clears the line, `Ctrl-A` then `Ctrl-E` cycles cursor between ends, `Opt-Left/Right` steps word-by-word. Verify on both Terminal.app and iTerm2 (Opt-as-Meta must be enabled in Terminal.app; iTerm2 has it as "Left Option: Esc+" in Profiles → Keys).

## Risks

- **Hand-rolled input** — `ink-text-input` has cursor/selection semantics we'd re-implement. Risk of regressions in Unicode, backspace on empty, arrow-key cursor movement. Mitigation: keep the component isolated in `Input.tsx` with a clear surface (`value`, `onChange`, `onSubmit`, `onKey`). Fall back to `ink-text-input` if scope creeps.
- **Number-key ambiguity** — user types "1 second later" as first message character, but `1` gets swallowed. Gating on empty-input mitigates but doesn't eliminate. Deferred escape-hatch (backslash-escape) if reports come in.
- **Overlay z-order in Ink** — Ink does not have absolute-positioned overlays; the palette must be rendered as a top-level `<Box>` in `App` and other panes must dim/hide when it's open. Slightly more coupling than a browser overlay would have.
- **Palette without action-actions** — MVP palette lists commands only. Users expecting "Ctrl-K → type peer name → jump to DM" won't get it. Called out in future work.

## Future work (explicitly out of scope)

- Palette actions: `Open DM with <peer>`, `Join #<room>`, `Watch <peer>`.
- Search across message history (grep, jump-to-hit).
- Persistent history across sessions.
- Persistent scroll position across sessions.
- Message editing / deletion.
- Themes.

## Rollout

- Feature stays behind the existing `--experimental` flag. No default-on flip.
- Version bump in `chat-mcp/package.json` per the project convention.
- Manual smoke via the verification list above. Ship as a single PR (touching only `src/cli/ink/**`, `src/storage/dao.ts` for `listAllRooms`, and `package.json`).
