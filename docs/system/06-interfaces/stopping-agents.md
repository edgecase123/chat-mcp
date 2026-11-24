# Stopping a running agent

How an operator ends a supervised agent from the browser dashboard, where the
list of running agents comes from, and why it is not read from the database.

## The two routes

| route              | method | capability | what it does                                   |
| ------------------ | ------ | ---------- | ---------------------------------------------- |
| `/api/agents/live` | GET    | `read`     | Lists every supervisor answering on its socket |
| `/api/agents/stop` | POST   | `admin`    | Sends a stop control to one, or to all of them |

`admin` for the stop, because it ends a model session someone is paying for.

## The socket directory is the register, not the `agents` table

`listLiveSupervisors()` in `src/supervise/socket.ts` reads
`~/.chat-mcp/sock/`, probes each entry, and returns only the ones that answer.

```
sock/claude2      answers a probe   ->  listed, and stoppable right now
sock/crashed      answers nothing   ->  skipped, and LEFT ON DISK
agents.pid = 41   never refreshed   ->  not consulted at all
```

- **The table's `pid` is not kept fresh**, and a reused pid means naming an
  unrelated process. A socket that answers is a supervisor that can be sent a
  control this instant.
- **Stale debris is skipped and left alone.** Removing it belongs to
  `WakeListener.bind`, which probes under its own refusal rules first. A reader
  that tidied up would race a supervisor binding at that moment.
- **`boundAt` is the SUPERVISOR's age, not the child's.** A restart respawns
  the child without rebinding the socket.
- **`boundAt` is `null` when the socket's mtime cannot be read**, and the page
  renders "bound time unknown". It is NEVER substituted with the current time:
  an unreadable socket read as one bound this second, which is the opposite of
  the signal a caller needs (#373).

## The request

```json
{ "handle": "claude2", "mode": "graceful" }
{ "all": true, "mode": "now" }
```

- **The default depends on the agent's VENDOR, and is resolved server-side.**
  `graceful` by lee's ruling of 2026-10-31, because a turn killed mid-stream
  spends its tokens and produces nothing.
- **A vendor that runs one process per turn defaults to `now` instead**, by
  lee's ruling of 2026-11-24. With no turn live, a graceful stop queues a
  shutdown notice, and that notice SPAWNS a turn and bills it — so graceful
  becomes the only mode that spends anything. `defaultStopModeFor` in
  `src/adapters/index.ts` owns the answer, from the adapter's own
  `processPerTurn`.
- **An unknown vendor keeps `graceful`.** Neither mode is right when the
  process lifetime is unknown, so the shipped answer stands.
- **The sweep resolves the default PER HANDLE too.** `all: true` crosses
  vendors that may differ, and each agent gets its own answer — there is no
  single default to pick, because the fan-out already acts per handle.
- **An explicit `mode` always wins, on a sweep as on one handle.** Resolution
  applies only when the caller omits it.
- **`now` skips the graceful notice only.** A container teardown still waits
  out its own grace, so neither mode is instant.
- **An unknown `mode` is refused with a 400 before anything is sent.** A
  refusal returned after a graceful stop has already left is a refusal that
  stopped the agent anyway.

## The reply names every handle, including on an empty sweep

```json
{
  "results": [
    { "handle": "claude2", "ok": true, "graceSeconds": 45 },
    {
      "handle": "gopher",
      "ok": false,
      "reason": "unreachable",
      "error": "no supervisor is listening"
    }
  ],
  "stopped": 1
}
```

🛑 **A caller branches on `reason`, never on `error`.** `reason` is
`"unreachable"` or `"refused"`; `error` is prose for a human and is free to be
reworded. The CLI briefly told the two apart by string-comparing the sentence,
which put the coupling in another file and under no test.

🛑 **`{ ok: false }` is a truthy object.** Reporting on the ack's presence
alone turned a refused stop into a silent no-op the operator waited out, which
shipped once in the CLI and was found on PR #158.

**That three-way branch has one home: `requestSupervisorControl()` in
`src/supervise/socket.ts`.** The dashboard route and `chat-mcp agents stop`
both call it, so the fix cannot drift between them.

⚠️ **`graceSeconds` is omitted rather than defaulted.** It is overridable per
handle, so a caller that substitutes its own default computes a wait ceiling
that expires first and calls a healthy stop a failure.

A sweep that stopped nothing returns `"results": []` and `"stopped": 0` rather
than a bare success, so a refused stop never reads the same as an agent that
was not running.

## The panel

**The sidebar's Agents section, between Claims and Peers.** One row per
supervisor that answered a probe.

```
Agents
  smoke-container              16%     <- the CHILD's context gauge
  bound 2h · smoke-container-agent
  [Stop]  [Stop now]
  gopher                       62%
  bound 11m · gopher-agent
  [Stop]  [Stop now]
[Stop all]  [Stop all now]            <- only once a SECOND agent is running
```

- **The row posts the SUPERVISOR handle.** The gauge beside it belongs to the
  child, so the child's handle is the easy mistake — and the route answers it
  with a tested, honest-looking `ok: false`.
- **The age says "bound", never "uptime".** It is the socket's age, and a
  restart respawns the child without rebinding.
- **An empty panel says so in words.** A blank panel and a failed fetch look
  identical, which is the frozen-gauge incident of #103 in a different place.
- **A failed fetch keeps the last known list.** Blanking it shows a RUNNING
  agent as stopped, and the operator's next action on that reading is to walk
  away.
- **Only `Stop now` is coloured.** Both buttons of a pair in the danger colour
  would say the graceful stop costs what the immediate one costs. The decision
  is `stopButtonClass()`, because a source-text count of the class could not
  tell a correct pair from a pair that was both coloured.

### The sweep

**`Stop all` and `Stop all now` sit BELOW the rows**, so the operator reads
what is running before reaching the control that stops all of it.

- 🛑 **Hidden until a SECOND agent is running.** One row's own `Stop` already
  stops it, and a sweep beside it is two controls for one outcome.
- 🛑 **That visibility is an affordance, NOT a precondition.** The route
  enumerates live sockets itself, so a count that falls to 1 between the render
  and the click still sweeps correctly.
- 🛑 **The sweep sends `all: true` and NO handle.** The route prefers `all`
  when both arrive, so a request carrying both would sweep while showing a
  handle nobody checked.
- ⚠️ **The confirm says what the panel SHOWS, and promises no count.** A
  supervisor that bound or exited since the last poll joins or leaves the sweep
  regardless of the number the operator read.
- **The outcome goes through the same `stopOutcomeText()` as a single stop.**
  It already counts, and it already leads with the failures.

### Where the strings are decided

| what                                 | where                                 |
| ------------------------------------ | ------------------------------------- |
| the row's labels                     | `agentRow()` in `web/assets/logic.js` |
| the confirm copy                     | `stopConfirmText()`                   |
| the sweep's confirm copy             | `stopAllConfirmText()`                |
| whether the sweep is offered         | `stopAllVisible()`                    |
| which button is coloured             | `stopButtonClass()`                   |
| the toast after a stop or a sweep    | `stopOutcomeText()`                   |
| the panel is actually WIRED to those | `test/web/agents-wiring.test.ts`      |

🛑 **The wiring test exists because every helper test passes with the panel
unwired.** The helpers are pure, so they prove the strings and say nothing
about whether a surface calls them. #224 shipped its bands three commits
before anything invoked them.

⚠️ **The toast branches on `reason` in ONE place.** `app.js` never reads that
field; it hands the whole `results` array to `stopOutcomeText`.

## What is not covered here

- ~~**The dashboard controls themselves.**~~ Shipped — see **The panel**
  above.
- ~~**Stopping every agent at once.**~~ Shipped — see **The sweep** above.
  The "three ways to stop things in one panel" objection is answered by hiding
  the sweep until a second agent is running.
- **`chat-mcp agents stop <handle>`**, the CLI surface that predates the
  web-only directive. It still works and sends the same control.
