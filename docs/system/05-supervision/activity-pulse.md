---
title: Activity Pulse
updated: 2026-11-14
covers:
  - src/supervise/activity.ts
  - src/supervise/index.ts
  - src/cli/web/server.ts
  - src/cli/web/credential.ts
---

# Activity Pulse

How the web UI learns that a supervised agent is working, and why the
supervisor is the HTTP client rather than the server. Read this before adding
anything to the `/api/activity` path or changing what `web-handshake` holds.

---

## The path

```
child stdout event  ->  onEvent        ->  reportActivity('tick')  ->  POST /api/activity
child turn complete ->  onTurnEnd      ->  reportActivity('end')   ->  POST /api/activity
                                                                        |
                                            SSE `event: activity` to every browser
```

| | value | why |
|---|---|---|
| throttle | 250ms, ticks only | the dot is binary, so four a second is all a viewer can use |
| failsafe | 30s | outlasts a child that dies without an `end` |
| `end` | never throttled | it is what CLEARS the pulse |

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

## Not done yet

**The browser does not render this.** Nothing consumes `event: activity`. The
SSE frame is emitted and no page listens, so the pulse is observable only with
a client of your own. #240 tracks the renderer.

---

## Source files

| File | Role |
|---|---|
| `src/supervise/activity.ts` | the reporter, the throttle, and resolving the target from `web-handshake` |
| `src/supervise/index.ts` | the three wiring lines, inside `ifCurrent` so a dead child cannot pulse |
| `src/cli/web/server.ts` | `handleActivity`, and the SSE fan-out |
| `src/cli/web/credential.ts` | `/api/activity`'s capability tier, and `tokenMatches` |

## Related docs

- [agent-liveness.md](agent-liveness.md) — why a per-child signal belongs on the child's bus row
- [child-output.md](child-output.md) — the streams `onEvent` and `onTurnEnd` are derived from
