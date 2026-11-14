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

**Both carry `--help`.** `./scripts/agent --help` is the authoritative signature
and is kept in the script, not here, so it cannot drift from the code.

---

## Calling signature

### `./scripts/agent <verb> [handle] [dir|--now]`

| Call | Meaning |
|---|---|
| `agent start <handle>` | Project dir comes from `projects.json` |
| `agent start <handle> <dir>` | `<dir>` overrides it and must already exist |
| `agent stop <handle>` | Graceful, via `chat-mcp agents stop` |
| `agent stop <handle> --now` | Skips the notice wait only |
| `agent restart <handle>` | In-place reload, or cold start — the socket decides |
| `agent status <handle>` | That one handle |
| `agent status` | Every **running** agent; stale sockets are skipped |

### `./scripts/web <verb> [handle]`

| Call | Meaning |
|---|---|
| `web start` | Handle defaults to `$CHAT_MCP_WEB_HANDLE`, then `leejenkins` |
| `web start <handle>` | Joins the bus as `<handle>` instead |
| `web stop` | No handle — there is one server per port |
| `web restart [handle]` | Stop then start. **Mints a new token** |
| `web status` | Pid, port, both url files, log path |

### Arguments

| Argument | Rule |
|---|---|
| `<handle>` | Lowercase, `[a-z0-9][a-z0-9_-]{0,63}`. It becomes a filename and a socket path, so it is validated **before any path is built** |
| `[dir]` | `agent start` only. Must exist. Register one instead with `node dist/index.js project set <handle> <dir>` |
| `--now` | `agent stop` only. 🛑 **Not "immediately"** — the container still waits out its own shutdown grace |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Done, or already in the state you asked for. A second `stop` is `0` |
| `1` | Refused, or it failed. The reason is on stderr |
| `2` | Bad usage. `--help` is `0`, no arguments is `2` |

🛑 **This table is pinned by `test/scripts/operator-scripts.test.ts`**, which
asserts the exit code of every documented call. It exists because
`[ -n "$H" ] || usage; exit 2` shipped: the `;` ends the `||` list, so `exit 2`
ran **unconditionally** and every verb needing a handle exited 2 before doing
anything. `bash -n` passes it and shellcheck does not flag it. Only asserting
exit codes caught it, and the mutant is re-run in that file's last test.

---

## What each verb does

| Verb | `agent <handle>` | `web` |
|---|---|---|
| `start` | Builds `dist/` if stale, answers the container confirmation banner, detaches, waits for the supervisor to listen | Builds `dist/` if stale, detaches, waits for a url, **prints the token-bearing url** |
| `stop` | Delegates to `chat-mcp agents stop`, which is graceful and waits out its own grace period | Sends `SIGTERM`, escalates to `SIGKILL` after 10s |
| `restart` | In-place reload if something is listening, otherwise a cold start | Stop then start |
| `status` | Listening, supervisor pid, container state, log path | Server pid, port, url file, log path |

With no handle, `agent status` lists every agent that is actually running.

## 🛑 The web server is not a daemon, and that is deliberate

`server.ts:188` arms a **60-second idle shutdown at boot**, and `server.ts:196`
calls `shutdown(0)`. The comment there says it *"keeps us honest about the
no-persistent-daemon design principle."* Nothing disarms that timer until a
browser opens an SSE stream on `/api/events`.

```
web start  →  prints tokenized url        idle timer ARMED (60s)
you paste  →  token sets an HttpOnly cookie, redirects it out of the address bar
           →  page opens EventSource /api/events
           →  cookie matches ctx.token → SSE connects → timer DISARMED
```

So **`web start` gives you 60 seconds to paste the url.** Miss it and the
server exits by design. Run `web start` again.

⚠️ **An already-open tab does not revive itself after a restart.** `EventSource`
auto-reconnects, but it presents the *previous* server's cookie, the auth gate
returns 401 before `sseClients.add` is reached, and the client only logs the
error. A 401 therefore cannot hold the server open either. **Pasting the new
url is the only thing that revives that tab.**

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

**3. Liveness is a real connect with THREE outcomes, never a file test.**
`~/.chat-mcp/sock/<handle>` survives a `SIGKILL`, so the file proves nothing.
Ten stale sockets from test runs on 2026-10-31 read as ten running agents before
this was measured.

`pc_socket_live` returns `0` for a listener, `1` for `ECONNREFUSED`/`ENOENT`,
and **`2` for "the probe itself failed"** — a timeout, `EMFILE`, anything else.
Two outcomes made it fail open, and the worst case was silent: a live agent read
as absent, `agent start` warned about a stale socket and spawned a **second**
supervisor, and binding unlinks a socket that looks stale — cutting delivery to
the agent that was already running. Callers use `pc_require_socket_verdict`,
which dies on `2` rather than guessing.

## Two things the scripts secure that the CLI does not

**The handle is validated before any path is built, with an ENUMERATED
character class.** A bash `[a-z]` range uses locale collation: under
`en_US.UTF-8` it matched `álice` while the TypeScript twin refused it, measured
on darwin. `LC_ALL=C [[ ... ]]` is **not** the fix — `[[` is a shell keyword, so
the prefix is parsed as a command name, bash reports `[[: command not found`,
and the guard then refuses *every* handle while looking like it works.

Why it is validated at all: A handle becomes a
filename in three places — the pidfile, the logfile and the supervisor socket —
and all three are constructed before `node` runs. So `src/util/naming.ts`'s
`assertHandle` is reached too late to protect them, and `agent start ../../x`
would have written outside the state directory. `pc_assert_handle` carries a
copy of that regex, `[a-z0-9][a-z0-9_-]{0,63}`. **Keep the two identical.**

A listing *skips* a junk filename rather than aborting on it. Only a handle the
operator typed is worth refusing.

**The log holds a credential, so it is `0600` and its directories are `0700`.**
The web banner contains the session API token and goes straight into the log.
The file is created under `umask 077` before the first write, and then
`pc_chmod_verified` **reads the mode back and dies if it is wrong**. That
matters because `: > "$log"` on a pre-existing `0644` file keeps `0644`, so
creation-time umask alone would not fix an operator upgrading from an earlier
version.

🛑 **A chmod can succeed and change nothing.** exFAT, SMB and WSL's DrvFs all
accept the call and keep the old mode. `src/util/paths.ts` carries
`chmodVerified` for exactly this, and discarding the error here would have left
a credential world-readable while this page claimed `0600`. Point
`CHAT_MCP_HOME` at a real unix filesystem or the scripts refuse to start.

✅ **The token is no longer scraped from the log.** `src/cli/web/credential.ts`
states the invariant that the token is never written under `stateDir()`, because
#162 measured the whole state dir bind-mounted into every container. **That was
re-measured on 2026-11-14 and is no longer true** — with the real mount set
(`/work` plus one configured extra mount at `/mnt/<key>`) the state dir is not present in the container
at all, `/work/..` is the container root, and `assertProjectDirOutsideState`
refuses any registered mount overlapping it.

So the server now writes `~/.chat-mcp/web-handshake` through
`writePrivateFileSync` (0600) and unlinks it on shutdown, this script reads that
file, and the url is redacted out of the log. `web-url` stays plain, because
that is the well-known file external readers expect.

⚠️ **The redaction is a truncate-and-rewrite**, so a log line written in the
same sub-second window can be lost. Losing a log line is acceptable; leaving a
credential is not.

## What they refuse to do

- **Kill a process they did not start, or a pid they cannot identify.** Before
  any signal, `web` requires the pid to equal the one bound to its port and
  `agent` requires its command line to contain `dist/index.js … supervise`.
  Both print what the pid actually is and exit non-zero. Verified by planting
  pid `1` in each pidfile: both refused and named `/sbin/launchd`.
  This matters because the idle shutdown makes a stale pidfile the **normal**
  resting state for `web`, and the kernel recycles pids.
- **Trust `kill -0` as an existence test.** For another user's pid it fails with
  EPERM, indistinguishable from ESRCH at the shell, so a live process read as
  dead. `pc_alive` uses `ps -p`.
- **Signal a pid that is not a positive integer.** A `0` in a pidfile would
  signal the script's whole process group.
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
| `test/scripts/operator-scripts.test.ts` | Pins the exit-code table above. Every case is side-effect free — nothing here starts a container or binds a port |

## Related docs

- [The state directory](../03-infrastructure/state-directory.md) — where `run/` and `logs/` live
