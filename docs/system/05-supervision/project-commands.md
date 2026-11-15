---
title: Project commands
updated: 2026-11-15
covers:
  - src/supervise/run-command-service.ts
  - src/supervise/run-script.ts
  - src/shim/tools/run_command.ts
  - src/supervise/broker.ts
---

# Project commands

How an agent runs one of its project's declared commands on the host, and the
two limits that bound it.

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

## The two limits

| limit | default | bounds |
|---|---|---|
| timeout | 15 min | how LONG one command runs |
| per-handle concurrency | 4 | how MANY of a handle's commands run at once |

**The concurrency cap is per handle, by lee's ruling of 2026-11-15.** Without
it an agent could start host processes as fast as it issued tool calls, because
the timeout bounds duration and nothing bounded starts.

Both are overridable through `RunCommandOptions`, which is also the test seam.

### What the cap does and does not do

- **A command over the cap WAITS.** It is not refused, so a caller sees latency
  rather than an error.
- **A command refused for its name or its script path takes no slot**, so a bad
  request is answered immediately rather than queueing behind running work.
- **A failed command returns its slot**, so one failure cannot wedge a handle.
- **A cap below 1 is read as 1.** Honouring a 0 would wait forever.

## Common pitfalls

🛑 **`broker.ts` has a second cap, and the broker route is DEAD at runtime.**
`maxInFlight` limits dispatches per broker, across all of that broker's handles,
and `broker.ts:213` refuses the 5th envelope before dispatch reaches the
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
| `src/supervise/run-script.ts` | Spawns the process and classifies how it ended |
| `src/shim/tools/run_command.ts` | The `list_commands` and `run_command` tools |
| `src/supervise/broker.ts` | The socket consumer, with its own `maxInFlight` |

## Related docs

- [Settings reference](../03-infrastructure/settings.md) — every default in one table
