---
title: Project commands
updated: 2026-11-17
covers:
  - src/supervise/commands.ts
  - src/supervise/run-command-service.ts
  - src/supervise/command-limits.ts
  - src/supervise/run-script.ts
  - src/shim/tools/run_command.ts
  - src/supervise/broker.ts
---

# Project commands

How an agent runs one of its project's declared commands on the host, the
three limits that bound it, and how an operator changes them.

---

## The path

```
shim run_command.ts ──────→ runCommandFor ──→ runScript ──→ child_process
broker.ts            ─ ─ ┘   (dead: no src/ importer, see pitfalls)
```

Both consumers reach the host through `runCommandFor`, which is the only place
that authorizes a command and the only place that limits it. **Only the shim
tool can run today.**

**The manifest decides everything.** A command's name, its script and its
directory come from `manifestDir()/<handle>.json`, which the agent cannot edit.
A name missing from it cannot be run however it is spelled.

## A containerized agent gets no commands at all

```
sandbox "host"     the command runs                     unchanged
sandbox "docker"   REFUSED, before the manifest is read, before any slot
```

🛑 **Because the host would be running bytes the agent chose.** The project
directory is bind-mounted WRITABLE — it is the agent's own clone and it has to
be — and `runScript` reaches that same directory with `execFile`, on the host,
as the operator. So the agent can rewrite the body of a command the operator
already approved.

lee, 2026-11-15: _"anything the agent can write is NOT trusted to run outside
of the container."_

⚠️ **`readOnlyPaths` cannot close this at any depth, and it looks like it can.**
A `:ro` bind holds only while every directory between it and the project root
is itself a mountpoint, and only the root is. Measured on four shapes: a direct
child of the root holds, and anything nested is defeated by renaming an
ancestor and symlinking its name back. The host then resolves the agent's file,
because `checkedProjectPath` requires only that the realpath stay INSIDE the
project.

**Where the mode comes from, and why it is not a flag anyone passes:**

| construction site | mode     | why it is derived, not assumed                           |
| ----------------- | -------- | -------------------------------------------------------- |
| `runShim`         | `host`   | it speaks stdio to the process that launched it          |
| `openHostBus`     | `docker` | `startSupervisor` opens it only under `isContainerSpawn` |

🛑 **`RunCommandOptions.sandbox` is REQUIRED and `opts` is no longer defaulted.**
A transport that omits it is a compile error. An optional field would fail
OPEN, which is the wrong direction for the only guard between a sandboxed agent
and `execFile`.

**Running such a command INSIDE the container is a separate piece of work.**
This refusal closes the hole; it does not add the capability back.

## How a parameter reaches the script

**As `--name=value`, one argv entry per declared param.** A command declaring
`lane` and called with `{ lane: "php" }` runs its script with a single argument,
`--lane=php`.

🛑 **BREAKING FOR EVERY EXISTING MANIFEST'S SCRIPTS, AND NOTHING WARNS.** The
values used to arrive as bare positionals, so a script read them as `$1`, `$2`.
A script still reading `$1` now receives the literal `--lane=php`. Nothing in
`src/` ships a manifest, so the count of affected scripts is whatever hosts
have on disk and is unmeasured.

The migration is flag parsing:

```sh
for arg in "$@"; do
  case "$arg" in --lane=*) lane="${arg#--lane=}" ;; esac
done
```

**Why, in one line:** a host that inserted a param into the middle of a
command's list used to shift every argument after it. The agent saw no change,
every value was still individually valid, so nothing refused the call and the
script ran the right number of arguments in the wrong places.

lee, 2026-11-15: _"params would have to be named"_.

⚠️ **ARGV ORDER STILL FOLLOWS THE DECLARATION.** Nothing sorts it. What the
named form buys is that no entry's MEANING depends on that order, which is a
weaker and more useful guarantee than a stable order would be.

**A value is never its own argv entry**, because it rides after the `=`. That
narrows the free-form-value problem that keeps `ParamType` at `enum` alone; it
does not close it, since `--mode=--upload-pack=…` is still one entry whose
meaning is the callee's to decide.

## The three limits

| limit                  | default | set via          | bounds                                            |
| ---------------------- | ------- | ---------------- | ------------------------------------------------- |
| timeout                | 15 min  | `timeoutMinutes` | how LONG one command runs                         |
| per-handle concurrency | 4       | `maxConcurrent`  | how MANY of a handle's commands run at once       |
| output buffer          | 8 MB    | `maxBufferMb`    | how MUCH a command may print before it is cut off |

**The concurrency cap is per handle, by lee's ruling of 2026-11-15.** Without
it an agent could start host processes as fast as it issued tool calls, because
the timeout bounds duration and nothing bounded starts.

All three are overridable through `RunCommandOptions`, which is also the test
seam. An option passed there beats the file.

### What the cap does and does not do

- **A command over the cap is REFUSED, at once.** It reads _"the command runner
  is busy; retry"_. That is the SHAPE of the broker's own cap refusal, not the
  same sentence: the broker says _"the broker is busy; retry"_, and there is no
  broker on this route to name. Nothing queues and nothing waits.
- **A command refused for its name or its script path takes no slot**, so it is
  refused for the real reason rather than told to retry.
- **A failed command returns its slot**, so one failure cannot wedge a handle.
- **A cap below 1 is read as 1.** Honouring a 0 would refuse every command.

🛑 **THE REFUSAL IS THE POINT, BY lee's RULING OF 2026-11-15.** Waiting was the
original behaviour and it made a throttled command indistinguishable from a
hung one, so a caller had no correct reaction available. A refusal is an error
the caller can act on: retry it, or stop.

## Configuring the limits

An operator sets all three in **`limits.json`**, in the state directory. There
is no command that writes it — create it by hand.

```json
{ "maxConcurrent": 2, "timeoutMinutes": 30, "maxBufferMb": 4 }
```

🛑 **IT LIVES IN `stateDir()` BECAUSE THAT DIRECTORY IS BIND-MOUNTED INTO NO
CONTAINER.** `assertProjectDirOutsideState` already asserts a project tree is
disjoint from the state directory, and the project tree is the only host
directory a containerized agent gets read-write. A limits file under the
project tree would be one the agent could edit to widen its own cap.

**Every key is optional.** A key you leave out keeps its default, and a missing
file means all three defaults. Nothing has to be written for the feature to
work.

**The unit is in the key name**, because a `timeout` of 15 is ambiguous and a
`timeoutMinutes` of 15 is not.

### Each limit, and when to change it

- **`maxConcurrent`** — how many of one handle's commands run at once.
  **This is a security limit, not a preference.** It is the only thing stopping
  an agent starting host processes as fast as it can issue tool calls. Lower it
  when an agent's commands are heavy enough that four at once hurts the host.
  A value below 1 is read as 1, and the ceiling is 64.
- **`timeoutMinutes`** — how long one command may run before it is killed.
  Raise it for a slow gate or a deploy. Lower it if a wedged command should be
  reaped sooner. Greater than zero, and the ceiling is 1440 — one day.
- **`maxBufferMb`** — how much a command may print. Exceeding it fails the
  command, because output past the cap is not safe to return. Raise it for a
  verbose test run. Greater than zero, and the ceiling is 1024.

🛑 **EACH CEILING EXISTS BECAUSE VALIDATING THE INPUT DOES NOT BOUND THE
PRODUCT.** `1e305` is a finite number, and `1e305 * 60 * 1000` is `Infinity` —
so without a ceiling a `timeoutMinutes` that passed every check gave no timeout
at all, which is the bound this file exists to make configurable.

### What a bad value does

| in the file                                           | result                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------ |
| the file is absent                                    | all three defaults. The normal case.                               |
| the file is not readable JSON                         | **the command is REFUSED**                                         |
| the file is not a JSON object                         | **the command is REFUSED**                                         |
| a key is misspelled                                   | **the command is REFUSED**, naming the key and the three real ones |
| a key is not a finite number                          | **the command is REFUSED**, naming the key                         |
| a key is above its ceiling                            | **the command is REFUSED**, naming the ceiling                     |
| `timeoutMinutes` or `maxBufferMb` is zero or negative | **the command is REFUSED**, naming the key                         |
| `maxConcurrent` is zero or negative                   | read as 1                                                          |

🛑 **A BAD FILE REFUSES RATHER THAN FALLING BACK.** Falling back would hand the
caller the PERMISSIVE default while the operator's tightened value sat in the
file looking applied. For the concurrency cap that is a security limit failing
open.

🛑 **A MISSPELLED KEY IS REFUSED TOO, AND THAT IS THE POINT.** It is the one bad
input that still parses, so ignoring it was the same silent fallback one step
removed: `maxConcurent` with one `r` left the cap at 4 with the file reading
correct at a glance.

⚠️ **THE REFUSAL THE AGENT SEES DOES NOT NAME THE PATH.** It reads _"the command
limits on this host are not readable"_. `limits.json` is inside the directory
the container boundary exists to hide, so the path and the key ride in the
host's log instead.

### When a change takes effect

**On the next command.** The file is re-read on every call, so no restart is
needed.

🛑 **A RAISED CAP BINDS ON THE VERY NEXT COMMAND.** The file is read on every
call and nothing awaits between that read and the slot being taken, so a
refusal is always measured against the file as it stands now.

⚠️ **A COMMAND ALREADY RUNNING IS NEVER RE-CHECKED.** Lowering the cap refuses
the next arrival. It does not interrupt work already in flight.

## Common pitfalls

🛑 **`broker.ts` has a second cap, and the broker route is DEAD at runtime.**
`maxInFlight` limits dispatches per broker, across all of that broker's handles,
and the guard in `Broker.accept` refuses the 5th envelope before dispatch
reaches the per-handle cap. Both defaults are 4, so on that route the
per-handle cap could never bite.

**It cannot run today. Measured:** nothing in `src/` imports `broker.ts`,
nothing in `src/` imports `broker-client.ts`, and nothing in `src/` sets
`CHAT_MCP_BROKER_PORT` or `CHAT_MCP_BROKER_TOKEN`. `CommandBroker.bind` is
called only from tests. #191 deletes the module.

⚠️ **So there is ONE live route — the shim tool — and the per-handle cap governs
it. If the broker is ever revived, `maxInFlight` binds first and is the wrong
shape**, because it is per broker rather than per handle.

⚠️ **The per-handle counters are module state, so one process means one set.**
That is per-handle today because one process serves one handle:
`startSupervisor` runs once per CLI invocation and `openHostBus` once per
supervisor. The counters are keyed by handle anyway, so the guarantee does not
depend on that.

---

## Source files

| File                                   | Role                                              |
| -------------------------------------- | ------------------------------------------------- |
| `src/supervise/run-command-service.ts` | Authorizes, caps and runs a named command         |
| `src/supervise/command-limits.ts`      | Reads `limits.json` and refuses an unreadable one |
| `src/supervise/run-script.ts`          | Spawns the process and classifies how it ended    |
| `src/shim/tools/run_command.ts`        | The `list_commands` and `run_command` tools       |
| `src/supervise/broker.ts`              | The socket consumer, with its own `maxInFlight`   |

## Related docs

- [Settings reference](../03-infrastructure/settings.md) — every default in one table
