---
title: Agent Liveness
updated: 2026-11-14
covers:
  - src/storage/dao.ts
  - src/messaging/room-send.ts
  - src/supervise/index.ts
  - src/supervise/host-bus.ts
---

# Agent Liveness

How the bus decides whether a handle has anybody behind it, and why a
containerized child needed a fix that a host child never did.

---

## `online` is a pid check, nothing more

`list_agents`, `whoami`, the ink panes and the one-shot `list` all read one
field. It is computed in `hydrate`:

```
online: isProcessAlive(row.pid)        src/storage/dao.ts
```

`isProcessAlive` is `process.kill(pid, 0)`, treating `EPERM` as alive. So the
whole question is **whose pid is in that row**.

```
HOST child         its own shim registers      row.pid = the CHILD    ✅
CONTAINERIZED      the host bus registers      row.pid = the SUPERVISOR
```

A container has no route to `chat.db` — the state-dir mount was deleted. It is
an HTTP client of `openHostBus`, which calls `shimContextFor` **in the
supervisor process**, so `pid: process.pid` is the supervisor's.

## 🛑 The defect that followed, and the fix

An exited dockerized child therefore read `online: true` until its supervisor
died. A sibling agent asked it for a review, `room_send` reported the message
delivered, and nothing was running to read it. That is chat-mcp#229.

**The supervisor now nulls the child's row pid when the child exits.**

```
child.onExit  ->  dao.clearAgentPid(db, childBusHandle())
```

`isProcessAlive(null)` is already `false`, so **no consumer of `online`
changed**. The field simply became true.

Three properties make that safe, and each has a test:

| property | why it matters |
|---|---|
| the row is **updated, not deleted** | the handle stays visible to `listAgents(db, true)` as offline, instead of vanishing |
| `last_seen_at` is **not touched** | the child is gone, so its last real activity is the honest value |
| a restart needs **no `force`** | `refuseLiveRival` returns early on a null incumbent pid, and the claim guard is `WHERE agents.pid IS @expected_pid` against the row's own value |

⚠️ **The handle cleared is the CHILD's, never the supervisor's.** They differ by
the `-agent` suffix, or by the grant. Clearing `opts.handle` would take a live
supervisor offline — a worse fault than the original. `childBusHandle()` is the
one reader, and it is a function rather than a captured value because
`currentGrant` is reassigned on a child replace.

## `online_members` is the room-level answer

`room_send` returns two counts, and they answer different questions.

| field | means | changes with liveness? |
|---|---|---|
| `notified` | members this call wrote a notify file for | **no**, always every member |
| `online_members` | how many of those the bus believes are live | yes |

**`notified` is not a lie and was never narrowed.** The write to an offline
member is how it sees the message on its next `room_inbox`, so excluding them
would under-report work the call did. `online_members: 0` with `notified` above
zero is the #229 case: the send worked and nobody is there to read it.

🛑 **Neither field says anybody READ it.** Only a reply does.

## Common pitfalls

- 🛑 **A child can die before its shim ever registered**, so there is no row to
  update. An `UPDATE` against a missing row is a silent no-op, so the call is
  guarded and logs `had no bus row to take offline`. A throw here would lose
  the unsent-prompt report that runs first in the same handler.
- ⚠️ **`last_seen_at` is the field a HUMAN should read before a hand-off**, and
  that is what `AGENTS.md`'s liveness rule says. **17 of the 20 shim tools move
  it.** `claims`, `health` and `search` move nothing, so a child working
  through those alone reads stale while alive — which over-reports dead, the
  safe direction.
- **The container, the socket and the pidfile all report the SUPERVISOR** and
  outlive the child. None of them is a liveness check. `./scripts/agent status`
  prints the first three.

---

## Source files

| File | Role |
|---|---|
| `src/storage/dao.ts` | `isProcessAlive`, `hydrate`'s `online`, `clearAgentPid`, the claim guard |
| `src/supervise/index.ts` | `childBusHandle()`, the `child.onExit` handler that clears the pid |
| `src/supervise/host-bus.ts` | registers a containerized child's handle from inside the supervisor |

## Related docs

- [state-directory.md](../03-infrastructure/state-directory.md) — the socket and
  pidfile that also outlive a dead child
- [operator-scripts.md](../07-operations/operator-scripts.md) —
  `./scripts/agent status` and what its three signals actually read
