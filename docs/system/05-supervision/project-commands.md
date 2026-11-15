---
title: Project commands
updated: 2026-11-15
covers:
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

## The three limits

| limit | default | set via | bounds |
|---|---|---|---|
| timeout | 15 min | `timeoutMinutes` | how LONG one command runs |
| per-handle concurrency | 4 | `maxConcurrent` | how MANY of a handle's commands run at once |
| output buffer | 8 MB | `maxBufferMb` | how MUCH a command may print before it is cut off |

**The concurrency cap is per handle, by lee's ruling of 2026-11-15.** Without
it an agent could start host processes as fast as it issued tool calls, because
the timeout bounds duration and nothing bounded starts.

All three are overridable through `RunCommandOptions`, which is also the test
seam. An option passed there beats the file.

### What the cap does and does not do

- **A command over the cap WAITS.** It is not refused, so a caller sees latency
  rather than an error.
- **A command refused for its name or its script path takes no slot**, so a bad
  request is answered immediately rather than queueing behind running work.
- **A failed command returns its slot**, so one failure cannot wedge a handle.
- **A cap below 1 is read as 1.** Honouring a 0 would wait forever.

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
  A value below 1 is read as 1.
- **`timeoutMinutes`** — how long one command may run before it is killed.
  Raise it for a slow gate or a deploy. Lower it if a wedged command should be
  reaped sooner. It must be greater than zero.
- **`maxBufferMb`** — how much a command may print. Exceeding it fails the
  command, because output past the cap is not safe to return. Raise it for a
  verbose test run. It must be greater than zero.

### What a bad value does

| in the file | result |
|---|---|
| the file is absent | all three defaults. The normal case. |
| the file is not readable JSON | **the command is REFUSED**, naming the path |
| a key is not a finite number | **the command is REFUSED**, naming the key |
| `timeoutMinutes` or `maxBufferMb` is zero or negative | **the command is REFUSED**, naming the key |
| `maxConcurrent` is zero or negative | read as 1 |
| a key is misspelled | ignored, and that limit keeps its default |

🛑 **A BAD FILE REFUSES RATHER THAN FALLING BACK.** Falling back would hand the
caller the PERMISSIVE default while the operator's tightened value sat in the
file looking applied. For the concurrency cap that is a security limit failing
open, so the refusal names the path and the operator sees the cause.

⚠️ **A misspelled key is the one bad value that is silent.** The file parses,
so the limit it was meant to set keeps its default and nothing says so.

### When a change takes effect

**On the next command.** The file is re-read on every call, so no restart is
needed.

🛑 **A COMMAND ALREADY WAITING KEEPS THE LIMIT IT ARRIVED WITH.** `acquireSlot`
is given a number, not a way to re-read one, so lowering the cap cannot strand a
queue that formed under the old one. The counter and the limit can never
disagree for the life of a parked command.

## Common pitfalls

🛑 **`broker.ts` has a second cap, and the broker route is DEAD at runtime.**
`maxInFlight` limits dispatches per broker, across all of that broker's handles,
and `broker.ts:199` refuses the 5th envelope before dispatch reaches the
per-handle cap. Both defaults are 4, so on that route the per-handle cap could
never bite.

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

| File | Role |
|---|---|
| `src/supervise/run-command-service.ts` | Authorizes, caps and runs a named command |
| `src/supervise/command-limits.ts` | Reads `limits.json` and refuses an unreadable one |
| `src/supervise/run-script.ts` | Spawns the process and classifies how it ended |
| `src/shim/tools/run_command.ts` | The `list_commands` and `run_command` tools |
| `src/supervise/broker.ts` | The socket consumer, with its own `maxInFlight` |

## Related docs

- [Settings reference](../03-infrastructure/settings.md) — every default in one table
