---
title: The state directory
updated: 2026-11-14
covers:
  - src/util/paths.ts
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
running agent. Set `process.env.CHAT_MCP_HOME` to a temp directory *before*
importing anything that resolves a path.

## What is in it

| Entry | Owner | What it holds |
|---|---|---|
| `chat.db` | `src/storage/db.ts` | Every message, room, membership and agent row. The `-wal` and `-shm` files beside it are SQLite's, not ours |
| `sock/<handle>` | `src/supervise/socket.ts` | Where a supervisor listens for direct delivery. **Kept short deliberately** — a unix socket path caps at ~104 bytes on macOS and a too-long one fails as a truncated bind, not a clear error |
| `notify/<handle>` | `src/notify/bus.ts` | The wake file an adapter watches. A write here is what pulls an idle agent back into its inference loop |
| `projects.json` | `src/index.ts` (`project` command) | Which directory each handle's agent works in |
| `mounts.json` | `src/supervise/mounts.ts` | Extra mounts a containerized handle gets beyond `/work` |
| `container.json` | `src/supervise/container.ts` | Which handles have accepted the container confirmation banner, and the image fingerprint |
| `secrets.env` | `src/supervise/auth.ts` | `CLAUDE_CODE_OAUTH_TOKEN` and `GH_TOKEN`. Mode `0600` |
| `tokens/` | `src/supervise/handle-tokens.ts` | Per-handle bus bearer tokens |
| `mcp/<handle>.json` | `src/util/paths.ts` (`mcpConfigPathFor`) | The MCP client config handed to a supervised child |
| `adapters/` | `src/util/paths.ts` (`adaptersDir`) | Installed wake-adapter scripts, one per framework and handle |
| `web-url` | `src/cli/web/server.ts` | The running web UI's **plain** url. Unlinked on shutdown |
| `aliases.sh` | `src/index.ts` (`aliases` command) | A source-able shell alias block |
| `run/*.pid`, `logs/*.log` | `scripts/lib/procctl.sh` | Written by the operator scripts, not by the CLI |

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

---

## Source files

| File | Role |
|---|---|
| `src/util/paths.ts` | Every path in the table above, plus `writePrivateFileSync` for the `0600` ones |
| `src/supervise/socket.ts` | Binds and unlinks `sock/<handle>` |
| `src/notify/bus.ts` | Writes `notify/<handle>` |

## Related docs

- [Operator scripts](../07-operations/operator-scripts.md) — what writes `run/` and `logs/`
