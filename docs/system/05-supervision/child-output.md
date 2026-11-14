---
title: Child Output
updated: 2026-11-14
covers:
  - src/supervise/child.ts
  - src/supervise/drivers/wiring.ts
  - src/supervise/index.ts
---

# Child Output

The three streams a spawned agent writes to, which of them reach the
supervisor's log, and why one of them was unreadable for so long.

---

## The three channels

Every driver spawns with `stdio: ['pipe', 'pipe', 'pipe']`, so all three exist
on every child. `wireAgentChild` attaches to two of them.

| stream | parsed as | reaches the log via |
|---|---|---|
| `stdout` | one JSON object per line | `onEvent` → `describeChildOutput` |
| `stderr` | unstructured text, split on newlines | `onStderr` → `← child stderr:` |
| `stdin` | the vendor's input envelope | not read |

🛑 **A non-JSON line on `stdout` is DROPPED on purpose**, at `child.ts`'s line
parser. The CLI may print something unstructured and killing the supervisor
over it would be worse. So **prose written to `stdout` vanishes silently** —
which is why diagnostics belong on `stderr`.

## 🛑 `stderr` was piped and never read

A containerized agent that failed to start did so with its reason on a stream
nothing had attached to. The prelude chains on `&&`, `npm` writes all its
errors to `stderr`, and a failed `npm ci` therefore meant no agent started with
no line saying why. The refusal was correct and unexplainable. #229.

`onStderr` is now a **required** member of `AgentChild`, so a driver cannot
ship without it — the same mechanism the capability flags use. `wireAgentChild`
attaches the stream once, centrally, rather than per driver.

⚠️ **A chunk is not a line.** `npm` emits partial writes, so the wiring buffers
to a newline before delivering. Logging raw chunks splits one error across
entries, and a trailing partial line is held until its newline rather than
dropped.

**Blank and whitespace-only lines are dropped**, at the wiring and again at the
supervisor. A flush of pure whitespace would otherwise be one log entry each.

🔴 **A DYING PROCESS NEVER SENDS ITS CLOSING BREAK, so `end` drains the
buffer.** Splitting on a break alone dropped the last line — which is the ONE
line naming why the container died, and the whole reason this channel exists.

⚠️ **`\r` COUNTS AS A BREAK, NOT JUST `\n`.** `npm` and `docker pull` draw
progress by returning the carriage without a newline, so a `\n`-only split
buffered a whole run and delivered it as one entry thousands of characters
long. `\r\n` is one break, not two.

## 🛑 Why `onStderr` goes through the generation guard

Every child callback registered in `wireChild` is wrapped in `ifCurrent`, which
drops a signal from a replaced child and logs that it did.

A first cut left `onStderr` unwrapped, on the argument that a dying child's
stderr is the most useful kind there is. **That argument loses to the one
`onEvent` already settled:** a stale child keeps writing, and an unguarded line
is logged as the LIVE child's error. A `← child stderr:` prefix does not
separate the old child from the new one.

So a replaced child's late stderr is dropped, and `ifCurrent` says so. The loss
is visible rather than silent. `replace-child.test.ts` asserts the whole
registration set, and its `REQUIRED` list records this reason.

## Common pitfalls

- ⚠️ **`tsc` does not typecheck `test/`.** `tsconfig.json` includes `src/**/*`
  only, so making an `AgentChild` member required flags the production wiring
  and **not** the test fakes. Those fail at runtime instead.
- 🛑 **A fake child with no `stderr` describes a process that cannot exist.**
  The type is `ChildProcessWithoutNullStreams`. Three fakes omitted it and
  broke the moment the wiring read it — the fix is to complete the fake, never
  to guard the read, because a guard there silently gives a real driver no
  logging at all.

---

## Source files

| File | Role |
|---|---|
| `src/supervise/child.ts` | the `AgentChild` contract, and the stdout line parser that drops non-JSON |
| `src/supervise/drivers/wiring.ts` | attaches both streams once for every driver, and buffers stderr to lines |
| `src/supervise/index.ts` | subscribes and logs, inside `ifCurrent` |

## Related docs

- [agent-liveness.md](agent-liveness.md) — how the bus decides a handle has
  anybody behind it
