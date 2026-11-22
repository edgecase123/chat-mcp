---
title: Context Restart Gate
updated: 2026-11-22
covers:
  - src/storage/context-gate.ts
  - src/cli/web/server.ts
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

## Changing a gate from the browser

The Agents panel carries the control. Each row shows its agent's gate and the
layer that answered; the panel footer shows the global default.

```
smoke-a                      42%
bound 2m · smoke-a-agent
[Stop] [Stop now]
Gate 25% · set for this agent      [Edit]
  [ 25 ] %  [Set] [Clear]
  this agent already reports 42% — a gate at or below its spawn fill
  means nothing will restart it, and the supervisor says so once
---------------------------------------------------
Default gate 35%   [ __ ] % [Set]
```

🛑 **The row's gate belongs to the CHILD; the Stop buttons target the
SUPERVISOR.** Those are two different handles on one row, and they differ by a
suffix, so posting the wrong one reads as correct and comes back 404.

🛑 **`[Clear]` appears only on a handle OVERRIDE.** A row reading 50 may be
overridden to 50, following a global 50, or on the built-in. Clearing removes
something in the first case only, so offering it on the other two is a button
that reports success and changes nothing. `context_gate_source` is what
separates them, and it is resolved server-side.

🛑 **The global default has no `[Clear]`, and an empty box there is REFUSED in
the browser.** An empty box is a clear, a clear needs a layer to fall back to,
and nothing sits below the global. The route answers that shape 400, so
`gateSubmission(raw, { scope: "global" })` refuses it before the round trip.
Per handle the same empty box is legal and returns that handle to the default.

⚠️ **The risk note is keyed on the agent's CURRENT fill, not its spawn floor.**
`childFloor` is a local in the supervisor process and reaches no table, so the
browser cannot see it. Current fill is always at or above that floor, which
means a gate under current fill may fire at once OR silence the child forever —
and the copy names the worse one, because it is the one an operator would not
predict.

⚠️ **The footer renders even with no agents running.** The default applies to
agents spawned later, so hiding it on an empty panel hides it exactly when an
operator is about to start one.

### Why the default is its own payload field

`/api/whoami` ships `context_gate_default` directly rather than letting the
browser infer it from the rows. A peer reports the global only while it has no
override of its own, so on a page where every agent is overridden the global
appears nowhere in the rows at all.

## When there is NO reading, the chip says WHICH kind of nothing

A blank gauge had two causes and an operator needed opposite responses to them.
A vendor that reports no context window will never fill it in, so waiting is
wasted. A vendor that does report one has simply not reported yet, and that
resolves itself.

`/api/whoami` and `/api/agents/live` therefore ship `reports_context` per row,
and `gaugeDisplay` renders three distinct states rather than one absence:

| `reports_context` | reading | chip  | means                                   |
| ----------------- | ------- | ----- | --------------------------------------- |
| `false`           | none    | `n/a` | this CLI reports no window, ever        |
| `true`            | none    | —     | reported by this driver, none yet       |
| `null`            | none    | —     | handle unregistered, so vendor unknown  |
| any               | stale   | `–`   | reporting broke; the last number is HID |
| any               | fresh   | `NN%` | a live fill, banded against its gate    |

🛑 **`n/a` AND `–` ARE DIFFERENT GLYPHS ON PURPOSE.** Both carry a null percent,
so a shared glyph would put the two states this split exists to separate back
under one mark.

🛑 **`null` IS NOT `false`.** An unregistered handle's vendor is unknown, and
labelling it `n/a` would be a confident claim about the one case the server
cannot see. `reportsContextFor` in `src/adapters/index.ts` is the non-throwing
lookup that produces the third answer — `spawnFor` throws, and `agents.json` is
the operator-edited half that `registerAgent` deliberately does not check for
spawnability.

⚠️ **The join crosses a handle suffix.** `agents.json` is keyed by the
SUPERVISOR's handle and every gauge row by its CHILD's. `reportsContextOf` tries
the row's own handle first and `supervisorHandleFor` second — the direct hit
first, because a handle a human chose ending in `-agent` looks like a child to
that inverse.

⚠️ **An operator who registers the wrong vendor mislabels the WAIT and nothing
else.** The split sits inside the no-reading branch, so once a real reading
arrives `reports_context` is never consulted again.

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

| File                             | Role                                               |
| -------------------------------- | -------------------------------------------------- |
| `src/storage/context-gate.ts`    | resolves the gate, validates every layer on read   |
| `src/shim/gauge-report.ts`       | `contextPercent`, the one rounding rule            |
| `src/shim/context-ramp.ts`       | the quiet bands below the gate, as fractions       |
| `src/cli/web/server.ts`          | ships the ramp, each gate, and the default         |
| `web/assets/logic.js`            | `rampBand`, `gateSubmission`, `gateControlDisplay` |
| `web/assets/app.js`              | `gateControl` — the row and footer controls        |
| `web/assets/style.css`           | the three `--ramp-*` tokens, one set per theme     |
| `src/supervise/index.ts`         | the trigger, the per-child latch, the restart      |
| `src/supervise/context-gauge.ts` | the driver's reading, normalised across vendors    |

## Related docs

- [Agent Liveness](agent-liveness.md) — how a dead child is noticed and announced
- [Stopping Agents](../06-interfaces/stopping-agents.md) — the graceful stop this restart shares its wait with
- [Settings](../03-infrastructure/settings.md) — where the global default is stored
