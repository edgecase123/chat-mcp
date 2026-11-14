---
title: Operator scripts
updated: 2026-11-14
covers:
  - scripts/agent
  - scripts/web
  - scripts/lib/procctl.sh
---

# Operator scripts

Two scripts own the long-running processes, so neither one needs a terminal held
open or a pid found by hand.

```
./scripts/agent  start|stop|restart|status  <handle> [dir|--now]
./scripts/web    start|stop|restart|status  [handle]
```

---

## What each verb does

| Verb | `agent <handle>` | `web` |
|---|---|---|
| `start` | Builds `dist/` if stale, answers the container confirmation banner, detaches, waits for the supervisor to listen | Builds `dist/` if stale, detaches, waits for a url, **prints the token-bearing url** |
| `stop` | Delegates to `chat-mcp agents stop`, which is graceful and waits out its own grace period | Sends `SIGTERM`, escalates to `SIGKILL` after 10s |
| `restart` | In-place reload if something is listening, otherwise a cold start | Stop then start |
| `status` | Listening, supervisor pid, container state, log path | Server pid, port, url file, log path |

With no handle, `agent status` lists every agent that is actually running.

## The three things worth knowing before you change them

**1. The web url you need is not the url in the state file.** Every web start
mints a fresh API token, and the banner is the only place the token-bearing url
is published. `~/.chat-mcp/web-url` holds the *plain* url deliberately, because
a container can read that file. So `web start` scrapes the handshake url out of
its own log and prints it, and `web restart` prints the new one. Detaching the
server without that step leaves the UI unreachable with no visible error.

**2. `restart` means two different things, and the socket decides which.**
`chat-mcp agents restart <handle>` requires a supervisor already listening and
just errors from cold. The script probes the socket and picks the in-place
reload or a full start. That split is why the script exists.

**3. Liveness is a real connect, never a file test.** `~/.chat-mcp/sock/<handle>`
survives a `SIGKILL`, so the file proves nothing. `pc_socket_live` opens the
socket with a 2s ceiling. Ten stale sockets from test runs on 2026-10-31 read as
ten running agents before this was measured.

## Two things the scripts secure that the CLI does not

**The handle is validated before any path is built.** A handle becomes a
filename in three places — the pidfile, the logfile and the supervisor socket —
and all three are constructed before `node` runs. So `src/util/naming.ts`'s
`assertHandle` is reached too late to protect them, and `agent start ../../x`
would have written outside the state directory. `pc_assert_handle` carries a
copy of that regex, `[a-z0-9][a-z0-9_-]{0,63}`. **Keep the two identical.**

A listing *skips* a junk filename rather than aborting on it. Only a handle the
operator typed is worth refusing.

**The log holds a credential, so it is `0600` and its directory is `0700`.**
The web banner contains the session API token and the banner goes straight into
the log. The file is created under `umask 077` *before* anything is written, so
the token never exists in a readable file even momentarily. The parent state dir
is already `0700`, which makes this defence in depth — but a `CHAT_MCP_HOME`
pointed somewhere laxer would otherwise publish the token.

## What they refuse to do

- **Kill a process they did not start.** If port 3737 is bound by an unknown
  pid, `web start` and `web stop` both report that pid and exit non-zero.
- **Start over a live one.** A second `start` reports the running pid and exits
  `0`, rather than racing.
- **Treat a stale pidfile as "not running".** It is removed and reported, since
  a stale pidfile and a clean first run otherwise look identical.

## Common pitfalls

🛑 **`lsof` exits 1 when a port is free, and `sed` exits 2 on a missing log.**
Both are normal first-run cases. Under `set -o pipefail` either one propagated
through its pipeline, failed the assignment, and `set -e` killed the script with
**no output at all**. Any new pipeline reading an optional file or an unbound
port needs `|| true` inside the braces.

⚠️ **`docker inspect` on a missing container exits 1 *and* prints a bare
newline.** A `|| printf 'absent'` fallback appends to that newline. Capture,
strip whitespace, then default.

⚠️ **The port is pinned to 3737 on purpose.** `chat-mcp web` falls back to an
OS-assigned port when its preferred one is taken, which would leave `stop` and
`status` with nothing fixed to check. Passing `--port` makes a clash loud.

## Environment overrides

| Variable | Default | Effect |
|---|---|---|
| `CHAT_MCP_HOME` | `~/.chat-mcp` | State dir. Honoured by the scripts **and** the CLI, so they cannot disagree |
| `CHAT_MCP_WEB_PORT` | `3737` | Web UI port |
| `CHAT_MCP_WEB_HANDLE` | `leejenkins` | Bus handle the web UI joins as |
| `AGENT_START_TIMEOUT` | `300` | Seconds to wait for a supervisor to listen |
| `WEB_START_TIMEOUT` | `60` | Seconds to wait for a web url |

---

## Source files

| File | Role |
|---|---|
| `scripts/lib/procctl.sh` | Sourced by both. Pidfiles, logs, detached spawn, liveness, the socket probe |
| `scripts/agent` | Supervisor and container lifecycle for one handle |
| `scripts/web` | Browser chat UI lifecycle |

## Related docs

- [The state directory](../03-infrastructure/state-directory.md) — where `run/` and `logs/` live
