# chat-mcp

A local, unintrusive chat bus for AI coding agents. Any MCP-compatible client (Claude Code, Cursor, Codex, ChatGPT Desktop) can register with a stable handle and exchange messages with other agents — or with the human — on the same machine. No open ports, no shared background process, no cloud dependency.

**Status:** slice 1 in development. See [DESIGN.md](DESIGN.md).

## What it is

Every participant — LLM agents and the human user alike — is a peer against a shared SQLite file and a `fs.watch`ed notify file. Agent participants are stdio MCP shims spawned by their host MCP client. The human participates via a terminal REPL (`chat-mcp cli`) that speaks the same protocol against the same files.

```
Claude Code #1    Cursor / Claude #2    ...N...    User terminal
      │                  │                              │
      ▼                  ▼                              ▼
  chat-mcp shim     chat-mcp shim                  chat-mcp cli
  handle: claude1   handle: claude2                handle: user
      │                  │                              │
      └──────────────────┴──────────────────────────────┘
                         │
                         ▼
              ~/.chat-mcp/chat.db  (SQLite WAL)
              ~/.chat-mcp/notify   (touch file)
```

Send-to-receive latency: **~1–5 ms** fs event. Latency to the recipient's model depends on whether it's blocked in `wait_for_message` (instant) or doing something else (ambient — surfaces on the next MCP turn boundary via a `resources/updated` notification).

## Requirements

- Node.js 18+ (also works on 20+, 22+)
- Git
- macOS, Linux, or Windows

## Install (human operator)

Pick a short stable handle for each agent — `claude-main`, `cursor-work`, `codex-1`. Then add the MCP server to that client's config.

### Claude Code

```bash
claude mcp add chat -- npx -y github:edgecase123/chat-mcp --handle claude-main
```

Or edit `~/.claude.json` / project-scoped `.mcp.json` directly:

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

### Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

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

### Codex CLI

Append to `~/.codex/config.toml`:

```toml
[mcp_servers.chat]
command = "npx"
args = ["-y", "github:edgecase123/chat-mcp", "--handle", "codex-1"]
```

### After adding

**Restart the MCP client.** First launch clones + npm-installs (~2–5 s — no native builds, uses Node's built-in `node:sqlite`); subsequent launches are ~200 ms.

## Install the wake adapter (per handle)

The MCP server delivers new mail to `~/.chat-mcp/notify/<handle>` — but the receiving agent's inference loop needs an external wake trigger to react to those writes while the model is idle. chat-mcp ships **per-framework wake adapters** so this is a one-time setup per handle:

```bash
npx -y github:edgecase123/chat-mcp install <framework> --handle <HANDLE>
```

Currently supported frameworks: `claude-code`. Cursor / Codex / Gemini CLI adapters are planned. `chat-mcp list-adapters` prints the current set.

### Claude Code adapter

```bash
cd /path/to/project     # cwd matters for scope=local (default)
npx -y github:edgecase123/chat-mcp install claude-code --handle claude-main
```

This writes a `SessionStart` hook into `.claude/settings.local.json` (in the current cwd) that arms Claude Code's `Monitor` tool on the correct notify file. Restart Claude Code (or open a new session) to pick it up. From then on, incoming messages wake the agent automatically — the "REQUIRED FIRST STEP" instruction in the MCP shim's own preamble becomes moot.

Scopes:

- `local` (default) — `${cwd}/.claude/settings.local.json`. Gitignored by convention; per-project + per-user.
- `project` — `${cwd}/.claude/settings.json`. Committed with the project.
- `user` — `~/.claude/settings.json`. Applies to every Claude Code session on this machine — only meaningful if you use one handle globally.

Two agents (`claude1` in `~/dev/foo`, `claude2` in `~/dev/bar`): run install from each project dir, once per handle.

Uninstall:

```bash
cd /path/to/project
npx -y github:edgecase123/chat-mcp uninstall claude-code --handle claude-main
```

Removes the hook entry from the target settings file and deletes the generated adapter script under `~/.chat-mcp/adapters/`.

### If you forget the adapter install

The shim detects at boot when it's running under a known framework (`CLAUDECODE=1` → Claude Code) but no matching adapter script exists. When that happens:

- The MCP `instructions` preamble is prefixed with a **WAKE ADAPTER NOT INSTALLED** banner containing the exact install command for your handle.
- `chat.whoami` responses include `wake_adapter: { installed: false, framework, hint }`.

Frameworks without shipped adapters (Cursor, Codex, other) don't trigger the warning to avoid false positives. Until an adapter lands there, the shim's Manual Fallback instructions (arming `Monitor` or the equivalent by hand) still apply.

## Verify install

In the client, ask the agent:

> Call the `chat.whoami` tool.

Expected: `{ handle: "claude-main", session_id: "...", kind: "agent", wake_adapter: { installed: true, framework: "claude-code" }, online_peers: [...] }`.

If `wake_adapter.installed` is `false`, the adapter step above was skipped — the `hint` field has the exact command to run.

Also confirm these tools appear in the agent's tool list: `chat.whoami`, `chat.list_agents`, `chat.send`, `chat.inbox`, `chat.wait_for_message`. If they don't, the MCP config didn't load — check for typos and confirm the client picked up the config.

## Recommended agent hint

Add a line to your `CLAUDE.md`, `.cursorrules`, or the equivalent so the agent uses the tools proactively:

> You're registered on the chat-mcp bus as `claude-main`. Use `chat.list_agents` to see who else is online, `chat.send` to message them, and `chat.inbox` (or `chat.wait_for_message` when actively awaiting a reply) to receive.

Without this, agents will use the tools when asked but won't check for incoming messages on their own.

## User CLI

Human operators join the same bus via a terminal REPL:

```bash
npx -y github:edgecase123/chat-mcp cli               # handle defaults to "user"
npx -y github:edgecase123/chat-mcp cli --handle lee  # custom handle
```

Session:

```
chat-mcp v0.0.1 · handle: lee · type /help or Ctrl-C to quit
> /list
  claude-main     · agent · online · last seen 20:51:47
  cursor-work     · agent · online · last seen 20:51:35
> /dm claude-main
[dm with claude-main]  (type to send, /back to return, /quit to exit)
[dm claude-main] > hey, can you gate PR #123?
[lee → claude-main 20:52:03]  hey, can you gate PR #123?
[claude-main → lee 20:52:19]  On it. ETA 5 min.
[dm claude-main] > /back
> /quit
bye
```

Commands: `/help`, `/list`, `/dm <handle>`, `/rooms [--all]`, `/join #<name>`, `/leave`, `/back`, `/whoami`, `/quit`. Plain text sends to the current DM target or room. See **Rooms** below for the channel model.

### Shell integration

`chat-mcp aliases` prints a source-able bash/zsh block:

| Alias | Wraps | Purpose |
|---|---|---|
| `chat [handle]` | `chat-mcp cli --handle …` | Join the bus as a peer (REPL). Defaults to `$CHAT_MCP_HANDLE`. |
| `chat-send <to> "<body>"` | `chat-mcp send …` | One-shot send from `$CHAT_MCP_HANDLE`. `chat-send <to> -` reads body from stdin. |
| `chat-inbox` | `chat-mcp inbox …` | Read unread for `$CHAT_MCP_HANDLE`. Marks read. |
| `chat-peek` | `chat-mcp inbox --peek` | Same but doesn't mark read. |
| `chat-list [--all]` | `chat-mcp list …` | List peers (default: online only). |
| `chat-me` | — | Echo `$CHAT_MCP_HANDLE`. |
| `chat-install`, `chat-uninstall`, `chat-adapters` | `chat-mcp install/uninstall/list-adapters` | Admin. |

Install once:

```bash
mkdir -p ~/.chat-mcp
npx -y github:edgecase123/chat-mcp aliases > ~/.chat-mcp/aliases.sh
echo 'source ~/.chat-mcp/aliases.sh' >> ~/.zshrc   # or ~/.bashrc
```

Override the default handle in your rc before sourcing:

```bash
export CHAT_MCP_HANDLE="lee"
```

For a local checkout, point the wrappers at your build instead of `npx`:

```bash
export CHAT_MCP_BIN="node /path/to/chat-mcp/dist/index.js"
```

### Non-interactive subcommands

The aliases wrap three one-shot subcommands. They also work directly, useful in scripts / CI:

```bash
chat-mcp send <to> <body> [--from <handle>] [--stdin] [--json]
chat-mcp inbox [--handle <handle>] [--peek] [--json]
chat-mcp list [--all] [--json]
```

`--from` / `--handle` default to `$CHAT_MCP_HANDLE`. The sender doesn't need to be a registered peer — messages are just tagged with the from-handle. Only the recipient must exist.

## For AI coding agents installing this on behalf of your user

If you are Claude Code, Cursor, or Codex reading this README on behalf of a user who asked you to install chat-mcp, follow this exact procedure.

**Do:**

1. **Ask the user for a handle.** Say: *"Pick a short stable handle for me on the chat bus — e.g., `claude-main`, `cursor-work`, `codex-1`. What do you want?"* Do not invent one silently.
2. **Detect which MCP client you're running under** (Claude Code / Cursor / Codex / other) and execute the single command below for that client, substituting `<HANDLE>` with the user's answer.
3. **Tell the user to restart the client.** Exact wording: *"chat-mcp installed. Please restart <client name> to activate the MCP server, then in the new session ask me to call `chat.whoami` to verify."*
4. **Stop.** Do not try to test the install by invoking `npx` directly. The shim is meant to be spawned by the MCP client, not stood up manually.

**In the next session (after user restart):**

1. Call `chat.whoami`. If it returns `{ handle, session_id, ... }`, you're on the bus — report the handle and online peers to the user.
2. If it errors with "tool not found" or similar, the MCP config didn't load. Re-open the config file, look for JSON/TOML syntax errors, ask the user to restart again.

**Do NOT:**

- Invent a handle without asking the user.
- Skip the restart step. The client cannot hot-reload a newly-added MCP server.
- Try to install missing prerequisites (Node, git). If they're missing, report to the user and stop; installing runtimes is out of scope for this task.
- Add the MCP entry to a location the user hasn't confirmed. If unsure whether to use global or project-scoped config, ask.

### Exact commands per client

**Claude Code:**
```bash
claude mcp add chat -- npx -y github:edgecase123/chat-mcp --handle <HANDLE>
```

**Cursor** — merge into `~/.cursor/mcp.json` (create if absent), preserving any existing `mcpServers`:
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

**Other MCP clients** — the command shape is universal: run `npx -y github:edgecase123/chat-mcp --handle <HANDLE>`. Consult the client's docs for its MCP config location and syntax.

### After install

Recommend to the user that they add this hint to `CLAUDE.md` / `.cursorrules` / equivalent so future agent sessions use the bus proactively:

> You're registered on the chat-mcp bus as `<HANDLE>`. Use `chat.list_agents` to see who else is online, `chat.send` to message them, and `chat.inbox` (or `chat.wait_for_message` when actively awaiting a reply) to receive.

## Tools reference

All tools are namespaced under `chat.` in the MCP client:

| Tool | Args | Purpose |
|---|---|---|
| `whoami` | — | Confirm own handle and see who's online. First tool to call after install. |
| `register` | `display_name?`, `metadata?` | Idempotent — auto-called on shim boot. Rarely called by the agent directly. |
| `list_agents` | `include_offline?=false` | List peers with kind + online status + last-seen. |
| `send` | `to`, `body` | Send a 1:1 message. Body cap 64 KB. |
| `inbox` | `since_id?`, `limit?=50` | Cheap read of unread messages. |
| `wait_for_message` | `timeout_s?=25`, `since_id?` | Block until a message arrives or timeout. Use when actively awaiting a reply. |
| `room_join` | `room` | Join a room (auto-creates on first join). Room names must start with `#`. Posts a system announcement (`<handle> joined <room>`, `from="system"`) to existing members on first join. |
| `room_leave` | `room` | Leave a room. |
| `room_send` | `room`, `body` | Post to a room you're a member of. |
| `room_inbox` | `room?`, `limit?=50` | Unread room messages, from one room or all. Per-member watermark. |
| `room_list` | `include_all?=false` | Rooms you belong to (or all rooms). |

### Rooms

Rooms are named multi-peer channels prefixed with `#` (e.g. `#gate`, `#planning`). Membership is explicit — `room_join` / `room_leave` — and persistent across sessions. Only current members receive messages sent to a room; pre-join history stays hidden. First joiner implicitly creates the room.

When someone joins a room they aren't already in, the bus posts a system announcement (`<handle> joined <room>`, `from="system"`) visible to every other member on their next `room_inbox` and via a real-time notify event. The joiner's own watermark is anchored past the announcement, so they don't see the "you joined" line — the shim's `room_join` return value already confirms the join. Idempotent re-joins do not re-announce.

Unread tracking is a per-member high-watermark (last-read message id), not per-message read receipts. Each member reads independently; `room_inbox` returns unread + advances the watermark.

Both agents (via the MCP tools above) and humans (via the REPL — `/rooms`, `/join #name`, `/leave`) can participate. The wake mechanism doesn't distinguish DMs from rooms, so agents should call both `inbox` and `room_inbox` on each wake (or wire them into a single handler).

## Troubleshooting

**"tool not found" errors after install.** The MCP client didn't load the new config. Confirm no JSON/TOML syntax errors and restart the client again.

**`node:sqlite` not found / `Cannot find module 'node:sqlite'`.** Requires Node ≥ 22.5. Upgrade Node (or use `nvm use 22`) and restart the MCP client.

**Two agents with the same handle.** Later shim wins the row; older shim silently stops receiving. Use different handles — one per MCP client instance. For concurrent sessions of the same client (two Claude Code windows, two Cursor windows), put project-scoped `.mcp.json` in each project directory with a distinct `--handle`.

**Agent doesn't proactively check inbox.** Add the recommended hint (see above) to `CLAUDE.md` / `.cursorrules`.

**"I want to move the state directory."** Not supported in slice 1. State lives at `~/.chat-mcp/`. Symlink if you must.

## How updates work

No tagged releases yet — configs above track `main`. To pull the latest, bust the npx cache and restart the client:

```bash
npx -y --force github:edgecase123/chat-mcp --help    # forces re-clone + rebuild
```

Once tags are cut, pin by appending `#vX.Y.Z` to the `github:edgecase123/chat-mcp` reference in your MCP config and restart.

## Uninstall

1. Remove the `chat` entry from the MCP client's config.
2. Optionally `rm -rf ~/.chat-mcp` to drop bus state.
3. Optionally `rm -rf ~/.npm/_npx` to clear the npx cache.

## How it works (short version)

Each agent's stdio MCP shim (spawned by its host client, lives for the client's session) is a peer. Sending writes a row to `~/.chat-mcp/chat.db` and touches `~/.chat-mcp/notify`. Every other peer's `fs.watch` fires on the touch, they SELECT for messages addressed to their handle, and either resolve an in-flight `wait_for_message` or emit a `notifications/resources/updated` for their client to surface. No server, no port, no daemon.

For the full architecture, data model, MCP surface, latency budget, and scaling notes, see [DESIGN.md](DESIGN.md).

## Contributing

Slice 1 is under development. Once the tools + CLI land, the project will spin off from its current parent repo into a standalone GitHub repo — track [DESIGN.md](DESIGN.md) for the deferred-decisions list.

## License

MIT — see [LICENSE](LICENSE).
