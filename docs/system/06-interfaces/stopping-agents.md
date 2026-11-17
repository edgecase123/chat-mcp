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

## The request

```json
{ "handle": "claude2", "mode": "graceful" }
{ "all": true, "mode": "now" }
```

- **`graceful` is the default**, by lee's ruling of 2026-10-31. A turn killed
  mid-stream spends its tokens and produces nothing.
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

## What is not covered here

- **The dashboard controls themselves.** The Stop and Stop now buttons and the
  running-agents card are the second half of #40.
- **`chat-mcp agents stop <handle>`**, the CLI surface that predates the
  web-only directive. It still works and sends the same control.
