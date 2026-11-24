---
title: The state directory
updated: 2026-11-21
covers:
  - src/util/paths.ts
  - src/util/file-lock.ts
  - src/storage/db.ts
  - src/storage/dao.ts
  - src/supervise/container.ts
  - src/supervise/mounts.ts
  - src/supervise/registrations.ts
  - src/supervise/confirmPlan.ts
  - src/cli/web/credential.ts
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

| Entry             | Owner                              | What it holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chat.db`         | `src/storage/db.ts`                | Every message, room, membership and agent row. The `-wal` and `-shm` files beside it are SQLite's, not ours                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `sock/<handle>`   | `src/supervise/socket.ts`          | Where a supervisor listens for direct delivery. **Kept short deliberately** — a unix socket path caps at ~104 bytes on macOS and a too-long one fails as a truncated bind, not a clear error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `notify/<handle>` | `src/notify/bus.ts`                | The wake file an adapter watches. A write here is what pulls an idle agent back into its inference loop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `projects.json`   | `src/index.ts` (`project` command) | Which directory each handle's agent works in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `mounts.json`     | `src/supervise/mounts.ts`          | Extra mounts a containerized handle gets beyond `/work`, each attached **read-only** at `/mnt/<key>` — the tree chooses the code that runs in the container, so a writable extra mount is a write path onto the host directory it names (#231)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `container.json`  | `src/supervise/container.ts`       | Which handles have accepted the container confirmation banner, and the image fingerprint. 🛑 **Every write goes through one locked read-modify-write**, `updateContainerState`, and there is no unlocked write path — two writers used to lose one of their changes, so an approval made on the web card could vanish while the card reported success (#377). A transient `container.json.lock` beside it names its holder's pid; a holder that is no longer running has its lock broken immediately, and a LIVE one is waited for and then refused. Written staged-then-renamed as well, so a reader needs no lock at all                                                                                                                                                                                                                                                                                                                                                        |
| `agents.json`     | `src/supervise/registrations.ts`   | The `vendor` and `mode` each handle is started with. 🛑 **It holds those two keys and nothing else, and refuses any other BY NAME** — `profile` belongs to `overrides/<handle>.json`, `display_name` to the `agents` table column, and `project_dir` to `projects.json`. ⚠️ **Unlike `projects.json` and `mounts.json`, a MALFORMED file THROWS rather than reading as empty** — an empty read here is byte-identical to the normal no-file case, so a stray comma would start a handle on the default pair in silence. 🛑 **Every write goes through one locked read-modify-write**, `updateRegistrations`, and there is no unlocked write path — two writers used to lose one of their changes, MEASURED at 4 of 6 registrations lost with eight real contending processes. A transient `agents.json.lock` beside it names its holder's pid, on the same terms as `container.json.lock`. Written staged-then-renamed as well, which rules out a TORN read but not a lost update |

| `secrets.env` | `src/supervise/auth.ts` | One credential per vendor, keyed by the env var it is injected under (`CLAUDE_CODE_OAUTH_TOKEN`, `CURSOR_API_KEY`), plus `GH_TOKEN`. Mode `0600`. 🛑 **The writer refuses three shapes of value, and all three callers share it** — empty, one containing a newline, and one containing whitespace after trimming. Leading and trailing whitespace is TRIMMED, not refused, because a trailing newline from `pbpaste` is the normal case. ⚠️ **`\s` is the boundary, not "no invisible characters"** — U+200B is matched by neither the guard nor `trim()`, so a zero-width mis-paste still stores |
| `tokens/` | `src/supervise/handle-tokens.ts` | Per-handle bus bearer tokens |
| `mcp/<handle>.json` | `src/util/paths.ts` (`mcpConfigPathFor`) | The MCP client config handed to a supervised child |
| `adapters/` | `src/util/paths.ts` (`adaptersDir`) | Installed wake-adapter scripts, one per framework and handle |
| `web-url` | `src/cli/web/server.ts` | The running web UI's **plain** url. Unlinked on shutdown |
| `aliases.sh` | `src/index.ts` (`aliases` command) | A source-able shell alias block |
| `run/*.pid`, `logs/*.log` | `scripts/lib/procctl.sh` | Written by the operator scripts, not by the CLI |

## The lock both state files take

🛑 **`container.json` and `agents.json` share ONE lock implementation**,
`withFileLock` in `src/util/file-lock.ts`. A second copy of a lock is a second
thing to get wrong: the two drift, and only one of them gets the next fix.

```
<state file>.lock     holds its holder's pid
a DEAD holder         broken immediately, no wait
a LIVE holder         waited for, then REFUSED rather than stolen
an EMPTY lock file    reads as ALIVE — a lock caught mid-creation holds no pid
```

⚠️ **The lock orders WRITERS. A reader takes nothing**, because every write is
staged and renamed, so no reader can observe a partial document.

🛑 **ONE WINDOW IS LEFT OPEN ON PURPOSE.** Two processes that both find the
same dead holder can enter the section together and lose one write. Breaking a
dead lock cannot be made conditional on the file's content with these
primitives. What is closed is every write where no stale lock is in play,
which before this was any two overlapping writers at all.

## `agents.json` vs the command line — which wins

`selectionFor` (`src/supervise/selection.ts`) composes the stored pair with
whatever the operator named on the command line. Precedence is **per axis**,
because `--container` says nothing about which CLI to drive:

| axis     | the flag wins when            | otherwise     |
| -------- | ----------------------------- | ------------- |
| `vendor` | `--driver <name>` was given   | `agents.json` |
| `mode`   | the flags resolve to `docker` | `agents.json` |

🛑 **A FLAG MAY TIGHTEN THE MODE AND MAY NEVER LOOSEN IT.** `resolveDriver`
returns `host` both for `--driver claude`, which names that mode, and for a
bare invocation that names nothing — the two are indistinguishable downstream.
Treating that `host` as an override would start an **uncontained** agent for a
handle whose `agents.json` says `docker`, with the file and the web UI both
still saying contained.

**Both spawn call sites read it, and that is deliberate.** `src/index.ts` needs
the pair to pick the `VendorSpawn` and to decide whether the container consent
gate runs; `startSupervisor` needs it again for the spawn itself. Reading the
file at only one of them builds the image for one vendor and drives the other.
`startSupervisor` takes only the **mode** from it — a library caller passing a
resolved `opts.vendor` keeps that object.

## Reading and writing `agents.json` over the API

Three routes in `src/cli/web/server.ts`, so the web UI can show and edit the
pairs without the operator opening the file:

| route                     | tier    | does                           |
| ------------------------- | ------- | ------------------------------ |
| `GET /api/agents`         | `read`  | every stored pair, see below   |
| `POST /api/agents`        | `admin` | create or replace one handle's |
| `POST /api/agents/forget` | `admin` | remove one handle's            |

🛑 **`GET /api/agents` WITHHOLDS `mode` FROM A CALLER WITHOUT `admin`.** The
handle and `vendor` are returned at `read`; `mode` is not, because it says
whether that agent runs contained and the lowest tier would otherwise read a
map of which agents have full host access.

⚠️ **THE ROUTE STAYS `read` RATHER THAN MOVING TO `admin`, and that was lee's
ruling on #367.** `/api/agents/live` already returns the handle list at `read`,
so moving this route would have protected one field by withholding a list that
is already reachable.

⚠️ **THE FILTER IS IN THE HANDLER, NOT IN `readRegistrations`.** The spawn path
reads the same store and needs `mode`.

🛑 **`/api/agents` IS NOT `/api/agents/live`.** `/live` is the socket register —
who is connected right now. This one is what the operator configured. A handle
can be in either without being in the other.

🛑 **THERE IS NO `PATCH`, AND NO HTTP `DELETE`.** `registerAgent` replaces
rather than merges, because the half a merge would carry stale is `mode` — the
one that decides whether the agent is contained. A `PATCH` verb would promise
the merge the store refuses. `DELETE` is absent because no surface in this
project uses it; `/api/agents/forget` follows `/api/agents/stop` and
`/api/rooms/delete`.

⚠️ **`GET /api/agents` IS THE ONE ADMIN ROUTE A READ CAN REACH.** Every other
path in `ADMIN_ROUTES` answers `admin` to any method, reads included. The
exception is written into `requiredCapability` and a test pins the
ADMIN ∩ READ intersection to exactly this one path, because that clause lets
`READ_ROUTES` downgrade any admin route it names.

⚠️ **A bad `mode` is a `400` and writes nothing.** `parseRecord` throws
`RegistrationInputError`, which the handler maps; anything else — a failed
write, a full disk — stays a `500`.

⚠️ **`GET /api/agents` ALSO NAMES THE VENDORS THIS BUILD CAN SPAWN**, at
every tier, as a top-level `vendors` array from `vendorsWithSpawn()`. The write
route accepts **any** non-empty vendor string and `spawnFor` is what throws —
at START time, one step removed from whoever typed it. So the surface that
collects a vendor constrains it, and it has to constrain it to this build.

## The Registered panel in the web UI

`web/assets/app.js` renders a **Registered** group on the **Agents** tab of the
settings modal. Claims say what is locked, Agents says what is **running**, and
this says what the operator **configured**.

⚠️ **IT USED TO BE A SIDEBAR CARD, BELOW AGENTS AND ABOVE PEERS.** #397 moved
it, because `renderSidebar()` rebuilds every section on any peer status change
and that wiped the register form mid-typing. See
[settings-modal.md](../06-interfaces/settings-modal.md).

| who sees what                 | `read`          | `admin`   |
| ----------------------------- | --------------- | --------- |
| handle and vendor             | yes             | yes       |
| `mode`                        | `(needs admin)` | the label |
| Forget, and the register form | hidden          | shown     |

🛑 **THE TIER COMES FROM `/api/whoami`, WHICH NOW RETURNS THE CALLER'S OWN
`capabilities`.** It is not inferred from a missing `mode` key: an empty agent
list has no `mode` on any row, which would read as non-admin and hide the form
exactly when nothing is registered yet.

⚠️ **THE FIELD DISCLOSES NOTHING, AND "the caller already exercised these to
reach here" IS NOT WHY.** `/api/whoami` is `read`-tier, so a `read` caller
reaches it without holding anything else. The reason it is safe is that a
bearer can already enumerate its own tier by probing a 200 against the 403 at
`server.ts`, so a grant is not a secret from the bearer. Settled on PR 375.

⚠️ **IN PRODUCTION TODAY EVERY BROWSER IS `admin`.** `ALL_CAPABILITIES` is
the only credential minted, so the read-only rendering is reachable from tests
alone. It is groundwork for the per-route scoping lee ruled on 2026-11-11, not
a live restriction.

🛑 **A `host` ROW SAYS "FULL HOST ACCESS", NOT JUST "host".** The word alone
reads like a neutral default while being the loosest setting in the file.

🛑 **MOVING A HANDLE FROM `docker` TO `host` CONFIRMS FIRST.** That is the
only way out of `docker`, because a flag may tighten the mode and never loosen
it. Tightening is never interrupted, and registering a brand-new handle is not
treated as a loosening — there is no recorded decision to undo, and a dialog on
every registration is how the one that matters gets clicked through.

### Approving a contained handle's plan from the card

A `docker` handle cannot start until an operator has approved the **container
plan** — the mounts, the env var names, the binary, the network mode, the image
and the two cap lines. Until #132 slice 4b that approval existed only at a
terminal, and `src/index.ts` refuses outright when it has no stdin, so a handle
registered from the browser could not be approved from the browser.

| route                          | tier    | answers                                     |
| ------------------------------ | ------- | ------------------------------------------- |
| `GET /api/agents/plan?handle=` | `admin` | the plan, the verdict and what moved        |
| `POST /api/agents/confirm`     | `admin` | records an approval, or refuses a stale one |

🛑 **THE PLAN IS ITS OWN ROUTE AND IS NOT A FIELD ON `GET /api/agents`.**
Building one needs `spawnFor`, which **throws** for a vendor this build cannot
spawn, and `agents.json` accepts any non-empty vendor string. Folded into the
list route, one mistyped row would `500` the card that is meant to display it.

🛑 **THE CONFIRM CARRIES THE PLAN THE OPERATOR SAW.** A bare `{handle}` POST
would approve a freshly built plan rather than the one on screen, which is the
substitution this gate exists to prevent. The server rebuilds the plan, diffs
it against the posted one, and a non-empty diff is a `409` naming each changed
field — nothing is recorded.

🛑 **NEITHER ROUTE IS `read`, INCLUDING THE GET.** The plan names mount paths,
env var names and the image, which together are a map of what the container is
handed. Both are listed in `ADMIN_ROUTES` and in neither read set.

⚠️ **THE CARD FORMATS NOTHING ITSELF.** `web/assets/logic.js` cannot import
from `src/`, so the route sends `planText` from `describePlan` and `changeText`
from `describeChanges` — the same words the terminal banner prints. A formatter
in the browser would be free to drift from it, and `describePlan` carries rules
a reader depends on: one mount per line and quoted, and `no limit` said out
loud for an absent cap.

⚠️ **A `host` ROW HAS NO PLAN CONTROL AT ALL**, because it will not run a
container. The route `409`s such a handle rather than showing a hypothetical
one an operator could approve.

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
