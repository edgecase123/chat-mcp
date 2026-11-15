---
title: Activity Pulse
updated: 2026-11-14
covers:
  - src/supervise/activity.ts
  - src/supervise/index.ts
  - src/cli/web/server.ts
  - src/cli/web/credential.ts
  - web/assets/logic.js
  - web/assets/app.js
  - web/assets/style.css
---

# Activity Pulse

How the web UI learns that a supervised agent is working, and why the
supervisor is the HTTP client rather than the server. Read this before adding
anything to the `/api/activity` path or changing what `web-handshake` holds.

---

## The path

```
child stdout event  ->  onEvent       ->  'tick'  ->  POST /api/activity
child turn complete ->  onTurnEnd     ->  'end'   ->  POST /api/activity
child dies          ->  onExit        ->  'end'                    |
child is REPLACED   ->  replaceChild  ->  'end'                    |
                                                                   |
                                       SSE `event: activity` to every browser
                                                   |
browser                                `nextPulses` -> one row repainted
turn ends / 30s with no tick           the dot stops
```

🛑 **THERE ARE TWO `end` SITES FOR A DEPARTING CHILD AND NEITHER IS REDUNDANT.**
`kill()` returns before the exit lands, so on a replacement `onExit` sees a
bumped generation and `ifCurrent` drops it. `clearAgentPid` is called from both
sites for exactly this reason — see `agent-liveness.md`. Deleting either one
fails a different test.

| | value | why |
|---|---|---|
| throttle | 250ms, ticks only | the dot is binary, so four a second is all a viewer can use |
| failsafe | 30s | outlasts a child that dies without an `end` |
| `end` | never throttled | it is what CLEARS the pulse |

⚠️ **THE FAILSAFE IS NOT THE NORMAL PATH.** It only has to outlast a child that
dies without reaching either `end` site. A pulse that routinely ran to 30s
would mean a working agent and a dead one look identical for half a minute,
which is the ambiguity this feature removes.

🛑 **NO POLLING ANYWHERE ON THIS PATH.** lee, 2026-11-14: *"I don't want more
polling. Everything should be event based."* Two designs with a poll in them
were dropped.

## The supervisor is the client, not the server

There is one supervisor PROCESS per handle. A web server holding a connection
per supervisor would need discovery and reconnect logic. As a client each
supervisor needs no state and the web server needs no knowledge of who exists.

## The pulse lands on the CHILD handle

`index.ts` builds it from `childBusHandle()`, never `opts.handle`.

⚠️ **MEASURED, NOT REASONED.** `list_agents` shows `claude2-agent`, and
`claude2` is not listed at all. A pulse addressed to the supervisor handle
would name a row the UI never renders. The context gauge was fixed for the
same reason — see `agent-liveness.md`.

`createActivityReporter` therefore accepts a THUNK for `handle`, because
`currentGrant` is reassigned on a child replacement and `index.ts`'s own rule
is to read `childBusHandle` rather than cache it.

## Common pitfalls

🛑 **`web-handshake` HOLDS A URL, NOT A TOKEN.** `server.ts` writes
`${url}?t=${token}`. Sending the file's contents as the cookie value fails
every request: `tokenMatches` compares lengths first, 68 against 43, and the
answer is **401**. Parse `searchParams` and send only the token.

```
cookie value                    len   result
?t= parsed out                   43   authenticates
the whole web-handshake string   68   401
```

🛑 **`/api/activity` MUST STAY IN `WRITE_ROUTES`.** An unlisted `/api/*` path
falls through to `admin`, which fails closed and is therefore safe and wrong —
the supervisor holds a write credential, so every pulse would 403 silently.

🛑 **`handleActivity` MUST NEVER TOUCH `sseClients`.** `armIdleShutdown` keys
on that set alone, and `chat-mcp web` exits after 60 idle seconds by design. A
pulse every 250ms added to that set would hold the server up forever and make
it the daemon the design rejects.

⚠️ **NEVER AWAIT THE REPORTER.** It runs while draining the child's stdout and
returns `void` on purpose. A failed POST is swallowed with no log hook: the web
server is down most of the time, so a line per failure is one log entry per
tool call forever.

## The browser half

The dot beside a peer in the sidebar pulses while that handle is working.

🛑 **A PULSE NEVER GOES THROUGH `renderSidebar()`.** That function does
`el.sidebar.innerHTML = ''` and rebuilds every row. A tick arrives every 250ms,
so routing one through it would rewrite the sidebar four times a second and
close an open `(...)` menu under the operator's cursor on every tool call.
`paintPulse` finds one row by `data-handle` and mutates it.

🛑 **AND THE PULSE STILL HAS TO SURVIVE A REBUILD.** `renderSidebar` runs on
any peer status change, so the working set lives in `state.activity` and
`sidebarItem` re-reads it. Holding the pulse as a class alone means the next
`wake` drops it **mid-turn**, which is the only moment it carries information.

| | |
|---|---|
| the working set | `state.activity`, a `Set` of handles |
| an unchanged tick | `nextPulses` returns the SAME `Set`, so the caller skips its DOM write |
| the failsafe | one re-armed `setTimeout` per handle, **never** an interval |

🛑 **TWO SEPARATE ACCESSIBILITY OBLIGATIONS, AND THE TITLE ANSWERS ONLY ONE.**
This section said the title settled both, and it did not.

| | asks | answered by |
|---|---|---|
| WCAG 1.4.1 | is meaning carried in colour alone? | `dotTitle`, in words |
| WCAG 2.2.2 | can motion running over 5s be STOPPED? | `@media (prefers-reduced-motion: reduce)` |

A turn runs for minutes and `dot-pulse` is `infinite`, so 2.2.2 applies whatever
the title says. The colour alone still separates working from online, so
stopping the animation costs the signal nothing.

⚠️ **THE `.is-fresh` CAVEAT IN `style.css` DOES NOT TRANSFER.** It warns that
`animation: none` fires no `animationend`. Nothing in `app.js` listens for
`animationend` — its four mentions are all comments. And `.is-fresh` is a
one-shot 4px translate that IS reduced, so leaving an infinite opacity loop
unreduced inverted that precedent rather than following it.

🛑 **`role="img"` IS LOAD-BEARING ON THE DOT.** `aria-label` on a bare `span`
is ignored, because a span has no role for the label to name.

🛑 **ONLY THE WORKING STATE IS NAMED.** lee, 2026-11-14: *"no title"*. Online
and offline keep carrying their meaning in colour alone, as they have since the
sidebar was written. The consequence is deliberate: the tooltip appears and
disappears with the work, and hovering an idle agent gives nothing.

⚠️ **SO `paintPulse` MUST REMOVE THE ATTRIBUTES, NOT SKIP THEM.** A null title
on an `end` is the normal case now, and an early return would leave "Working"
on the dot of an agent that stopped minutes ago.

🛑 **ROOM ROWS CARRY `data-handle` TOO**, because `renderSidebar` passes a room
NAME as `target`. The bypass lookup is therefore scoped
`[data-kind="peer"][data-handle=...]`, which makes `kind: 'peer'` true by
construction rather than asserted. Found by claude1.

---

## Source files

| File | Role |
|---|---|
| `src/supervise/activity.ts` | the reporter, the throttle, and resolving the target from `web-handshake` |
| `src/supervise/index.ts` | the wiring: `tick` on `onEvent`, `end` on `onTurnEnd`, `onExit` and `replaceChild` |
| `src/cli/web/server.ts` | `handleActivity`, and the SSE fan-out |
| `src/cli/web/credential.ts` | `/api/activity`'s capability tier, and `tokenMatches` |
| `web/assets/logic.js` | `activityEvent`, `nextPulses`, `dotTitle`, `PULSE_FAILSAFE_MS` |
| `web/assets/app.js` | the SSE listener, `paintPulse`, the per-handle failsafe |
| `web/assets/style.css` | `.sidebar__item.is-working` and `@keyframes dot-pulse` |

## Related docs

- [agent-liveness.md](agent-liveness.md) — why a per-child signal belongs on the child's bus row
- [child-output.md](child-output.md) — the streams `onEvent` and `onTurnEnd` are derived from
