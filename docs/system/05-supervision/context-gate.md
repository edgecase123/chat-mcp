---
title: Context Restart Gate
updated: 2026-11-18
covers:
  - src/storage/context-gate.ts
  - web/assets/logic.js
  - web/assets/style.css
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

## The ramp below the gate is the WEB UI's COLOUR

`src/shim/context-ramp.ts` computes the quiet approach lee asked for — _"the
gradients should be 50% of that, 75% of that, 85% of that"_ — as fractions of
the handle's own gate. The percentage beside an agent's name is where they land:

| Band  | Fraction | At gate 50 | At gate 80 | Colour                     |
| ----- | -------- | ---------- | ---------- | -------------------------- |
| below | —        | < 25.0     | < 40       | default, not bold          |
| 1     | 50%      | 25.0       | 40         | yellow, bold               |
| 2     | 75%      | 37.5       | 60         | orange, bold               |
| 3     | 85%      | 42.5       | 68         | red, bold                  |
| GATE  | 100%     | 50         | 80         | restart — no fourth colour |

🛑 **THE AUDIENCE IS THE OPERATOR'S SCREEN, NOT THE BUS.** lee ruled this on
2026-11-18. A room post was the alternative and it is vacuous: no `-agent`
handle is a member of any room, so there is no room to pick, and a new one
would need membership plumbing whose only reader is this page anyway.

🛑 **NO HYSTERESIS — lee ruled "A-Stateless".** The colour steps back down the
instant the fill does. `gauge.ts` BANDS carry a reset 5 points under each warn
because a notification has chatter to stop; a colour has none, and
`gaugeDisplay` is a pure function with nowhere to keep a latch.

### Why the ticks are computed server-side

`web/assets/logic.js` cannot import from `src/`, so the browser would have
needed its own copy of 0.5/0.75/0.85. `/api/whoami` ships `context_ramp` per
peer instead, from `rampFor`, which stays the one home for lee's fractions.

⚠️ **The display call passes floor 0; the supervisor's does not.** A floor skips
bands a child spawned past, so its restart warnings do not all fire on turn 0.
A colour fires nothing, so a skipped tick would only make the gauge jump a
shade.

### The colours are tokens, and the contrast is asserted

Each band has one token per theme — `--ramp-1`, `--ramp-2`, `--ramp-3` — and
`test/web/ramp-contrast.test.ts` holds every band above the 4.5 AA floor on
every ground in every theme.

🛑 **BOLD IS FOR SCANNING AND CANNOT SUBSTITUTE FOR CONTRAST.** The gauge is
11px, so WCAG's large-text relief never applies and the floor stays 4.5 at any
weight. The band that shipped before this worked the other way round: both
`.is-soft` and `.is-warn` read a `--warning` token that **no theme defined**,
behind a hardcoded amber fallback, which measured 4.73 in light and **3.41 in
dark** — below AA in exactly one theme, silently.

⚠️ **Band 1 in light mode is a dark gold, not a true yellow.** A true yellow
cannot clear 4.5 against white at any weight.

## Common pitfalls

**A gate of 50 restarts a container child roughly every 9 turns.** Measured on
2026-11-17: a fresh haiku child sat at a **14.4% floor** before any work and
crossed 50% on **turn 9**, about two minutes in, with a flat 10-18s per turn.
Raise the handle's gate if its task needs longer than that.

**14.4 is not a constant.** It is that child's system prompt plus its tool
definitions, so a different MCP set moves it. Read the turn-0 fill at spawn
rather than hardcoding a floor.

**The old absolute 50/70/85/95 web colours are RETIRED.** A handle on the
default gate is restarted before it can reach 70, so three of those four could
never render. `BANDS` in `src/shim/gauge.ts` still drives the bus DM and room
posts; it no longer drives any colour.

---

## Source files

| File                             | Role                                             |
| -------------------------------- | ------------------------------------------------ |
| `src/storage/context-gate.ts`    | resolves the gate, validates every layer on read |
| `src/shim/gauge-report.ts`       | `contextPercent`, the one rounding rule          |
| `src/shim/context-ramp.ts`       | the quiet bands below the gate, as fractions     |
| `src/cli/web/server.ts`          | ships `context_ramp` per peer on `/api/whoami`   |
| `web/assets/logic.js`            | `rampBand` — which tick a fill has reached       |
| `web/assets/style.css`           | the three `--ramp-*` tokens, one set per theme   |
| `src/supervise/index.ts`         | the trigger, the per-child latch, the restart    |
| `src/supervise/context-gauge.ts` | the driver's reading, normalised across vendors  |

## Related docs

- [Agent Liveness](agent-liveness.md) — how a dead child is noticed and announced
- [Stopping Agents](../06-interfaces/stopping-agents.md) — the graceful stop this restart shares its wait with
- [Settings](../03-infrastructure/settings.md) — where the global default is stored
