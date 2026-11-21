---
title: The state directory
updated: 2026-11-15
covers:
  - src/util/paths.ts
  - src/storage/db.ts
  - src/storage/dao.ts
  - src/supervise/container.ts
  - src/supervise/mounts.ts
  - src/supervise/auth.ts
  - src/supervise/handle-tokens.ts
---

# The state directory

Everything chat-mcp remembers between runs lives in one directory. This page is
the map: what each entry is, which module owns it, and which entries are safe
to delete.

---

## Where it is

`~/.chat-mcp`, unless `CHAT_MCP_HOME` is set, in which case that value is used
verbatim. `stateDir()` in `src/util/paths.ts` is the single resolver, and every
other path is derived from it.

🛑 **Under the node test runner `stateDir()` THROWS rather than defaulting.**
A test that resolved the real `~/.chat-mcp` could bind a supervisor socket
there, and binding unlinks whatever looks stale — which silently stops a
running agent. Set `process.env.CHAT_MCP_HOME` to a temp directory _before_
importing anything that resolves a path.

## What is in it

| Entry                     | Owner                                    | What it holds                                                                                                                                                                                                                                  |
| ------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat.db`                 | `src/storage/db.ts`                      | Every message, room, membership and agent row. The `-wal` and `-shm` files beside it are SQLite's, not ours                                                                                                                                    |
| `sock/<handle>`           | `src/supervise/socket.ts`                | Where a supervisor listens for direct delivery. **Kept short deliberately** — a unix socket path caps at ~104 bytes on macOS and a too-long one fails as a truncated bind, not a clear error                                                   |
| `notify/<handle>`         | `src/notify/bus.ts`                      | The wake file an adapter watches. A write here is what pulls an idle agent back into its inference loop                                                                                                                                        |
| `projects.json`           | `src/index.ts` (`project` command)       | Which directory each handle's agent works in                                                                                                                                                                                                   |
| `mounts.json`             | `src/supervise/mounts.ts`                | Extra mounts a containerized handle gets beyond `/work`, each attached **read-only** at `/mnt/<key>` — the tree chooses the code that runs in the container, so a writable extra mount is a write path onto the host directory it names (#231) |
| `container.json`          | `src/supervise/container.ts`             | Which handles have accepted the container confirmation banner, and the image fingerprint                                                                                                                                                       |
| `secrets.env`             | `src/supervise/auth.ts`                  | One credential per vendor, keyed by the env var it is injected under (`CLAUDE_CODE_OAUTH_TOKEN`, `CURSOR_API_KEY`), plus `GH_TOKEN`. Mode `0600`                                                                                               |
| `tokens/`                 | `src/supervise/handle-tokens.ts`         | Per-handle bus bearer tokens                                                                                                                                                                                                                   |
| `mcp/<handle>.json`       | `src/util/paths.ts` (`mcpConfigPathFor`) | The MCP client config handed to a supervised child                                                                                                                                                                                             |
| `adapters/`               | `src/util/paths.ts` (`adaptersDir`)      | Installed wake-adapter scripts, one per framework and handle                                                                                                                                                                                   |
| `web-url`                 | `src/cli/web/server.ts`                  | The running web UI's **plain** url. Unlinked on shutdown                                                                                                                                                                                       |
| `aliases.sh`              | `src/index.ts` (`aliases` command)       | A source-able shell alias block                                                                                                                                                                                                                |
| `run/*.pid`, `logs/*.log` | `scripts/lib/procctl.sh`                 | Written by the operator scripts, not by the CLI                                                                                                                                                                                                |

## The two entries whose location will surprise you

**`manifestDir()` is a SIBLING, not a child.** It resolves to
`~/.chat-mcp-manifests`, and the `resolve()` call in it is load-bearing: a
`CHAT_MCP_HOME` ending in `/` once produced `/x/-manifests`, a child of the
mount, which is the one thing it must never be.

**`web-url` holds the url WITHOUT its credential, on purpose.** Each web server
start mints a fresh API token and the terminal banner is the only place the
token-bearing url is published. A container can read the file and cannot read
the banner, so the file carries the plain url and the UI refuses it. See
[operator scripts](../07-operations/operator-scripts.md).

## Common pitfalls

**A socket file is not a listener.** A supervisor killed with `SIGKILL` leaves
its socket behind. Ten such files from test runs on 2026-10-31 read as ten
running agents until liveness became a real connect. Test it by opening it, not
by `[ -e ]`.

**`state.db` is an orphan.** A zero-byte file dated 2026-09-20 that no path
helper references. `dbPath()` returns `chat.db`. Safe to delete.

**`chat.db.bak-*` files accumulate** and are never pruned automatically.

🛑 **A PATH IS NOT A DATABASE, AND MOVING `chat.db` ASIDE UNDER A LIVE AGENT IS
SILENT.** A connection keeps the file it opened, so an agent goes on writing to
the moved-away inode while everyone who opens the path afterwards sees an empty
database. `lsof` and `PRAGMA database_list` both report the path, so neither can
see it.

- **`openDb` records the device and inode at open**, and EVERY writer in
  `dao.ts` compares them before its first statement. A mismatch throws, and the
  message says to RESTART the agent — a retry on the same handle lands in the
  same orphaned file.
- 🛑 **`insertMessage` WAS THE ONLY WRITER THAT COMPARED THEM UNTIL #268.** The
  other 23 — claims, approvals, rooms, agents, read watermarks, every delete —
  wrote blind and reported success. **A lost message is noticed when no reply
  comes; a lost claim is noticed when both agents have already acted.**
- **The comparison has one implementation**, `databaseWasReplaced` in `db.ts`.
  Writers reach it through `assertLiveDatabase(db, "<fn>")`, which throws
  `DatabaseReplacedError` naming the function. `insertMessage` keeps its own
  `MessageNotPersistedError` because a send has a from and a to to report.
- 🛑 **THE CHECK IS A WRITER'S FIRST LINE, AND THAT IS THE POINT.** Checking
  mid-operation would turn a replaced file into PARTIAL state. Checked first, a
  refused writer has written nothing. A test asserts the position, not just the
  presence.
- 🛑 **`joinRoom` ANNOUNCES FIRST, THEN COMMITS ITS TWO STATE ROWS TOGETHER**,
  and neither half of that order is a preference.
  - The announce goes through `insertMessage`, which proves its row landed by
    re-reading it on the SECOND connection. That connection cannot see an
    uncommitted row, so an announce inside the transaction makes every
    file-backed join throw `row-absent-on-reread`.
  - The announce cannot move after the commit either: the new joiner's
    watermark is anchored to the id the announce returns, so there would be
    nothing to write.
  - `room_members` and `room_reads` are wrapped in one `BEGIN IMMEDIATE`. A
    member row committed without its watermark row sends `roomWatermark` to its
    `0` fallback, and the idempotence short-circuit then returns before the
    watermark write — so the agent re-reads the room's whole history on every
    poll, permanently, and a retry repairs nothing.
  - ⚠️ **The residual is an orphan announce**, if the transaction fails after
    the announce committed. Nothing reads that line as state and a rejoin
    writes a second one.
- ⚠️ **A `:memory:` DATABASE CANNOT TEST ANY OF THAT.** It has no second
  connection, so the witness falls back to the writing connection and sees
  uncommitted rows. The announce-outside-the-transaction guard therefore opens
  a real database through `openDb`, and asserts `verifierFor` is defined before
  it asserts anything else.
- ⚠️ **PRESENCE OF THE CALL PROVES NOTHING ON ITS OWN.** The comparison is a
  no-op for a connection with no mark, which is every `:memory:` database — so
  most of the suite exercises a call that cannot fire. Two tests replace a real
  file to cover the mechanism.
- **The `health` tool reports both marks**, so an agent can check without
  sending.
- 🛑 **`openDb` THROWS if it cannot stat the file it just opened**, rather than
  handing back a connection with no mark. An unmarked connection skips the
  comparison on every send, so it would write into a replaced file for the life
  of the process without refusing once.
- ⚠️ **Restoring the file does not fix a live agent.** The connection still holds
  the old inode, and only a restart re-opens it.

---

## Source files

| File                      | Role                                                                           |
| ------------------------- | ------------------------------------------------------------------------------ |
| `src/util/paths.ts`       | Every path in the table above, plus `writePrivateFileSync` for the `0600` ones |
| `src/supervise/socket.ts` | Binds and unlinks `sock/<handle>`                                              |
| `src/notify/bus.ts`       | Writes `notify/<handle>`                                                       |

## Related docs

- [Operator scripts](../07-operations/operator-scripts.md) — what writes `run/` and `logs/`
