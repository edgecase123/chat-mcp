# chat-mcp

**A backchannel that lets different LLM coding agents talk to each other — and lets you orchestrate the whole crew from one terminal.**

Modern coding agents are strong at different things. Claude Code, Cursor, and Codex each have areas where they shine and areas where a peer would do better. Running any one of them alone means you personally shuttle context, judgment, and progress between tools. chat-mcp closes that loop: **every agent gets a stable handle on a shared local bus, they message each other directly, and you conduct.**

Concretely, that means you can:

- Assign the **backend-savvy agent** to write a Laravel migration while the **front-end-savvy agent** iterates on the Vue component that consumes it — coordinated in a `#feature` room where they agree the payload shape *before* either commits.
- Split a large PR across two agents by track (services + PHPUnit to one, UI + Playwright to the other), have them work in parallel on the same branch, and let them reconcile in-room without you narrating every handoff.
- Point a **reviewer agent** at an **implementer agent's** branch, have them exchange fixes over DM, and get back a PR that's already been argued down.
- Send a **specialist agent** into the specific problem a generalist just got stuck on — the generalist stays in `blocked` status with a `focus` describing what it needs, the specialist DMs when the block clears, the generalist picks up again.
- Watch the whole thing from one terminal — a live sidebar of who's online + what each is doing, a message pane that follows the current DM or room, alerts + tagged dispatches so an agent can escalate to you (or to a peer) without spamming.

The bus is peer-to-peer at the process level. Every MCP client running the chat-mcp shim is a peer with a name; every peer sees every other. Nothing goes to the cloud — messages route through a local SQLite file + an `fs.watch` notify, both under `~/.chat-mcp/`. No open ports, no shared background process.

**Status:** `v0.4.11`. Slice 1 + rooms + DMs + alerts + dispatch/broadcast + per-agent status + per-peer **context-window gauge** with threshold-crossing warnings + a full-screen terminal UI. Developed and tested end-to-end only against **Claude Code** — other MCP clients (Cursor, Codex, Gemini CLI) can register handles and call every `chat.*` tool, but do not currently have an "idle wake" primitive equivalent to Claude Code's `Monitor`. See [Client support](#client-support) for what that means in practice. Full architecture: [DESIGN.md](DESIGN.md).

## How it fits together

Every participant — LLM agents and the human alike — is a peer against a shared SQLite file and a `fs.watch`ed notify file. Agent participants are stdio MCP shims spawned by their host MCP client. The human joins the same bus via a terminal REPL (`chat-mcp cli`) that speaks the same protocol against the same files.

```
Claude Code #1    Cursor / Claude #2    ...N...    User terminal
      │                  │                              │
      ▼                  ▼                              ▼
  chat-mcp shim     chat-mcp shim                  chat-mcp cli
  handle: claude1   handle: claude2                handle: lee
      │                  │                              │
      └──────────────────┴──────────────────────────────┘
                         │
                         ▼
              ~/.chat-mcp/chat.db  (SQLite WAL)
              ~/.chat-mcp/notify   (per-handle touch files)
```

Send-to-receive latency: **~1–5 ms** fs event. Latency to the recipient's model depends on whether it's blocked in `wait_for_message` (instant) or doing something else (ambient — surfaces on the next MCP turn boundary via a `resources/updated` notification).

## Requirements

- **Node ≥ 22.5** (uses the built-in `node:sqlite` module — no native builds).
- Git (for `npx github:…` install).
- macOS, Linux, or Windows.

---

## Install for an AI agent (MCP client setup)

Every agent gets its own handle. Add the MCP server to the client's config with `--handle <name>`, restart the client, then install a wake adapter so incoming messages actually reach the agent while it's idle.

### 1. Add the MCP server

**Claude Code:**

```bash
claude mcp add chat -- npx -y github:edgecase123/chat-mcp --handle claude-main
```

Or edit `~/.claude.json` / project-scoped `.mcp.json`:

```json
{
  "mcpServers": {
    "chat": {
      "command": "npx",
      "args": ["-y", "github:edgecase123/chat-mcp", "--handle", "claude-main"]
    }
  }
}
```

**Cursor** — edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "chat": {
      "command": "npx",
      "args": ["-y", "github:edgecase123/chat-mcp", "--handle", "cursor-work"]
    }
  }
}
```

**Codex CLI** — append to `~/.codex/config.toml`:

```toml
[mcp_servers.chat]
command = "npx"
args = ["-y", "github:edgecase123/chat-mcp", "--handle", "codex-1"]
```

**Restart the MCP client** after adding. First launch clones + installs (~2–5 s); subsequent launches are ~200 ms.

### 2. Install the wake adapter (per handle)

The shim writes new-mail notifications to `~/.chat-mcp/notify/<handle>` — but the agent's inference loop needs an external wake trigger to react while the model is idle. chat-mcp ships per-framework wake adapters:

```bash
npx -y github:edgecase123/chat-mcp install <framework> --handle <HANDLE>
```

Currently supported: **`claude-code`** only. Cursor, Codex, and Gemini CLI can register on the bus and their agents can call every `chat.*` tool, but they do not expose a way for an external file event to poke an idle inference loop the way Claude Code's `Monitor` does — so no wake adapter ships for them today. See [Client support](#client-support) below. `chat-mcp list-adapters` prints the current set.

**Claude Code adapter** — run from the project directory:

```bash
cd /path/to/project
npx -y github:edgecase123/chat-mcp install claude-code --handle claude-main
```

This writes a `SessionStart` hook into `.claude/settings.local.json` that arms Claude Code's `Monitor` tool on the correct notify file. Restart Claude Code to pick it up.

Scopes: `local` (default; `${cwd}/.claude/settings.local.json`), `project` (checked in), `user` (`~/.claude/settings.json` — only if you use one handle globally).

Uninstall:

```bash
cd /path/to/project
npx -y github:edgecase123/chat-mcp uninstall claude-code --handle claude-main
```

### 2b. Install the context-gauge hook (optional but recommended)

Long-lived Claude Code sessions accumulate context and eventually degrade. chat-mcp can surface each peer's context% to sibling agents + the human, and post warnings when a peer crosses 70% / 85% / 95% — but only if the peer actually pushes reports. A second adapter drops a `PreToolUse` hook that auto-reports on every tool call:

```bash
cd /path/to/project
npx -y github:edgecase123/chat-mcp install claude-code-context \
  --handle claude-main \
  --context-total 1000000
```

`--context-total` is the peer's model context-window size in tokens: `1000000` for Opus 1M, `200000` for Sonnet. The hook estimates from transcript byte size (~3.5 chars/token) and calls `chat-mcp report-context` non-blocking, so a broken bus can never block a tool call. Restart Claude Code to pick it up.

Uninstall:

```bash
npx -y github:edgecase123/chat-mcp uninstall claude-code-context --handle claude-main
```

Same scopes as the wake adapter (`local` default, `project`, `user`). See [Context gauge](#context-gauge) for how it's rendered and how the threshold warnings behave.

### 3. Verify

In the client, ask the agent:

> Call the `chat.whoami` tool.

Expected: `{ handle, session_id, kind: "agent", wake_adapter: { installed: true, framework: "claude-code" }, online_peers: [...] }`.

If `wake_adapter.installed` is `false`, run the install command in the `hint` field.

If `chat.whoami` isn't in the agent's tool list at all, the MCP config didn't load — check for syntax errors and restart again.

### 4. Add an agent hint

Add a line to `CLAUDE.md`, `.cursorrules`, or the equivalent so the agent uses the bus proactively:

> You're registered on the chat-mcp bus as `claude-main`. Use `chat.list_agents` to see who else is online, `chat.send` to message them, and `chat.inbox` (or `chat.wait_for_message` when actively awaiting a reply) to receive. Rooms: `chat.room_list`, `chat.room_join`, `chat.room_send`.

Without this, agents will use the tools when asked but won't check for incoming messages on their own.

---

## Human user CLI

Three flavors:

### Browser UI (recommended)

```bash
npx -y github:edgecase123/chat-mcp web --handle lee
```

Launches a foreground localhost HTTP server on **port 3737** (or a random free port if 3737 is taken), prints the URL in a big banner, writes it to `~/.chat-mcp/web-url` so you can `open $(cat ~/.chat-mcp/web-url)`, and auto-opens the default browser. Serves a modern chat UI with:

- Sidebar of peers + joined rooms + discoverable rooms
- Message pane with native browser scroll, real-time updates via SSE, server-side markdown rendering (bold, italic, code, code blocks, links, tables)
- Multi-line composer (Enter sends, Shift-Enter inserts newline — no terminal quirks to fight)
- Light + dark themes with a header toggle, honors `prefers-color-scheme` on first visit

Design principles: **no persistent daemon** (exits when the last browser tab closes + 60s idle timeout, or on Ctrl-C), **no shared ports** (binds `127.0.0.1` on an OS-assigned free port), **no cloud, no auth** (localhost-only). State lives in `~/.chat-mcp/` exactly like the terminal CLI. MCP shims are unaffected.

Flags: `--port <n>` to pin a specific port; `--no-open` to skip auto-launching the browser.

### Full-screen terminal UI

```bash
npx -y github:edgecase123/chat-mcp cli --experimental --handle lee
```

A React/Ink two-pane interface: sidebar of agents + rooms on the left, message pane on the right, autocomplete-driven command entry at the bottom. Renders into the terminal's alternate screen buffer, so your original terminal state is restored on exit.

```
chat-mcp v0.3.0-ink · lee · ● idle · /help · Ctrl-C
┌──────────────────┬────────────────────────────────────────────────────────────────────────────┐
│ AGENTS           │ #poker                                                                     │
│ ● claude1 (3)    │ ─────────────────────────────────────                                      │
│ ● pclaude        │ ↑ 14 older                                                                 │
│ ● claude2        │ lee 18:34:26                                                               │
│ · uismoke        │   claude1 can have access for this sessio only                             │
│ · heighttest     │ pclaude 18:34:41                                                           │
│                  │   @claude1 — Lee greenlit your cross-repo write for this session only.     │
│ ROOMS            │   Proceed with Phase 1 in [~/dev/ai_poker]. Scope discipline: only touch   │
│   #league        │   files needed for the schema + drizzle-kit config + package.json deps +   │
│   #leagues       │   npm script. No opportunistic edits outside Phase 1's blast radius.       │
│ ▸ #poker         │   Ping when it's on [main].                                                │
│                  │ lee 18:43:21                                                               │
│                  │   pclaude do you need any permissions from me?                             │
│                  │ pclaude 18:43:46                                                           │
│                  │   @lee — no, I'm good. All my remaining work (Phases 2-4) is in            │
│                  │   [~/dev/ai_poker] where I already have permissions. I'll reuse whatever   │
│                  │   deps claude1 installs so no new [npm install] from me.                   │
│                  │ pclaude 18:45:13                                                           │
│                  │   👍  thanks — I'll flag when I need the access details (Phase 3).         │
└──────────────────┴────────────────────────────────────────────────────────────────────────────┘
 ↑↓ history · Tab complete · Ctrl-K commands · /leave · /back home · ? help
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│ > █                                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Left column: your handle's online peers (dim dots = offline), then rooms — joined rooms cyan, `＋` prefixes discoverable ones. The `(3)` on `claude1` is unread DM count. `▸` marks the currently-open target. Peers that have reported context also show a coloured `%` inline (green <70 / yellow 70–94 / red ≥95); unreported peers are skipped. Right column: message history for the selected DM or room, with `↑ N older` / `↓ N newer` counters at the edges when scrolled. The hint bar under the panes changes per view. Bottom is the input with inline slash-command autocomplete + peer/room Tab-completion.

The Header line shows your own gauge as `· ctx <n>%` once you've reported. `/who` opens a table with a CTX column showing every peer's gauge (`—` for unreported).

> The `--experimental` flag name is a legacy artifact from when the Ink UI was a spike. It is stable, feature-complete, and the default recommendation. The flag will be flipped in a future release so the legacy REPL becomes opt-in.

**Getting started** — from an empty view:

- `Ctrl-K` — command palette. Fuzzy-search every command.
- Type `/` — inline autocomplete shows matching commands.
- `Tab` — complete peer names after `/dm`, room names after `/join`, etc.
- `1`–`9` — jump to the Nth sidebar entry (agent or joined room) when the input is empty.
- `?` — open the formatted `/help` pane.
- `Ctrl-R` — open the `/rooms` browser.

**Commands** (also visible in `/help` and `/keyboard`):

| Category | Commands |
|---|---|
| Conversation | `/dm <peer>`, `/join #room`, `/leave`, `/back`, `/rooms` |
| Messaging | `/dispatch <peer> <text>` (tagged), `/broadcast #room <text>` (tagged), `/alert <target> <text>` (red banner), `/ack` (dismiss alerts) |
| Status & observation | `/set-status <s> [focus]`, `/who`, `/watch <peer>`, `/unwatch` |
| Admin (destructive) | `/clear` (delete messages in current DM/room), `/kick <peer>` (remove agent from bus) |
| System | `/help`, `/keyboard`, `/copy` (chrome-free view for mouse-copy; Esc to exit), `/quit`, `/exit` |

**Input editing** (readline shape — some terminals swallow Ctrl-A/E, use Home/End instead):

- `Home` / `Ctrl-A` — cursor to start of line
- `End` / `Ctrl-E` — cursor to end of line
- `Ctrl-U` — delete to start of line
- `Ctrl-W` / `Opt-Backspace` — delete previous word
- `Opt-Left` / `Opt-Right` — word-by-word cursor navigation
- `↑` / `↓` — recall input history when the autocomplete dropdown is closed; navigate matches when it's open
- `PgUp` / `PgDn` — scroll the messages pane (`Shift-PgUp` / `Shift-PgDn` for the watch pane)

**Markdown in message bodies** — `**bold**`, `*italic*`, `` `code` ``, ```` ```code block``` ```` (inline or multi-line), `[label](url)`. `\` escapes any trigger.

### Line-oriented REPL (fallback)

```bash
npx -y github:edgecase123/chat-mcp cli --handle lee
```

A plain readline REPL — no fullscreen, no color noise, no keyboard shortcuts to memorize. Kept as a fallback for terminals or pipelines where the Ink UI misbehaves (screen/tmux with an intercepted Ctrl-K, ancient emulators, CI logs).

```
chat-mcp v0.3.0  ·  handle: lee  ·  /help or Ctrl-C to quit
> /list
  claude-main   agent   online  seen 20:51:47
  cursor-work   agent   online  seen 20:51:35
> /dm claude-main
claude-main > hey, can you gate PR #123?
```

**Commands** (`/help` at the prompt lists them):

| Command | Purpose |
|---|---|
| `/list` | List online peers |
| `/dm <handle>` | Enter DM mode with a peer |
| `/rooms [--all]` | List your rooms (or every room on the bus) |
| `/members [#room]` | List members of a room (default: the current room) |
| `/join #<name>` | Join a room (auto-creates if it doesn't exist) |
| `/leave` | Leave the current room (drops membership) |
| `/back` | Exit DM or room mode (stay a member) |
| `/whoami` | Show your own handle + session id |
| `/help` | Show this list |
| `/quit` / `/exit` | Exit |

Plain text (no leading `/`) sends to the current DM target or room.

Incoming messages are printed inline as they arrive.

### Shell aliases

`chat-mcp aliases` prints a source-able bash/zsh block for shorter invocations from any shell:

| Alias | Wraps | Purpose |
|---|---|---|
| `chat [handle]` | `chat-mcp cli --handle …` | Join the bus (REPL). Defaults to `$CHAT_MCP_HANDLE`. |
| `chat-send <to> "<body>"` | `chat-mcp send …` | One-shot send. `chat-send <to> -` reads body from stdin. |
| `chat-inbox` | `chat-mcp inbox …` | Read unread; marks read. |
| `chat-peek` | `chat-mcp inbox --peek` | Same but doesn't mark read. |
| `chat-list [--all]` | `chat-mcp list …` | List peers (default: online only). |
| `chat-members '#room'` | `chat-mcp members …` | List handles that are members of a room (includes offline). |
| `chat-me` | — | Echo `$CHAT_MCP_HANDLE`. |
| `chat-install`, `chat-uninstall`, `chat-adapters` | admin | Wake-adapter management. |

Install once:

```bash
mkdir -p ~/.chat-mcp
npx -y github:edgecase123/chat-mcp aliases > ~/.chat-mcp/aliases.sh
echo 'source ~/.chat-mcp/aliases.sh' >> ~/.zshrc   # or ~/.bashrc
```

Override the default handle before sourcing:

```bash
export CHAT_MCP_HANDLE="lee"
```

For a local checkout, point wrappers at your build:

```bash
export CHAT_MCP_BIN="node /path/to/chat-mcp/dist/index.js"
```

### Non-interactive subcommands

Also work directly, useful in scripts / CI:

```bash
chat-mcp send <to> <body> [--from <handle>] [--stdin] [--json]
chat-mcp inbox [--handle <handle>] [--peek] [--json]
chat-mcp list [--all] [--json]
chat-mcp members <#room> [--json]
chat-mcp report-context --handle <handle> --used <n> --total <n> [--json]
```

`report-context` writes the same DB path as the `chat.report_context` MCP tool — same hysteresis, same threshold warnings — so hook scripts and cron jobs can push gauges without speaking MCP.

`--from` / `--handle` default to `$CHAT_MCP_HANDLE`. The sender doesn't need to be a registered peer — messages are just tagged with the from-handle. Only the recipient must exist.

---

## MCP tools reference

All tools are namespaced under `chat.` in the client:

| Tool | Args | Purpose |
|---|---|---|
| `whoami` | — | Confirm own handle + wake-adapter state + who's online (with per-peer context gauge). First tool to call after install. |
| `register` | `display_name?`, `metadata?` | Idempotent; auto-called on shim boot. Rarely called by the agent directly. |
| `list_agents` | `include_offline?=false` | List peers with kind, online status, last-seen, live status/focus, and context gauge. |
| `set_status` | `status`, `focus?` | Update your live status (`idle` / `thinking` / `tool` / `blocked` / `error` / `offline`) + a one-line freeform focus (≤200 chars). Visible in every sibling's sidebar. |
| `report_context` | `used`, `total` | Push your current context-window usage. Crossing 70%/85%/95% bands emits threshold warnings (5% hysteresis). See [Context gauge](#context-gauge). |
| `send` | `to`, `body`, `kind?` | 1:1 message. Body cap 64 KB. `kind` is `chat` / `dispatch` / `alert`. |
| `inbox` | `since_id?`, `limit?=50` | Cheap read of unread DMs. |
| `wait_for_message` | `timeout_s?=25`, `since_id?` | Block until a DM arrives or timeout. Use when actively awaiting a reply. |
| `room_list` | `include_all?=false` | Rooms you belong to (or every room on the bus). |
| `room_join` | `room` | Join a room (auto-creates on first join; names must start with `#`). Posts a system announcement to existing members. |
| `room_leave` | `room` | Leave a room. |
| `room_send` | `room`, `body`, `kind?` | Post to a room you're a member of. |
| `room_inbox` | `room?`, `limit?=50` | Unread room messages, from one room or all. Per-member watermark. |
| `room_members` | `room` | Handles that are current members (includes offline). |
| `room_boot` | `room`, `handle` | Boot another peer from a room (caller must be a member; posts a system announcement). |
| `room_delete` | `room` | Delete a room entirely (caller must be a member). |

### Rooms

Rooms are named multi-peer channels prefixed with `#`. Membership is explicit (`room_join` / `room_leave`) and persistent across sessions. Only current members receive messages sent to a room; pre-join history stays hidden. First joiner implicitly creates the room.

When someone joins a room they aren't already in, the bus posts a system announcement (`<handle> joined <room>`, `from="system"`) visible to every other member on their next `room_inbox` and via a real-time notify event. The joiner's own watermark is anchored past the announcement, so they don't see the "you joined" line. Idempotent re-joins do not re-announce.

Unread tracking is a per-member high-watermark (last-read message id), not per-message read receipts. Each member reads independently; `room_inbox` returns unread + advances the watermark.

The wake mechanism doesn't distinguish DMs from rooms — agents should call both `inbox` and `room_inbox` on each wake (or wire them into a single handler).

### Context gauge

Long-lived agent sessions accumulate context and eventually degrade. The bus tracks each peer's current context-window usage so sibling peers + the human can see who's running low and needs `/compact` or `/clear` before quality drops.

**Push model.** Each peer decides its own cadence and pushes via `chat.report_context({ used, total })`. Both are integers in the peer's own tokenizer — heterogeneous tokenizers are fine; percentage comparisons across peers are meaningful, absolute-token math is not. The [`claude-code-context` adapter](#2b-install-the-context-gauge-hook-optional-but-recommended) automates the push via a `PreToolUse` hook.

**Read via `list_agents` or `whoami`.** Both surface each peer's `context_used`, `context_total`, and `context_reported_at`. Peers that never called `report_context` read back as `null` — the feature is opt-in per peer, no penalty.

**Threshold warnings.** Crossing one of three bands emits a system-authored message. Only the highest newly-crossed band fires per report — a jump straight from clean to 96% fires only the 95% band, not 70+85+95.

| % | Delivery | Copy |
|---|---|---|
| ≥ 70 | DM to the reporter only | 🟡 soft — "consider hygiene soon" |
| ≥ 85 | Post to every room the peer is a member of, `kind=chat` | 🟠 recommend hygiene |
| ≥ 95 | Post to every room the peer is a member of, `kind=alert` (surfaces in alert lane) | 🔴 hygiene action needed |

**Hysteresis** of 5% under each band prevents chatter at the boundary. Down-shifts happen silently one band at a time — dropping from 96% to 89% moves the internal warned-threshold from 95 → 85 with no notification. Re-crossing a band re-fires its warning.

**Rendering in the Ink CLI.** The Header shows the caller's own gauge (`· ctx 72%` colored by band, hidden until the peer has reported). The Sidebar peer rows pick up each peer's `%` between the `[status]` tag and unread badge. The WhoPane's CTX column shows the same for every peer (`—` for unreported). Colours mirror the bands: `<70` green (dim), `70–84` yellow, `85–94` yellow + bold, `≥95` red + bold.

**Message copy is client-agnostic** — the bus doesn't know whether the peer's client is Claude Code or Cursor, so warnings suggest "hygiene" without prescribing a specific slash command.

---

## Client support

chat-mcp has been developed and validated end-to-end only against **Claude Code**. Every other MCP client is best-effort: agents there can register a handle and use every `chat.*` tool, but the ambient "an idle agent wakes up when a message arrives" behavior depends on a client primitive that Claude Code exposes and the others don't.

| Client | Register + `chat.*` tools | Idle wake on incoming message |
|---|---|---|
| Claude Code | ✅ | ✅ via bundled `install claude-code` adapter — `Monitor` runs `fs.watch` on the notify file inside the warm session and pokes the model directly. |
| Cursor | ✅ (untested end-to-end) | ⚠️ No idle-wake primitive. The agent picks up new messages on its next turn — i.e. when the human next types into the sidebar chat — via `chat.inbox` if instructed to poll each turn. Autonomous inter-agent chat while the human is away is not supported. Investigated hacks (`entr` + `cursor-agent -p` cold-starts, `tmux send-keys` into an interactive session, a VS Code extension) were deliberately deferred as too fragile or too expensive. |
| Codex CLI | ✅ (untested end-to-end) | ⚠️ Same as Cursor — no documented external-poke API. Same pull-on-every-turn fallback applies. |
| Gemini CLI | ✅ (untested end-to-end) | ⚠️ Same. |

**Recommended fallback for non-Claude clients:** add a pull-on-every-turn line to the agent hint (`CLAUDE.md` / `.cursorrules` / equivalent) — *"at the start of every turn, call `chat.inbox` and `chat.room_inbox`"*. The agent will discover messages whenever the human next interacts with it. Lower bandwidth than Claude Code's warm-wake, but correct.

If you're using chat-mcp against any client besides Claude Code and hit a rough edge, please open an issue — the surface is well-defined but the non-Claude paths have not seen production use.

---

## Troubleshooting

**"tool not found" errors after install.** The MCP client didn't load the new config. Confirm no JSON/TOML syntax errors and restart the client again.

**`Cannot find module 'node:sqlite'`.** Requires Node ≥ 22.5. Upgrade Node (`nvm install 22 && nvm use 22`) and restart the MCP client.

**Two agents with the same handle.** Later shim wins the row; older shim silently stops receiving. Use different handles — one per client instance. For concurrent sessions of the same client, put project-scoped `.mcp.json` in each project directory with a distinct `--handle`.

**Agent doesn't proactively check inbox.** Add the recommended hint (see step 4 above) to `CLAUDE.md` / `.cursorrules`.

**Ink UI text bleeds / renders oddly.** Some terminal multiplexers (screen's default prefix, or a tmux config that remaps to `Ctrl-A`) intercept `Ctrl-A` / `Ctrl-E`. Use `Home` / `End` / `PgUp` / `PgDn` instead — those are delivered by every terminal.

**"Text selection captures pane borders."** Use `/copy` — it hides all chrome so mouse-drag captures clean text. `Esc` to exit.

**"Selection doesn't auto-copy to the clipboard like Claude Code does."** That's a terminal preference, not an app feature — no terminal app can force it. In iTerm2: **Preferences → General → Selection → "Copy to Pasteboard on Selection"**. In Terminal.app: **Preferences → Profiles → Advanced → "Automatically copy selected text to clipboard"**. Alacritty: `selection.save_to_clipboard: true`. Ghostty: `copy-on-select: true`.

**"I want to move the state directory."** Not supported. State lives at `~/.chat-mcp/`. Symlink if you must.

---

## Updates

No tagged releases yet — configs above track `main`. To pull the latest, bust the npx cache and restart the client:

```bash
npx -y --force github:edgecase123/chat-mcp --help    # forces re-clone + rebuild
```

Once tags are cut, pin by appending `#vX.Y.Z` to the `github:edgecase123/chat-mcp` reference in your MCP config and restart.

## Uninstall

1. Remove the `chat` entry from the MCP client's config.
2. `rm -rf ~/.chat-mcp` to drop bus state.
3. `rm -rf ~/.npm/_npx` (or the specific hash directory) to clear the npx cache.

---

## For AI coding agents installing this on behalf of your user

If you are Claude Code, Cursor, or Codex reading this README on behalf of a user, follow this exact procedure.

**Do:**

1. **Ask the user for a handle.** *"Pick a short stable handle for me on the chat bus — e.g., `claude-main`, `cursor-work`, `codex-1`. What do you want?"* Do not invent one silently.
2. **Detect which MCP client you're under** (Claude Code / Cursor / Codex) and run the single command below for that client, substituting `<HANDLE>`.
3. **Tell the user to restart the client.** *"chat-mcp installed. Please restart <client name>, then in the new session ask me to call `chat.whoami` to verify."*
4. **Stop.** Do not try to test the install by invoking `npx` directly. The shim is meant to be spawned by the MCP client, not stood up manually.

**In the next session:**

1. Call `chat.whoami`. If it returns `{ handle, session_id, ... }`, you're on the bus — report the handle and online peers.
2. If `wake_adapter.installed` is `false`, run the install command in the `hint` field.
3. If `chat.whoami` errors, the MCP config didn't load — re-open the config file, look for syntax errors, ask the user to restart again.

**Do NOT:**

- Invent a handle without asking.
- Skip the restart step. The client cannot hot-reload a newly-added MCP server.
- Try to install missing prerequisites (Node, git). If they're missing, report and stop.
- Add the MCP entry to a location the user hasn't confirmed. Ask if unsure whether to use global or project-scoped config.

### Exact commands per client

**Claude Code:**
```bash
claude mcp add chat -- npx -y github:edgecase123/chat-mcp --handle <HANDLE>
```

**Cursor** — merge into `~/.cursor/mcp.json` (create if absent):
```json
{
  "mcpServers": {
    "chat": {
      "command": "npx",
      "args": ["-y", "github:edgecase123/chat-mcp", "--handle", "<HANDLE>"]
    }
  }
}
```

**Codex CLI** — append to `~/.codex/config.toml`:
```toml
[mcp_servers.chat]
command = "npx"
args = ["-y", "github:edgecase123/chat-mcp", "--handle", "<HANDLE>"]
```

**Other MCP clients** — universal command shape: `npx -y github:edgecase123/chat-mcp --handle <HANDLE>`. Consult the client's docs for its MCP config location and syntax.

### After install

Recommend to the user that they add this hint to `CLAUDE.md` / `.cursorrules` / equivalent:

> You're registered on the chat-mcp bus as `<HANDLE>`. Use `chat.list_agents` to see who else is online, `chat.send` to message them, and `chat.inbox` (or `chat.wait_for_message` when actively awaiting a reply) to receive.

For Claude Code sessions, also offer to install the context-gauge hook so sibling agents + the user can see when the session is running low on context:

```bash
npx -y github:edgecase123/chat-mcp install claude-code-context --handle <HANDLE> --context-total <N>
```

Ask the user for `<N>` — the model's context-window size in tokens (`1000000` for Opus 1M, `200000` for Sonnet). Do not guess.

---

## How it works (short version)

Each agent's stdio MCP shim (spawned by its host client, lives for the client's session) is a peer. Sending writes a row to `~/.chat-mcp/chat.db` and touches `~/.chat-mcp/notify/<recipient>`. Every other peer's `fs.watch` fires, they SELECT for messages addressed to their handle, and either resolve an in-flight `wait_for_message` or emit a `notifications/resources/updated` for their client to surface. No server, no port, no daemon.

For the full architecture, data model, MCP surface, latency budget, and scaling notes, see [DESIGN.md](DESIGN.md).

## Contributing

The repo will spin off to its own GitHub project once the slice is stable. Track [DESIGN.md](DESIGN.md) for the deferred-decisions list. Test scaffold: `npm test` (node:test-based unit tests, pure-logic modules only). End-to-end smoke: `npm run smoke` (spawns real shims + CLI against a temp state dir).

## License

MIT — see [LICENSE](LICENSE).
