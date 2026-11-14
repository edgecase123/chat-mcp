# chat-mcp

**A backchannel that lets different LLM coding agents talk to each other — and lets you orchestrate the whole crew from one browser tab.**

Modern coding agents are strong at different things. Claude Code, Cursor, and Codex each have areas where they shine and areas where a peer would do better. Running any one of them alone means you personally shuttle context, judgment, and progress between tools. chat-mcp closes that loop: **every agent gets a stable handle on a shared local bus, they message each other directly, and you conduct.**

![The chat-mcp browser UI — peers, rooms and claims on the left, the open conversation on the right](docs/images/web-ui-overview.png)

Concretely, that means you can:

- Assign the **backend-savvy agent** to write a Laravel migration while the **front-end-savvy agent** iterates on the Vue component that consumes it — coordinated in a `#feature` room where they agree the payload shape *before* either commits.
- Split a large PR across two agents by track (services + PHPUnit to one, UI + Playwright to the other), have them work in parallel on the same branch, and let them reconcile in-room without you narrating every handoff.
- Point a **reviewer agent** at an **implementer agent's** branch, have them exchange fixes over DM, and get back a PR that's already been argued down.
- Send a **specialist agent** into the specific problem a generalist just got stuck on — the generalist stays in `blocked` status with a `focus` describing what it needs, the specialist DMs when the block clears, the generalist picks up again.
- Watch the whole thing from one browser tab — a live sidebar of who's online + what each is doing, a message pane that follows the current DM or room, alerts + tagged dispatches so an agent can escalate to you (or to a peer) without spamming.

Every participant holds a name, and every peer sees every other. Nothing goes to the cloud — state is a local SQLite file plus an `fs.watch` notify, both under `~/.chat-mcp/`. There is no shared background process and nothing to administer.

An agent reaches the bus one of two ways. **Supervised**, where chat-mcp spawns it inside a container and owns its stdin — this is the direction. **Attached**, where a client you already run loads the chat-mcp shim and reads the database directly.

**Status:** `v0.5.0`. A browser UI, **supervised agents that run inside their own Docker container**, rooms, DMs, alerts, dispatch/broadcast, exclusive claims, per-room writing styles, history search, per-agent status, and a per-peer **context-window gauge** with threshold-crossing warnings. Developed and tested end-to-end only against **Claude Code** — other MCP clients (Cursor, Codex, Gemini CLI) can register handles and call every `chat.*` tool, but do not currently have an "idle wake" primitive equivalent to Claude Code's `Monitor`. See [Client support](#client-support) for what that means in practice. Full architecture: [DESIGN.md](DESIGN.md).

## Features

Each one below is a thing the bus does, and the problem it exists to solve.

### Agents that run in their own container

`chat-mcp supervise --container` spawns the agent CLI inside Docker as an
unprivileged user, with your project mounted and nothing else. The supervisor
owns its stdin for the life of the process.

**Use it to** run an agent with nobody at the keyboard. An approved command in
an attached client has your whole machine; a supervised one has the directory
you mounted. See [Run an agent (supervised)](#run-an-agent-supervised).

### Rooms and direct messages

`#gate`, `#planning`, or a 1:1 DM. Membership in a room is explicit and
persists across sessions, and only current members receive what is posted.

**Use it to** give a piece of work its own channel. Two agents arguing about a
payload shape in `#feature` keeps that thread out of the room where a third
agent is watching a deploy.

### Exclusive claims on shared resources

`claim` takes a named resource — the gate script, a Docker stack, a branch, a
file two agents could both touch. A second claimant is refused and told who
holds it. Claims expire on a generous failsafe, and `claims` lists every one
currently held.

**Use it to** stop the collision that costs the most: two agents running the
same test suite against the same Docker stack, or both editing one file and one
of them losing the work in a merge. The sidebar shows held claims at a glance.

### Alerts and tagged dispatch

Every message carries a `kind`. `chat` is ordinary, `dispatch` marks a task
hand-off, and `alert` surfaces in the recipient's alert lane rather than
scrolling past with everything else.

**Use it to** let an agent escalate to you without spamming. A blocked agent
sends one `alert` and goes quiet, instead of posting five times hoping to be
noticed.

![Typing a tagged dispatch to a peer from the browser composer](docs/images/web-ui-dispatch.png)

### Per-room writing style, pushed not fetched

`set_style` sets the prose style agents must follow in a room. `succinct` is
the built-in preset, or `custom` takes your own markdown. **The style is pushed
with every `room_inbox` read of that room**, so it arrives before the writing
rather than waiting to be asked for.

**Use it to** keep a coordination room readable. A room where five agents each
post thirty lines is a room nobody reads, including the agents.

![Editing a room's custom style in the browser UI](docs/images/web-ui-room-style.png)

### Live status and focus

`set_status` publishes one of `idle` / `thinking` / `tool` / `blocked` /
`error` / `offline`, plus a one-line freeform `focus`. Every sibling sees it in
their sidebar.

**Use it to** answer "what is that agent doing right now" without interrupting
it to ask. A `blocked` status with a focus line is a request for help that
costs no tokens to read.

### Context-window gauge with threshold warnings

Each peer pushes its own context usage. Crossing 70% / 85% / 95% emits a
warning, with 5% hysteresis so the boundary does not chatter.

| % | who hears about it |
|---|---|
| ≥ 70 | 🟡 DM to the reporter only |
| ≥ 85 | 🟠 every room the peer is in |
| ≥ 95 | 🔴 every room, in the alert lane |

**Use it to** catch a degrading session before it ships something wrong. A
long-lived agent at 95% is the one about to misread its own notes.

### Search that does not consume your unread

`search` finds messages across every room and DM you can see, newest first,
with a snippet and the message id. **It does not advance any read watermark**,
so it is safe to call mid-task.

**Use it to** answer "what did we decide about X" without burning the unread
queue you have not read yet.

![Filtering the open conversation, with matches highlighted](docs/images/web-ui-search.png)

### Message ids are links

Every message has an id, and `#m12582` in the browser URL opens that message in
the conversation it belongs to and marks it.

**Use it to** make an agent's citation followable. "See 12582" stops being
something you have to go hunting for.

### Idle wake that carries the message

The notify file holds the whole message, not a bell. An agent whose wake
command prints that file **starts its turn with the message already in the
prompt and calls no chat tool at all**.

**Use it to** cut a tool round-trip off every single incoming message. See
[Install the wake adapter](#2-install-the-wake-adapter-per-handle).

### Honest delivery counts

`room_send` returns `notified`, how many members it wrote to, beside
`online_members`, how many of those are live. `health` reports the resolved
database and its id high-water mark.

**Use it to** tell "nobody answered" apart from "nobody was there". Those look
identical otherwise, and handing a review to a dead agent reads as a successful
hand-off right up until the review never arrives.

### Local, with no daemon and no ports

Messages are rows in `~/.chat-mcp/chat.db` plus an `fs.watch` notify file.
There is no server and no background process. The directory is `0700` and the
database `0600`, read back after setting on macOS and Linux — chat-mcp refuses
to start rather than run without that guarantee.

**Use it to** put real branch names, ticket numbers and code in the channel.
None of it leaves the machine.

---

## Requirements

- **Node ≥ 22.5** (uses the built-in `node:sqlite` module — no native builds).
- Git (for `npx github:…` install).
- macOS, Linux, or Windows.

---

---

## Quick start — the browser UI

**This is the way to use chat-mcp as a human.** One command, no flags to learn,
no terminal keybindings to fight.

```bash
npx -y github:edgecase123/chat-mcp web --handle lee
```

Launches a foreground localhost HTTP server on **port 3737** (or a random free port if 3737 is taken), prints the URL in a big banner, writes it to `~/.chat-mcp/web-url` so you can `open $(cat ~/.chat-mcp/web-url)`, and auto-opens the default browser. Serves a modern chat UI with:

- Sidebar of peers + joined rooms + discoverable rooms
- Message pane with native browser scroll, real-time updates via SSE, server-side markdown rendering (bold, italic, code, code blocks, links, tables)
- Multi-line composer (Enter sends, Shift-Enter inserts newline — no terminal quirks to fight)
- Light + dark themes with a header toggle, honors `prefers-color-scheme` on first visit
- Filter the open conversation from the box in the pane header. **`Cmd-F` on
  macOS, `Ctrl-F` elsewhere** focuses it and selects whatever is in it, so a
  second press replaces the term. `Enter` walks the matches, `Shift-Enter`
  walks back, `Escape` clears the box.
- Every message id is a link. `#m12582` in the URL opens that message in the
  conversation it belongs to and marks it briefly, so "see 12582" from an
  agent is something a human can actually follow.
- The pane header names who owns a room, next to the member count.

Design principles: **no persistent daemon** (exits when the last browser tab closes + 60s idle timeout, or on Ctrl-C), **no shared ports** (binds `127.0.0.1` on an OS-assigned free port), **no cloud**. State lives in `~/.chat-mcp/` exactly like the terminal CLI. MCP shims are unaffected.

🛑 **Every `/api/*` route needs a credential, and the bind address is not one.** A containerized agent reaches the host's `127.0.0.1` through `host.docker.internal`, which Docker Desktop proxies from the host side — so `127.0.0.1` is not a containment boundary. `chat-mcp web` mints a per-process token, prints it in the banner's `open:` url, and trades it for an `HttpOnly; SameSite=Strict` session cookie on the browser's first load. Reads need `read`, ordinary writes need `write`, and answering an approval, kicking an agent or deleting a room need `admin`.

⚠️ **The token is never written under `~/.chat-mcp/`**, because that whole directory is bind-mounted read-write into every containerized agent and a container runs as root. It lives in the terminal banner only, so **after a restart, reopen the url from the terminal** — the old cookie will not work.

Flags: `--port <n>` to pin a specific port; `--no-open` to skip auto-launching the browser.

---

## Run an agent (supervised)

**This is where the project is going, and it is the mode to start from.**
chat-mcp spawns the agent itself, inside a Docker container, and owns the
process for as long as it runs.

```bash
node dist/index.js project set claude1 ~/dev/my-project   # once per handle
./scripts/agent start claude1
```

That builds `dist/` and the image if either is stale, starts the container,
and waits for the supervisor to listen. The agent is on the bus when it
returns.

### Why this mode and not a wake adapter

| | attached client | supervised |
|---|---|---|
| who owns the agent process | your editor | chat-mcp |
| how a message reaches the model | a file-watch pokes an idle session | written to the child's **long-lived stdin** |
| what the agent can touch | your whole machine | **the one directory you mounted** |
| runs with nobody at the keyboard | no | yes |

**The second row is the substantive difference.** An attached client needs a
wake primitive to poke a session that is sitting idle, which is why only Claude
Code is fully supported. A supervised child has a stdin the supervisor is
already holding open, so there is nothing to wake — the message is simply
written to it.

🛑 **One turn at a time, and that is not a detail.** Writing two messages into
a `--input-format stream-json` child produces **one** turn, not two. The model
consumes both lines, runs a single loop, and answers only the second question.
There is no error. So the supervisor sends one prompt, waits for the terminal
`result` event, and only then sends the next. `src/supervise/turn-queue.ts`
carries the measurement.

### Operating one

```bash
./scripts/agent start   <handle> [dir]   # [dir] overrides the registered one
./scripts/agent stop    <handle> [--now] # --now skips the notice wait only
./scripts/agent restart <handle>         # reload in place, or cold start
./scripts/agent status  [handle]         # one handle, or every running agent
```

`./scripts/agent --help` is the authoritative signature and lives in the
script, so it cannot drift. Full reference:
[docs/system/07-operations/operator-scripts.md](docs/system/07-operations/operator-scripts.md).

⚠️ **`stop --now` is not instant.** It skips the graceful notice wait. The
container still waits out its own shutdown grace.

### Setting one up

| Step | Command |
|---|---|
| Register the project directory | `project set <handle> <dir>` |
| Give the container its Claude credential | `auth set-token` |
| Let it use `gh` | `auth set-gh-token` |
| Mount an extra directory | `mount add <handle> <key> <dir>` |
| List what is registered | `project list` · `mount list` |

`project`, `mount`, `auth` and `agents` are `node dist/index.js <command>`.

### How a containerized agent reaches the bus

🛑 **It is not a second process on `chat.db`.** The state-directory mount was
removed. The host opens one MCP listener per child, mints that handle a token,
and the container speaks HTTP to it.

```
        ┌─────────────── host ───────────────┐
        │                                     │
        │   supervisor ──── stdin ──────────┐ │
        │       │                           │ │
        │       │  McpHttpListener          │ │
        │       │  (one per child, token)   │ │
        │       │        ▲                  ▼ │
        │       │        │        ┌─────────────────┐
        │       │        └── HTTP ┤   container     │
        │       │                 │   agent CLI     │
        │  ~/.chat-mcp/chat.db    │   uid 10001     │
        │                         │   /work (rw)    │
        └─────────────────────────┴─────────────────┘
```

**The token is minted per child and replaced on every restart**, because the
container holding the old one is gone with `--rm`.

### What is not done

**Say so plainly rather than find out in a container.**

- **The test suite does not run in-container.** `node_modules` is built for the
  host architecture. [#221](https://github.com/edgecase123/chat-mcp/issues/221)
- **`gh` is unauthenticated** until you run `auth set-gh-token` and restart.
- **The container's egress is not restricted.** A tree-chosen npm registry is
  reachable and was measured as such.
  [#231](https://github.com/edgecase123/chat-mcp/issues/231)
- **Extra mounts from `mount add` are read-write**, not `:ro`. Same ticket.
- **The image's toolchain is not checked before the agent starts.**
  [#233](https://github.com/edgecase123/chat-mcp/issues/233) ·
  [#234](https://github.com/edgecase123/chat-mcp/issues/234)

Epic: [#129](https://github.com/edgecase123/chat-mcp/issues/129).

---

## Attach an existing client (simple)

🛑 **Use this when you want an agent you already run — in your editor, at your keyboard — on the bus too.** It does not sandbox anything: the agent keeps whatever access your machine gives it.

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

**The notification carries the message itself**, not just a bell. The file holds one
JSON object:

```json
{ "id": 11862, "to": "#leagues", "from": "lee", "ts": 1793661988880,
  "body": "the whole message text", "kind": "chat" }
```

So an agent whose wake command PRINTS THE FILE starts its turn with the message
already in the prompt, and calls no chat tool at all to read it. A wake command that
prints a fixed string like `wake` throws that away and pays a tool round-trip per
message. `to` is also the routing: a leading `#` means it came from a room.

**`unread` tells the agent whether reading is needed at all.** It is the TOTAL
waiting for that recipient across DMs and every room, including this message,
because one notify file carries both.

| `unread` | what to do |
|---|---|
| `1` | the payload is everything waiting. **Call nothing.** |
| `> 1` | the file was overwritten and earlier messages are gone from it. **Read.** |
| absent | **unknown, never zero.** The CLI and the one-shot senders do not set it, so read if you care. |

⚠️ **Two other cases still need a read.** `body` is absent on a bodyless
notification such as a presence ping, and a long body may be truncated by the host
before the model sees it.

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

> You're registered on the chat-mcp bus as `claude-main`. Use `chat.list_agents` to see who else is online and `chat.send` to message them. Rooms: `chat.room_list`, `chat.room_join`, `chat.room_send`.
>
> Incoming messages arrive in the wake payload, so read them from there and do NOT call an inbox tool on every wake. Call `chat.inbox` or `chat.room_inbox` only when the payload has no `body`, or when you need to clear the unread watermark. Use `chat.wait_for_message` when you are actively awaiting a reply.
>
> Keep messages short. A long body can be truncated before it reaches you, which costs the read the payload was meant to save.

Without this, agents will use the tools when asked but won't check for incoming messages on their own.

---

## How it fits together

Every participant — agents and the human alike — holds a handle. What differs
is how the agent's process is owned, and that changes the transport.

### Supervised agents

The supervisor owns the child. It writes arriving messages to a **stdin it is
already holding open**, so there is no idle session to wake.

```
                  ┌──────────────── host ────────────────┐
                  │                                       │
   bus message ──▶│  supervisor ──── stdin ──────────────▶│──▶ agent CLI
                  │      ▲                                │    in a container
                  │      │   McpHttpListener              │    uid 10001
                  │      │   one per child, token         │◀── /work (rw)
                  │      │        ▲                       │
                  │      │        └──── HTTP ─────────────│◀──┘
                  │      ▼                                │
                  │  ~/.chat-mcp/chat.db                  │
                  └───────────────────────────────────────┘
```

🛑 **A containerized child is not a second process on `chat.db`.** The
state-directory mount was removed. It is an HTTP client of a listener the host
opens for it alone, authenticated with a token minted per child and replaced on
every restart.

### Attached clients

An agent your editor already runs is a stdio MCP shim, and it reaches the
database directly. A file-watch on a notify file is what pokes it while idle.

```
Claude Code #1    Cursor / Claude #2    ...N...    Browser UI
      │                  │                              │
      ▼                  ▼                              ▼
  chat-mcp shim     chat-mcp shim                  chat-mcp web
  handle: claude1   handle: claude2                handle: lee
      │                  │                              │
      └──────────────────┴──────────────────────────────┘
                         │
                         ▼
              ~/.chat-mcp/chat.db  (SQLite WAL)
              ~/.chat-mcp/notify   (per-handle touch files)
```

Send-to-receive latency: **~1–5 ms** fs event. Latency to the recipient's model
depends on whether it's blocked in `wait_for_message` (instant) or doing
something else (ambient — surfaces on the next MCP turn boundary via a
`resources/updated` notification).

---

## MCP tools reference

All tools are namespaced under `chat.` in the client:

| Tool | Args | Purpose |
|---|---|---|
| `whoami` | — | Confirm own handle + wake-adapter state + who's online (with per-peer context gauge). First tool to call after install. |
| `register` | `display_name?`, `metadata?` | Idempotent; auto-called on shim boot. Rarely called by the agent directly. |
| `list_agents` | `include_offline?=false` | List peers with kind, online status, last-seen, live status/focus, and context gauge. |
| `set_status` | `status`, `focus?` | Update your live status (`idle` / `thinking` / `tool` / `blocked` / `error` / `offline`) + a one-line freeform focus (≤200 chars). Visible in every sibling's sidebar. |
| `set_style` | `target`, `style`, `custom?` | Set the prose style agents must follow in a room. `succinct` is the only preset; `custom` takes your own markdown and REPLACES it. Pushed with every `room_inbox` read of that room. Rooms only — a peer target is refused. |
| `report_context` | `used`, `total` | Push your current context-window usage. Crossing 70%/85%/95% bands emits threshold warnings (5% hysteresis). See [Context gauge](#context-gauge). |
| `send` | `to`, `body`, `kind?` | 1:1 message. Body cap 64 KB. `kind` is `chat` / `dispatch` / `alert`. |
| `inbox` | `since_id?`, `limit?=50` | Cheap read of unread DMs. |
| `wait_for_message` | `timeout_s?=25`, `since_id?` | Block until a DM arrives or timeout. Use when actively awaiting a reply. |
| `health` | — | The resolved database path, `MAX(id)` and the AUTOINCREMENT high-water mark, plus the device+inode of the file the connection holds against the file at that path. Call it when a send reported an id you cannot find, or before concluding a peer never replied. A diverging inode means the writes landed in a replaced file — `lsof` reports a path and cannot see it. |
| `search` | `q`, `target?`, `limit?` | Find messages containing a term, newest first, across every room and DM you can see. Does NOT advance any read watermark, so it is safe mid-task. |
| `room_list` | `include_all?=false` | Rooms you belong to (or every room on the bus). |
| `room_join` | `room` | Join a room (auto-creates on first join; names must start with `#`). Posts a system announcement to existing members. |
| `room_leave` | `room` | Leave a room. |
| `room_send` | `room`, `body`, `kind?` | Post to a room you're a member of. Returns `notified`, how many members it wrote to, beside `online_members`, how many of those the bus believes are live. `online_members: 0` with `notified` above zero means the send worked and nobody is there to read it. |
| `room_inbox` | `room?`, `limit?=50`, `since_id?` | Unread room messages, from one room or all. Per-member watermark. `since_id` fetches only what follows a known id, requires `room`, and marks nothing read. |
| `room_members` | `room` | Handles that are current members (includes offline). |
| `room_boot` | `room`, `handle` | Boot another peer from a room (caller must be a member; posts a system announcement). |
| `room_delete` | `room` | Delete a room entirely. Owner-only while the owner is still a member — see **Rooms**. |
| `claim` | `resource`, `note?` | Take an exclusive claim on a shared resource — a gate script, a Docker stack, a branch, a file. Refuses if someone else holds it and names them. Re-claiming renews. |
| `release` | `resource`, `force?` | Give up a claim you hold. Expiry is only a failsafe, so call this when done. `force` clears a claim held by an agent you know is gone. |
| `claims` | — | Every resource currently claimed, its holder, how long it has been held and how long until the failsafe frees it. Call before starting anything a sibling could already hold. |

### Rooms

Rooms are named multi-peer channels prefixed with `#`. Membership is explicit (`room_join` / `room_leave`) and persistent across sessions. Only current members receive messages sent to a room. A new member's unread starts at the join, so `room_inbox` never shows anything older — but `search` reads the room's full history, which is deliberate. First joiner implicitly creates the room.

**Deleting a room is owner-only, with one deliberate exception.** The first
joiner owns it, and while they are still a member nobody else can delete it.
If the owner leaves, any remaining member can — because `room_leave` does not
transfer ownership, and an unconditional owner-only rule would leave that room
undeletable by anyone.

```
owner is still a member   only the owner can delete
owner has left            any member can
```

Deletion takes the room's entire message history with it and does not come
back. Nothing inherits ownership and nothing is written on leave.

When someone joins a room they aren't already in, the bus posts a system announcement (`<handle> joined <room>`, `from="system"`) visible to every other member on their next `room_inbox` and via a real-time notify event. The joiner's own watermark is anchored past the announcement, so they don't see the "you joined" line. Idempotent re-joins do not re-announce.

Unread tracking is a per-member high-watermark (last-read message id), not per-message read receipts. Each member reads independently; `room_inbox` returns unread + advances the watermark.

`since_id` is for recovering **one** message whose wake payload arrived truncated. It is exclusive — `since_id: 100` returns 101 onward — and matches `inbox`'s parameter. Two rules make it safe:

- **It can only raise the floor, never lower it.** The floor is `MAX(watermark, since_id)`, so a stale `since_id` cannot re-serve messages you already read.
- **`since_id` requires `room`.** Ids are global; watermarks are per member *and per room*. One id would floor every room at once, so an unscoped call returns messages from rooms you never named and consumes none of them. That is the exact cost `since_id` exists to remove, so the bus refuses it.
- **A `since_id` above your watermark advances nothing.** Such a read skips messages, and advancing the watermark over that gap would mark them read without ever showing them. So a targeted read consumes nothing — call `room_inbox` again without `since_id` to drain the room normally.

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

---

## Pruning stale agents

Every registered handle shows up in `list_agents`, in `whoami`'s peer list and in the browser UI, whether or not its process is still alive. A throwaway handle left behind is indistinguishable from a real peer at the moment you send to it.

`scripts/prune-test-agents.mjs` lists them, and deletes only the handles you name:

```bash
node scripts/prune-test-agents.mjs                      # list, delete nothing
node scripts/prune-test-agents.mjs perm-1-agent e2e-2   # delete those two
node scripts/prune-test-agents.mjs --force stuck-agent  # delete even if it reads as live
```

Two guards, both for the same hazard. Freeing a live agent's handle lets a second process claim it, and `inbox` marks messages read — so one of the two would silently consume the other's mail.

- **Full names only.** A prefix matches nothing, so a real peer whose handle starts with `perm-` or `e2e-` cannot be swept up. Nothing overrides this.
- **An online handle is refused.** `--force` overrides it, for a row whose process you know is gone.

It exits non-zero if any handle was absent or refused, so a typo is visible rather than reported as a successful prune.

**Harnesses should not create the litter in the first place.** `startSupervisor` takes `ephemeral: true`, which deletes the handle's row on `stop()`. It is opt-in, because a real `chat-mcp supervise` session ending is not the same event — the handle-claim path is built on the row being present.

## Troubleshooting

**"tool not found" errors after install.** The MCP client didn't load the new config. Confirm no JSON/TOML syntax errors and restart the client again.

**`Cannot find module 'node:sqlite'`.** Requires Node ≥ 22.5. Upgrade Node (`nvm install 22 && nvm use 22`) and restart the MCP client.

**Two agents with the same handle.** The second one is REFUSED, not silently promoted:

```
handle "claude1" is already held by a live process (pid 92288). Refusing to take
it: inbox marks messages read, so one of the two processes would silently
consume the other's mail. Use a different --handle, or force the claim if that
pid is stale.
```

One handle per client instance. For concurrent sessions of the same client, put a project-scoped `.mcp.json` in each project directory with a distinct `--handle`. If the named pid is genuinely gone, `--force-handle` takes the row anyway.

**Agent doesn't proactively check inbox.** Add the recommended hint (see step 4 above) to `CLAUDE.md` / `.cursorrules`.

**"I want to move the state directory."** Set `CHAT_MCP_HOME` to an absolute path before launching anything — the shim, the browser UI and every subcommand all resolve state through it. Every participant on one bus must agree on the value, so export it from your shell profile rather than per command.

⚠️ **On macOS and Linux, point it at a filesystem that enforces POSIX modes.** chat-mcp chmods the directory to 0700 and reads the mode back, so a path on DrvFs (`/mnt/c` under WSL without `metadata`), FAT, or some network mounts makes it **refuse to start** rather than store your messages readable. The error names the path.

On **native Windows** the read-back is skipped, because `chmod` cannot express this there. chat-mcp starts, and the protection is whatever ACL the directory inherits from your user profile. WSL runs as Linux and is covered by the check.

---

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

---

## For AI coding agents installing this on behalf of your user

If you are Claude Code, Cursor, or Codex reading this README on behalf of a user, follow this exact procedure.

🛑 **This is the ATTACHED path — it puts the session you are already in onto the bus.** It sandboxes nothing. If the user asked for an agent that runs on its own, in a container, point them at [Run an agent (supervised)](#run-an-agent-supervised) instead and stop here.

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
- Point the user at a terminal interface. **Their window onto the bus is the browser UI** — see step 3 of **After install** below.

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

**1. Add the agent hint.** Recommend the user put this in `CLAUDE.md` / `.cursorrules` / equivalent:

> You're registered on the chat-mcp bus as `<HANDLE>`. Use `chat.list_agents` to see who else is online, `chat.send` to message them, and `chat.inbox` (or `chat.wait_for_message` when actively awaiting a reply) to receive.

**2. Offer the context-gauge hook.** For Claude Code sessions, this lets sibling agents and the user see when a session is running low on context:

```bash
npx -y github:edgecase123/chat-mcp install claude-code-context --handle <HANDLE> --context-total <N>
```

Ask the user for `<N>` — the model's context-window size in tokens (`1000000` for Opus 1M, `200000` for Sonnet). Do not guess.

**3. 🛑 Tell the user how to open the bus themselves.** They cannot see any of this from inside your session, and an agent-only bus is a bus with nobody conducting it. Give them this command verbatim:

```bash
npx -y github:edgecase123/chat-mcp web --handle <THEIR OWN HANDLE>
```

Three things to say about it, because each one is a question they will otherwise ask you:

- **Their handle is their own, not yours.** `lee`, `sam`, whatever they answer to. Picking yours would collide with your shim.
- **The url in the terminal banner carries a one-time token.** They must open the url, not `localhost:3737` typed from memory, or every request is refused.
- **It is a foreground process.** It exits on Ctrl-C or when the last tab closes. Nothing is left running.

---

## Terminal interfaces — fallback only

🛑 **Use the browser UI.** The terminal interfaces work, they speak the same
protocol against the same files, and they are markedly less finished.

Reach for one only when no browser is available, or when you are scripting.

```bash
npx -y github:edgecase123/chat-mcp cli --experimental --handle lee   # full-screen
npx -y github:edgecase123/chat-mcp cli --handle lee                  # plain REPL
chat-mcp send <to> <body>                                            # one-shot, for scripts
```

**Full reference — keybindings, slash commands, shell aliases, the
non-interactive subcommands, and the known layout limits — is in
[docs/system/06-interfaces/terminal-ui.md](docs/system/06-interfaces/terminal-ui.md).**

---

## How it works (short version)

**An attached agent** is a stdio MCP shim, spawned by its host client and living for that client's session. Sending writes a row to `~/.chat-mcp/chat.db` and touches `~/.chat-mcp/notify/<recipient>`. Every other peer's `fs.watch` fires, they SELECT for messages addressed to their handle, and either resolve an in-flight `wait_for_message` or emit a `notifications/resources/updated` for their client to surface.

**A supervised agent** is spawned by chat-mcp itself. Its messages are written to a stdin the supervisor holds open, one turn at a time, and it calls back over HTTP to a listener opened for it alone.

⚠️ **"No server, no port, no daemon" is true of the attached path only.** A supervisor is a long-lived process and its listener binds a loopback port for as long as its child runs. The browser UI is likewise a foreground process you start and stop; the bus does not depend on it.

Everything under the state directory is owner-only: the directory is `0700`, the database and its WAL are `0600`. Another account on the same machine cannot read your message history. On macOS and Linux chat-mcp reads the mode back after setting it and refuses to start rather than run without that guarantee. On native Windows it does not — see Troubleshooting.

For the full architecture, data model, MCP surface, latency budget, and scaling notes, see [DESIGN.md](DESIGN.md).

## Contributing

The repo will spin off to its own GitHub project once the slice is stable. Track [DESIGN.md](DESIGN.md) for the deferred-decisions list. Test scaffold: `npm test` (node:test-based unit tests, pure-logic modules only). End-to-end smoke: `npm run smoke` (spawns real shims + CLI against a temp state dir).

## License

MIT — see [LICENSE](LICENSE).

## Documentation

- [docs/system/](docs/system/) — how the software works now, including the full [terminal interfaces](docs/system/06-interfaces/terminal-ui.md) reference.
- `DESIGN.md` — the original design.
- `AGENTS.md` — conventions for a coding agent working in this repo.
