---
title: Agent Liveness
updated: 2026-11-17
covers:
  - src/storage/dao.ts
  - src/shim/backlog.ts
  - src/shim/backlog-check.ts
  - src/supervise/exit-event.ts
  - src/messaging/room-announce.ts
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

| property                            | why it matters                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| the row is **updated, not deleted** | the handle stays visible to `listAgents(db, true)` as offline, instead of vanishing                                                             |
| `last_seen_at` is **not touched**   | the child is gone, so its last real activity is the honest value                                                                                |
| a restart needs **no `force`**      | `refuseLiveRival` returns early on a null incumbent pid, and the claim guard is `WHERE agents.pid IS @expected_pid` against the row's own value |

⚠️ **The handle cleared is the CHILD's, never the supervisor's.** They differ by
the `-agent` suffix, or by the grant. Clearing `opts.handle` would take a live
supervisor offline — a worse fault than the original. `childBusHandle()` is the
one reader, and it is a function rather than a captured value because
`currentGrant` is reassigned on a child replace.

## A death is an EVENT, and the supervisor goes with the child

Clearing the pid made the handle read offline, which an operator sees as a
**gap** — indistinguishable from an agent that was never started. And closing
the wake socket left a second defect: `stop` and `restart` arrive only as
`envelope.control` over that socket, so a supervisor that outlived its child
had nothing it could be asked. `kill <pid>` was the only end.

lee ruled on 2026-11-16: announce the exit, then exit.

```
child exits on its own        (a stop and a replace are excluded, see below)
  1  clearAgentPid            the handle reads offline
  2  announceChildExit        kind "alert", in every room either handle is in
  3  hasStopped = true
  4  finishShutdown           socket + host bus closed, then onStopped fires
  5  process.exit(0)          wired to onStopped in src/index.ts
```

### The audience is BOTH handles' rooms

🛑 **The handle that goes offline is the CHILD's, and announcing to only its
rooms reaches nobody.** Measured on 2026-11-16: `room_members` held 11 rows and
none was an `-agent` handle. Peers address the agent by the **supervisor's**
handle; the child handle is an implementation detail only `clearAgentPid`
reads. So the audience is the union of both handles' rooms, deduplicated.

⚠️ **A peer who only ever DMs this agent and shares no room is not reached.**
Rooms are the bus's broadcast. A fan-out to every past correspondent would be a
different feature.

### Two exits are not deaths

| exit                | announced? | excluded by      |
| ------------------- | ---------- | ---------------- |
| the child's own     | **yes**    | —                |
| `agents stop`       | no         | `hasStopped`     |
| a replace / restart | no         | `replacingChild` |

The operator asked for the other two, so a siren for either is how an alert
lane goes stale. Both have a test that fails if the exclusion is dropped.

⚠️ **`hasStopped = true` on this path is load-bearing and it was not obvious.**
It is what makes a later SIGINT-driven `doStop` return early instead of
tearing down a second time and firing `onStopped` twice. A mutant deleting it
broke nothing until a test was written for the state it guards: a stop arriving
_after_ the child already died.

## `online_members` is the room-level answer

`room_send` returns two counts, and they answer different questions.

| field            | means                                       | changes with liveness?      |
| ---------------- | ------------------------------------------- | --------------------------- |
| `notified`       | members this call wrote a notify file for   | **no**, always every member |
| `online_members` | how many of those the bus believes are live | yes                         |

**`notified` is not a lie and was never narrowed.** The write to an offline
member is how it sees the message on its next `room_inbox`, so excluding them
would under-report work the call did. `online_members: 0` with `notified` above
zero is the #229 case: the send worked and nobody is there to read it.

🛑 **Neither field says anybody READ it.** Only a reply does.

## A SEND is the only liveness signal the backlog warning trusts

`online` says a process exists. `last_seen_at` says a tool was called. Neither
says the agent is **reading**, and an agent that reads nothing looked identical
to one with an empty inbox.

The unread-backlog warning closes that, and the question it had to answer first
is what makes the check run at all.

| candidate tick         | why not                                                      |
| ---------------------- | ------------------------------------------------------------ |
| `inbox`/`room_inbox`   | that is the agent READING, which CLEARS the backlog          |
| a timer                | fires on handles that were never going to read               |
| supervisor turn end    | host agents are not supervised; `ps supervise` is empty      |
| **`send`/`room_send`** | ✅ **the agent is demonstrably alive and still not reading** |

```
src/shim/tools/send.ts        applyBacklogCheck, BELOW the insert
src/shim/tools/room_send.ts   applyBacklogCheck, BELOW sendToRoom
```

**Below the insert on purpose.** A refused send is not a liveness signal the
agent earned, so it must not tick.

🛑 **The gate is structural, not a timestamp comparison.** `lee-approvals`
holds over 1800 unread messages and never fires, because it never sends. A
`last_seen_at` freshness test would have had to pick a number; this picks none.

⚠️ **The known hole is stated rather than hidden: an agent that neither reads
nor sends never fires.** That is indistinguishable from offline, and the bus
deliberately stays quiet there. Full design and the rejected options:
`edgecase123/chat-mcp#224`.

## A band is spent only once the warning REACHED somebody

Both warning fanouts — the unread backlog and the context gauge — record the
band they just crossed so it fires once rather than on every tick. Recording it
_before_ the delivery is attempted spends it on a delivery that never happened,
and a spent band never fires again.

| ordering                           | what it costs                                         |
| ---------------------------------- | ----------------------------------------------------- |
| band recorded BEFORE delivery      | a throw part-way leaves later rooms never warned      |
| one `try` around the whole fan     | one unreachable room costs every room its warning     |
| room counted BELOW its fanout      | the band stays unspent and re-warns on every tick     |
| **recorded after, per-room catch** | ✅ **partial delivery counts; total failure retries** |

```
src/shim/backlog-check.ts   applyBacklogCheck
src/shim/gauge-report.ts    applyContextReport
```

🛑 **The row IS the delivery.** `inbox` and `room_inbox` read the table, so a
failed wake has not lost the warning — which is why the room is counted above
the member fanout, not below it.

⚠️ **A partial failure still spends the band.** The rooms that were reached
would otherwise be re-told on every later tick, and that is the louder bug.

⚠️ **`fired` is `null` when nothing landed at all**, so a caller cannot read a
crossed band as a delivered one.

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
- 🛑 **A `system`-authored message is unread and is NOT a backlog.** The age
  excludes `system` on both channels, because the warning itself arrives unread
  in the inbox it complains about. So the backlog AGE and the `unread` COUNT
  disagree on purpose, and anything asserting they agree is wrong.
- **The container, the socket and the pidfile all report the SUPERVISOR** and
  outlive the child. None of them is a liveness check. `./scripts/agent status`
  prints the first three.

---

## Source files

| File                        | Role                                                                     |
| --------------------------- | ------------------------------------------------------------------------ |
| `src/storage/dao.ts`        | `isProcessAlive`, `hydrate`'s `online`, `clearAgentPid`, the claim guard |
| `src/supervise/index.ts`    | `childBusHandle()`, the `child.onExit` handler that clears the pid       |
| `src/shim/backlog.ts`       | the age bands and their routing, pure                                    |
| `src/shim/backlog-check.ts` | `applyBacklogCheck` — the seam `send`/`room_send` tick                   |
| `src/shim/gauge-report.ts`  | `applyContextReport` — the same fanout, for the context gauge            |
| `src/supervise/host-bus.ts` | registers a containerized child's handle from inside the supervisor      |

## Related docs

- [state-directory.md](../03-infrastructure/state-directory.md) — the socket and
  pidfile that also outlive a dead child
- [operator-scripts.md](../07-operations/operator-scripts.md) —
  `./scripts/agent status` and what its three signals actually read
