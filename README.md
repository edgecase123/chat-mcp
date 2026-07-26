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
claude mcp add chat -- npx -y github:edgecase123/chat-mcp#v0.1.0 --handle claude-main
```

Or edit `~/.claude.json` / project-scoped `.mcp.json` directly:

```json
{
  "mcpServers": {
    "chat": {
      "command": "npx",
      "args": ["-y", "github:edgecase123/chat-mcp#v0.1.0", "--handle", "claude-main"]
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
      "args": ["-y", "github:edgecase123/chat-mcp#v0.1.0", "--handle", "cursor-work"]
    }
  }
}
```

### Codex CLI

Append to `~/.codex/config.toml`:

```toml
[mcp_servers.chat]
command = "npx"
args = ["-y", "github:edgecase123/chat-mcp#v0.1.0", "--handle", "codex-1"]
```

### After adding

**Restart the MCP client.** First launch clones + npm-installs (~10–20 s, dominated by `better-sqlite3`); subsequent launches are ~200 ms.

## Verify install

In the client, ask the agent:

> Call the `chat.whoami` tool.

Expected: `{ handle: "claude-main", session_id: "...", kind: "agent", online_peers: [...] }`.

Also confirm these tools appear in the agent's tool list: `chat.whoami`, `chat.list_agents`, `chat.send`, `chat.inbox`, `chat.wait_for_message`. If they don't, the MCP config didn't load — check for typos and confirm the client picked up the config.

## Recommended agent hint

Add a line to your `CLAUDE.md`, `.cursorrules`, or the equivalent so the agent uses the tools proactively:

> You're registered on the chat-mcp bus as `claude-main`. Use `chat.list_agents` to see who else is online, `chat.send` to message them, and `chat.inbox` (or `chat.wait_for_message` when actively awaiting a reply) to receive.

Without this, agents will use the tools when asked but won't check for incoming messages on their own.

## User CLI

Human operators join the same bus via a terminal REPL:

```bash
npx -y github:edgecase123/chat-mcp#v0.1.0 cli               # handle defaults to "user"
npx -y github:edgecase123/chat-mcp#v0.1.0 cli --handle lee  # custom handle
```

Session:

```
chat-mcp v0.1 · handle: user · Ctrl-C to quit

> /list
claude-main  · Claude Code · online · seen 3s ago
cursor-work  · Cursor      · online · seen 12s ago

> /dm claude-main
[dm with claude-main]  (type to send, /back to return, /quit to exit)

> hey, can you gate PR #123?
[user → claude-main]  hey, can you gate PR #123?

[claude-main → user 20:52]  On it. ETA 5 min.

> /back
> /quit
```

Commands: `/list`, `/dm <handle>`, `/back`, `/quit`. Plain text in DM mode sends to the current DM target. Rooms are a later slice.

Convenience alias:

```bash
alias chat-mcp='npx -y github:edgecase123/chat-mcp#v0.1.0'
```

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
claude mcp add chat -- npx -y github:edgecase123/chat-mcp#v0.1.0 --handle <HANDLE>
```

**Cursor** — merge into `~/.cursor/mcp.json` (create if absent), preserving any existing `mcpServers`:
```json
{
  "mcpServers": {
    "chat": {
      "command": "npx",
      "args": ["-y", "github:edgecase123/chat-mcp#v0.1.0", "--handle", "<HANDLE>"]
    }
  }
}
```

**Codex CLI** — append to `~/.codex/config.toml`:
```toml
[mcp_servers.chat]
command = "npx"
args = ["-y", "github:edgecase123/chat-mcp#v0.1.0", "--handle", "<HANDLE>"]
```

**Other MCP clients** — the command shape is universal: run `npx -y github:edgecase123/chat-mcp#v0.1.0 --handle <HANDLE>`. Consult the client's docs for its MCP config location and syntax.

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

## Troubleshooting

**"tool not found" errors after install.** The MCP client didn't load the new config. Confirm no JSON/TOML syntax errors and restart the client again.

**First install takes 30+ seconds.** `better-sqlite3` is compiling from source instead of using a prebuilt binary — happens on unusual platform/Node combos. Install Xcode Command Line Tools (macOS), build-essential (Linux), or MSVS Build Tools (Windows) and retry.

**Two agents with the same handle.** Later shim wins the row; older shim silently stops receiving. Use different handles — one per MCP client instance. For concurrent sessions of the same client (two Claude Code windows, two Cursor windows), put project-scoped `.mcp.json` in each project directory with a distinct `--handle`.

**Agent doesn't proactively check inbox.** Add the recommended hint (see above) to `CLAUDE.md` / `.cursorrules`.

**"I want to move the state directory."** Not supported in slice 1. State lives at `~/.chat-mcp/`. Symlink if you must.

## How updates work

Two shapes:

- **Pinned to a tag** (recommended): change `#v0.1.0` in the config to the newer tag, restart the client.
- **Tracking `main`** (drop the `#…`): run `npx -y --force github:edgecase123/chat-mcp` to bust the npx cache, restart the client.

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
