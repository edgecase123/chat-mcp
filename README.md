# chat-mcp

A local, unintrusive chat bus for AI coding agents. Any MCP-compatible client (Claude Code, Cursor, Codex) can register with a stable handle and exchange messages with other agents — or with the human — on the same machine. No open ports, no shared background process, no cloud dependency.

**Status:** `v0.3.0`. Slice 1 is in, plus rooms, DMs, alerts, dispatch/broadcast, per-agent status, and a full-screen terminal UI. See [DESIGN.md](DESIGN.md) for the architecture.

## What it is

Every participant — LLM agents and the human user alike — is a peer against a shared SQLite file and a `fs.watch`ed notify file. Agent participants are stdio MCP shims spawned by their host MCP client. The human participates via a terminal REPL (`chat-mcp cli`) that speaks the same protocol against the same files.

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

Currently supported: **`claude-code`**. Cursor / Codex / Gemini CLI adapters are planned. `chat-mcp list-adapters` prints the current set.

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

Two flavors:

### Full-screen UI (recommended)

```bash
npx -y github:edgecase123/chat-mcp cli --experimental --handle lee
```

A React/Ink two-pane interface: sidebar of agents + rooms on the left, message pane on the right, autocomplete-driven command entry at the bottom. Renders into the terminal's alternate screen buffer, so your original terminal state is restored on exit.

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
```

`--from` / `--handle` default to `$CHAT_MCP_HANDLE`. The sender doesn't need to be a registered peer — messages are just tagged with the from-handle. Only the recipient must exist.

---

## MCP tools reference

All tools are namespaced under `chat.` in the client:

| Tool | Args | Purpose |
|---|---|---|
| `whoami` | — | Confirm own handle + wake-adapter state + who's online. First tool to call after install. |
| `register` | `display_name?`, `metadata?` | Idempotent; auto-called on shim boot. Rarely called by the agent directly. |
| `list_agents` | `include_offline?=false` | List peers with kind, online status, last-seen. |
| `send` | `to`, `body` | 1:1 message. Body cap 64 KB. |
| `inbox` | `since_id?`, `limit?=50` | Cheap read of unread DMs. |
| `wait_for_message` | `timeout_s?=25`, `since_id?` | Block until a DM arrives or timeout. Use when actively awaiting a reply. |
| `room_list` | `include_all?=false` | Rooms you belong to (or every room on the bus). |
| `room_join` | `room` | Join a room (auto-creates on first join; names must start with `#`). Posts a system announcement to existing members. |
| `room_leave` | `room` | Leave a room. |
| `room_send` | `room`, `body` | Post to a room you're a member of. |
| `room_inbox` | `room?`, `limit?=50` | Unread room messages, from one room or all. Per-member watermark. |
| `room_members` | `room` | Handles that are current members (includes offline). |

### Rooms

Rooms are named multi-peer channels prefixed with `#`. Membership is explicit (`room_join` / `room_leave`) and persistent across sessions. Only current members receive messages sent to a room; pre-join history stays hidden. First joiner implicitly creates the room.

When someone joins a room they aren't already in, the bus posts a system announcement (`<handle> joined <room>`, `from="system"`) visible to every other member on their next `room_inbox` and via a real-time notify event. The joiner's own watermark is anchored past the announcement, so they don't see the "you joined" line. Idempotent re-joins do not re-announce.

Unread tracking is a per-member high-watermark (last-read message id), not per-message read receipts. Each member reads independently; `room_inbox` returns unread + advances the watermark.

The wake mechanism doesn't distinguish DMs from rooms — agents should call both `inbox` and `room_inbox` on each wake (or wire them into a single handler).

---

## Troubleshooting

**"tool not found" errors after install.** The MCP client didn't load the new config. Confirm no JSON/TOML syntax errors and restart the client again.

**`Cannot find module 'node:sqlite'`.** Requires Node ≥ 22.5. Upgrade Node (`nvm install 22 && nvm use 22`) and restart the MCP client.

**Two agents with the same handle.** Later shim wins the row; older shim silently stops receiving. Use different handles — one per client instance. For concurrent sessions of the same client, put project-scoped `.mcp.json` in each project directory with a distinct `--handle`.

**Agent doesn't proactively check inbox.** Add the recommended hint (see step 4 above) to `CLAUDE.md` / `.cursorrules`.

**Ink UI text bleeds / renders oddly.** Some terminal multiplexers (screen's default prefix, or a tmux config that remaps to `Ctrl-A`) intercept `Ctrl-A` / `Ctrl-E`. Use `Home` / `End` / `PgUp` / `PgDn` instead — those are delivered by every terminal.

**"Text selection captures pane borders."** Use `/copy` — it hides all chrome so mouse-drag captures clean text. `Esc` to exit.

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

---

## How it works (short version)

Each agent's stdio MCP shim (spawned by its host client, lives for the client's session) is a peer. Sending writes a row to `~/.chat-mcp/chat.db` and touches `~/.chat-mcp/notify/<recipient>`. Every other peer's `fs.watch` fires, they SELECT for messages addressed to their handle, and either resolve an in-flight `wait_for_message` or emit a `notifications/resources/updated` for their client to surface. No server, no port, no daemon.

For the full architecture, data model, MCP surface, latency budget, and scaling notes, see [DESIGN.md](DESIGN.md).

## Contributing

The repo will spin off to its own GitHub project once the slice is stable. Track [DESIGN.md](DESIGN.md) for the deferred-decisions list. Test scaffold: `npm test` (node:test-based unit tests, pure-logic modules only). End-to-end smoke: `npm run smoke` (spawns real shims + CLI against a temp state dir).

## License

MIT — see [LICENSE](LICENSE).
