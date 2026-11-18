---
title: Context Restart Gate
updated: 2026-11-17
covers:
  - src/storage/context-gate.ts
  - src/shim/context-ramp.ts
  - src/shim/gauge-report.ts
  - src/supervise/index.ts
  - src/supervise/context-gauge.ts
---

# Context Restart Gate

How a supervised child's context fill triggers its own restart, which number
decides when, and why the gate is a percentage of the window rather than a
token count.

---

## The one number, and where it comes from

A handle's **gate** is the fill percentage at which its child is restarted. It
resolves through three layers, first legal answer wins:

| Layer           | Where                   | Beats        |
| --------------- | ----------------------- | ------------ |
| handle override | `agents.context_gate`   | the global   |
| global default  | `settings.context_gate` | the built-in |
| built-in        | `DEFAULT_CONTEXT_GATE`  | nothing — 50 |

`resolveContextGate(db, handle)` is the only reader. It never throws and never
returns an illegal number, so the supervisor can call it on every reading.

🛑 **Every layer is validated on READ, not only on write.** A stored `0` would
restart every child on turn 0 and a `101` would never restart one. A hand edit,
a restored backup and a future migration all reach the same two rows, so an
illegal layer is skipped and the next one answers.

⚠️ **`null` on `agents.context_gate` means "follow the global", never 50.** A
handle reading `null` tracks a later change to the global default. One storing
`50` does not.

## What happens at the gate

```
reading arrives     onContext, every assistant event with a usage block
percent             contextPercent(used, total) — one decimal
percent >= gate ?   resolveContextGate, per reading, never cached
   yes              log it, then restartChild("graceful")
                      1  queue the externalize notice
                      2  wait for the turn AFTER the one that dispatched it
                      3  at the latest, 30s
                      4  kill, then respawn with no resumeSessionId
```

This is the same path `chat-mcp agents restart <handle>` already ran by hand.
The gate adds only the trigger.

🛑 **The notice, the countdown and the restart are ONE event with one owner.**
lee ruled this on 2026-11-17. The quiet ramp below the gate is deliberately not
part of it.

## Three things about the trigger that are not obvious

**The gate is resolved per reading, not cached at spawn.** An operator who
raises a handle's gate mid-run expects the next reading to honour it.

**The latch is per CHILD, not per process.** A replacement child's window
starts over, so its gate is a fresh event. A process-lifetime latch would
restart the first child and let every one after it fill unattended, which is
the failure the ticket exists to end.

**An unregistered child is still restarted.** The gauge gives up when the
child has no `agents` row, because a row UPDATE against a missing row is a
silent no-op. A restart writes no row, and a child filling its window without
ever reaching the bus is the case most in need of one.

## The ramp below the gate is BUILT and NOT WIRED

`src/shim/context-ramp.ts` computes the quiet approach lee asked for — _"the
gradients should be 50% of that, 75% of that, 85% of that"_ — as fractions of
the handle's own gate:

```
band 1   50% of gate      25.0 at the default gate of 50
band 2   75% of gate      37.5
band 3   85% of gate      42.5
GATE    100% of gate      50
```

Nothing calls it yet. The audience is undecided: on the live bus no `-agent`
handle is a member of any room, so a room post from a supervised child reaches
nobody.

## Common pitfalls

**A gate of 50 restarts a container child roughly every 9 turns.** Measured on
2026-11-17: a fresh haiku child sat at a **14.4% floor** before any work and
crossed 50% on **turn 9**, about two minutes in, with a flat 10-18s per turn.
Raise the handle's gate if its task needs longer than that.

**14.4 is not a constant.** It is that child's system prompt plus its tool
definitions, so a different MCP set moves it. Read the turn-0 fill at spawn
rather than hardcoding a floor.

**The old 50/70/85/95 gauge bands now sit at and above the gate.** A handle on
the default gate is restarted before it can reach 70, so three of those four
are unreachable in practice. Not yet resolved.

---

## Source files

| File                             | Role                                             |
| -------------------------------- | ------------------------------------------------ |
| `src/storage/context-gate.ts`    | resolves the gate, validates every layer on read |
| `src/shim/gauge-report.ts`       | `contextPercent`, the one rounding rule          |
| `src/shim/context-ramp.ts`       | the quiet bands below the gate — built, unwired  |
| `src/supervise/index.ts`         | the trigger, the per-child latch, the restart    |
| `src/supervise/context-gauge.ts` | the driver's reading, normalised across vendors  |

## Related docs

- [Agent Liveness](agent-liveness.md) — how a dead child is noticed and announced
- [Stopping Agents](../06-interfaces/stopping-agents.md) — the graceful stop this restart shares its wait with
- [Settings](../03-infrastructure/settings.md) — where the global default is stored
