# chat-mcp — Design (Slice 1)

**Status:** design draft, approved 2026-07-25.
**Location:** private experiment inside `~/dev/leagues2/chat-mcp/`, gitignored, will spin off to its own repo once slice 1 is working.

## Goal

Two MCP-compatible agents plus the human user, all on one machine, can register with stable handles and exchange 1:1 messages in near-realtime, with **no shared background process** and **no open network port at any layer**. The user participates via a terminal CLI; agents participate via stdio MCP shims spawned by their host clients.

## Non-goals (slice 1)

Rooms, group messaging, room-chat CLI commands (`/enter`, `/who`, `/rooms`), any browser or web UI, cross-machine transport, auth/permissions between agents, message attachments, message search, presence pings, message editing/deletion, cross-vendor conformance testing beyond a Claude Code + Cursor smoke test. All deferred to later slices.

**Explicit non-goal:** any browser or HTTP-based user interface. The user participates via a CLI subsystem (see below). No port is ever opened, at any slice.

## Constraints

- **Unintrusive.** No open ports, no always-on background process, no firewall prompt at rest.
- **Cross-vendor.** Any MCP-compatible client (Claude Code, Cursor, ChatGPT / Codex, etc.) must be able to participate.
- **Easy uninstall.** State lives in one directory (`~/.chat-mcp/`); removing it and the MCP client entries fully uninstalls.
- **N participants.** No hard cap. The two-Claude/one-user shape is the smallest interesting case, not the ceiling; the same code path serves 2, 10, or 100 peers without changes. See [Scaling](#scaling) for the practical ceiling and where the next bottleneck sits.

## Architecture

```
┌──────────────────┐   ┌──────────────────┐         ┌──────────────────┐
│  Claude Code #1  │   │ Cursor / Claude 2│  … N …  │   User terminal  │
│ (MCP client)     │   │ (MCP client)     │         │ chat-mcp cli     │
└────────┬─────────┘   └────────┬─────────┘         └────────┬─────────┘
         │ stdio                │ stdio                      │ (in-process)
         ▼                      ▼                            ▼
┌──────────────────┐   ┌──────────────────┐         ┌──────────────────┐
│ chat-mcp shim    │   │ chat-mcp shim    │  … N …  │ chat-mcp cli     │
│ handle = claude1 │   │ handle = claude2 │         │ handle = user    │
│ fs.watch(notify) │   │ fs.watch(notify) │         │ fs.watch(notify) │
└────────┬─────────┘   └────────┬─────────┘         └────────┬─────────┘
         │                      │                            │
         └──────────────────────┼────────────────────────────┘
                                ▼
                    ┌─────────────────────────┐
                    │  ~/.chat-mcp/           │
                    │    chat.db  (SQLite WAL)│
                    │    notify   (touch file)│
                    └─────────────────────────┘
```

**No shared daemon, no ports.** Every participant is a peer that reads and writes the same SQLite file and watches the same notify file. Agent participants are stdio MCP shims spawned by an MCP client (Claude Code, Cursor, Codex, etc.); the user participant is a terminal process (`chat-mcp cli`) that follows the same protocol against the same files. **The 3-peer diagram is illustrative — N peers is the shape.**

### Why this shape

MCP servers are already stdio processes per client. Rather than adding a second, shared process, we reuse the per-client shim as the "daemon" — it's already long-lived from the client's perspective, and there is one per participating agent. The user's CLI is an ordinary peer against the same substrate; no special-cased "human channel." Coordination happens through the filesystem, which every peer can reach without opening a port.

## Data model (SQLite, WAL mode, `~/.chat-mcp/chat.db`)

Throughout the schema and MCP surface, **"agent" means any peer on the bus** — LLM shims and the user CLI alike. There is no distinct "user" concept; the user CLI is an agent with `metadata.kind = "human"`.

```sql
CREATE TABLE agents (
  handle        TEXT PRIMARY KEY,
  display_name  TEXT,
  pid           INTEGER,          -- shim process pid
  session_id    TEXT NOT NULL,    -- new UUID per shim boot
  registered_at INTEGER NOT NULL, -- unix ms
  last_seen_at  INTEGER NOT NULL, -- unix ms
  metadata_json TEXT              -- capabilities, agent kind, arbitrary
);

CREATE TABLE messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_handle  TEXT NOT NULL,
  to_handle    TEXT NOT NULL,     -- slice 1: 1:1 only; rooms later
  body         TEXT NOT NULL,
  sent_at      INTEGER NOT NULL,
  delivered_at INTEGER,           -- when recipient's shim saw the notify
  read_at      INTEGER            -- when recipient's inbox()/wait_for_message returned it
);
CREATE INDEX ix_messages_to_read ON messages(to_handle, read_at);

CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
```

Rooms, room membership, and presence pings are later-slice tables; the slice-1 schema is designed to grow, not slice-1 scope.

**Body size cap:** 64 KB per message (bigger than any realistic chat turn, smaller than accidental file dumps). Enforced by the shim in the `send` tool implementation — an over-cap `send` returns an error before the INSERT.

## MCP surface

### Tools (5)

| Tool | Args | Returns |
|---|---|---|
| `register` | `display_name?`, `metadata?` | `{ handle, session_id }` — idempotent, called automatically on shim boot from CLI arg |
| `list_agents` | `include_offline?=false` | `[{ handle, display_name, last_seen_at, online, kind }]` — `online` = shim process is still alive (verified via `kill -0 pid`); by default filters to online only |
| `send` | `to`, `body` | `{ message_id, sent_at }` |
| `inbox` | `since_id?`, `limit?=50` | `[{ id, from, body, sent_at }]` — sets `read_at` on returned rows |
| `wait_for_message` | `timeout_s?=25`, `since_id?` | Same shape as `inbox`; blocks on `fs.watch(notify)` until a matching message arrives or timeout expires |

`wait_for_message` defaults to 25 s to stay under most MCP client tool-call timeouts (Claude Desktop caps at 30 s; Claude Code and Cursor allow more but 25 s is a safe universal default).

### Resources (1)

- `inbox://<handle>` — returns unread messages as text. Enables `notifications/resources/updated` when new mail arrives; MCP clients that surface resource updates to the model (Claude Code, Cursor) will nudge the model on the next turn boundary.

### Server → client notifications

`notifications/resources/updated` fires on `inbox://<handle>` whenever a row lands with `to_handle = handle`.

## Handle & registration

Baked into MCP client config:

```json
{
  "mcpServers": {
    "chat": {
      "command": "npx",
      "args": ["-y", "chat-mcp", "--handle", "claude1"]
    }
  }
}
```

On boot, the shim:
1. Opens `~/.chat-mcp/chat.db` (creates + migrates if missing).
2. `INSERT OR REPLACE INTO agents` with a fresh `session_id` and its own pid.
3. Starts `fs.watch(~/.chat-mcp/notify)`.
4. Ready to serve MCP tool calls.

If two shims boot with the same `--handle`, the later one wins the `agents` row (via `INSERT OR REPLACE`) and both processes keep running independently. Messages addressed to that handle route to the current row's `pid` — i.e., the newer shim. The older shim is not killed; it just stops receiving. `list_agents` reflects reality via `kill -0 pid` on the current row. One shim per handle is the intended operating shape, so this is a "don't do that" case, not a race we defend against in slice 1.

## Realtime engine

### Send path (`send` tool)
```
BEGIN
  INSERT INTO messages(...)
COMMIT
touch(~/.chat-mcp/notify)
```

### Receive path (every shim, always running)
```
fs.watch(notify) fires
  → SELECT unread messages for my handle
  → if any pending wait_for_message() awaits: resolve them with the batch
  → send notifications/resources/updated for inbox://<handle>
  → UPDATE messages SET delivered_at = now WHERE id IN (…)
```

### Latency budget
- Sender → recipient shim: **~1–5 ms** (fs event round trip).
- Recipient shim → model: **instant** if the recipient is currently in `wait_for_message`; otherwise **client-dependent** — Claude Code surfaces `resources/updated` on the next turn boundary, ambient awareness rather than push.

## Scaling

Every peer wakes on every notify, so per-send work is O(N) across the whole bus: one INSERT + one touch + N shims doing a SELECT to see if they're addressed. Each of those SELECTs is a few microseconds against the `ix_messages_to_read` index, so:

| N peers | Per-message overhead | Bottleneck when it matters |
|---:|---|---|
| 2–10 | Undetectable (~sub-ms fan-out) | None. Slice-1 target range. |
| 10–100 | ~1–5 ms fan-out on top of the fs event | SQLite WAL contention starts to show for send-heavy workloads. Consider WAL checkpoint tuning. |
| 100–500 | ~10–50 ms fan-out; visible but usable | `fs.watch` fan-out becomes the dominant cost on macOS (FSEvents fine; Linux `inotify` fine; Windows `ReadDirectoryChangesW` needs review). |
| 500+ | Not designed for | Would want a pub/sub broker or moving each recipient's inbox to its own notify file. Out of scope. |

**Slice 1 does not impose a hard cap.** The design permits arbitrary N; if the practical ceiling ever needs to move, the shift is from "everyone watches one notify file" to "per-handle notify files" — a mechanical change to the shim, not the schema or MCP surface.

**Concurrent writers.** SQLite WAL allows one writer + N readers at once. `send` is a ~1 ms transaction, so realistic contention only shows above ~1000 sends/sec bus-wide. Not a slice-1 concern.

## User CLI (`chat-mcp cli`)

The user participates in the chat as an ordinary peer with its own handle (default `user`, override with `--handle`). The CLI is a terminal REPL that speaks the same SQLite + `fs.watch` protocol the agent shims use — no privileged access, no separate transport.

```
$ chat-mcp cli
chat-mcp v0.1 · handle: user · Ctrl-C to quit

> /list
claude1  · Claude Code · online · seen 3s ago
claude2  · Cursor      · online · seen 12s ago

> /dm claude1
[dm with claude1]  (type to send, /back to return, /quit to exit)

> hey, can you gate #1355?
[user → claude1]  hey, can you gate #1355?

[claude1 → user 20:52]  On it. ETA 5 min.

> /back
> /quit
```

### Slice 1 CLI command surface

| Command | Effect |
|---|---|
| `/list` | List all known agents with online/offline + kind + last-seen (equivalent to `list_agents(include_offline=true)`) |
| `/dm <handle>` | Enter DM mode with `<handle>` — plain lines become messages to them |
| `/back` | Leave DM mode; back to the top-level prompt |
| `/quit` (or Ctrl-C) | Exit |
| plain text (in DM mode) | Sent as a message to the current DM target |
| plain text (top-level) | Error: "Not in a DM. Use /dm <handle> first." |

### Slice 2+ CLI command surface (documented here as forward compat, NOT built in slice 1)

`/rooms`, `/enter <room>`, `/leave`, `/who` (in a room), `/create-room <name>`, room-scoped plain-text messages, `/history <handle-or-room> [n]`, `/quit`.

### Realtime behaviour

The CLI runs `fs.watch(~/.chat-mcp/notify)` the same way the agent shims do. When a message arrives for `user` (or for the current room in slice 2+), it is printed inline to the terminal above the input line, then the prompt is redrawn. No polling, no refresh delay.

### Non-goals for the CLI

No TUI framework (ncurses, bubbletea, textual). Slice 1 is line-oriented — `readline` + ANSI escapes for prompt redraw. If a richer TUI is ever wanted, it lands as a separate optional subcommand (`chat-mcp tui`) and doesn't replace the plain CLI. Rich content (attachments, formatting) is out of scope for the CLI at every slice — it stays text-first.

## Install / config UX

Two invocation modes from the same npm package:

- **MCP shim mode** (spawned by an MCP client — Claude Code, Cursor, Codex):
  ```json
  {
    "mcpServers": {
      "chat": { "command": "npx", "args": ["-y", "chat-mcp", "--handle", "claude1"] }
    }
  }
  ```
- **User CLI mode** (run from a shell):
  ```
  npx -y chat-mcp cli               # handle defaults to "user"
  npx -y chat-mcp cli --handle lee  # custom handle
  ```

Behaviour is selected by the first positional arg (`cli` vs. absent). No global install required; state lives entirely in `~/.chat-mcp/`. Uninstall = delete `~/.chat-mcp/` and remove MCP client entries.

## Testable acceptance criteria (slice 1)

Three terminals — Claude Code as `claude1`, Cursor (or a second Claude Code) as `claude2`, plain shell running `chat-mcp cli` as `user`:

**Agent ↔ agent:**
1. In terminal 1: "Who's online?" → agent lists `claude2` and `user`.
2. In terminal 1: "Message claude2 saying 'hi'." → `send` succeeds.
3. In terminal 2, next turn: agent notices new mail (via resource notification) or when asked "check inbox", returns the message.
4. In terminal 2, ask the agent to wait for a reply: it calls `wait_for_message(30)`. In terminal 1 send another message. Terminal 2 returns within ~1 s.

**User CLI ↔ agent:**
5. In terminal 3: `/list` shows `claude1` and `claude2` online.
6. In terminal 3: `/dm claude1` then type `ping` → agent 1 sees the message.
7. In terminal 1: agent 1 sends a reply to `user`. Terminal 3 prints the reply inline within ~1 s without any user input.
8. In terminal 3: `/back` then `/dm claude2` — same round-trip works with the second agent.

## Deferred decisions carried in schema

- **Delivery receipts.** `delivered_at` and `read_at` are populated in slice 1 but no tool exposes them. A `sent_messages()` tool arrives in a later slice.
- **Rooms.** `messages.to_handle` will grow a companion `to_room` column when rooms land; slice 1 leaves `to_room` unused.
- **Cross-machine.** The SQLite + fs.watch approach is single-machine only. If cross-machine is ever required, the shim gains a network transport option; the tool surface stays the same.

## Runtime choice

**Node.js + TypeScript.**

- Most existing MCP servers are Node; ecosystem is best.
- `better-sqlite3` is synchronous and fast (~50k ops/s), which matches the shim's non-concurrent workload.
- Native `fs.watch` (via `chokidar` for cross-platform quirks).
- `npx -y chat-mcp` install path matches other MCP servers users already run.
- Node is already in the leagues2 dev stack (Vite), so no new runtime for local development.

## Open items

- **Package name.** `chat-mcp` is a placeholder; final name TBD before publishing.
- **License.** MIT default unless there's a reason to pick otherwise.
- **Distribution.** npm public registry vs. GitHub-only tarball for the private experiment phase — decide before the spin-off.
