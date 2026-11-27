---
title: The gate
updated: 2026-11-27
covers:
  - scripts/gate.sh
  - scripts/lib/gate-totals.mjs
---

# The gate

```
npm run gate                      # the whole thing
npm run gate -- --allow-dirty     # gate a tree with uncommitted edits
```

Four checks, one exit code, one verdict line.

| step                   | what a failure means                                      |
| ---------------------- | --------------------------------------------------------- |
| `npm run build`        | `tsc` is red, or the build stamp could not be written     |
| `npm run typecheck`    | `tsc -p tsconfig.test.json` is red                        |
| `npm run format:check` | `prettier --check .` has an unformatted file              |
| `npm test`             | a test failed, was cancelled, or the totals do not add up |

**`EXIT 0` is the verdict. The transcript is only the transcript.** The test
step writes to `/tmp/gate-<worktree>.log`, overwritten each run, and the path
is printed before the run starts. Override it with `GATE_LOG`.

## Why `npm test` alone is not the gate

PR 457 merged on a report that was true — `npm test EXIT 0, pass 2821/2821` —
and put `main` red on `format:check`. A red `main` blocks every agent's gate,
not just the author's, so the next agent spent a cycle proving the failure was
not their own delta. PR 459 was a two-line formatting fix to unblock it.

## Why a hung run is not a pass

**A hung run and a green run both print zero failures.** One `node --test`
process sat alive for 15h 22m having printed typecheck and formatting output
and no verdict at all. Grepping its log for `fail` or `not ok` is
indistinguishable from reading a clean sweep.

`cancelled` is the discriminator, and only the totals block carries it:

```
ℹ tests 1        a test that exceeded --test-timeout
ℹ pass 0
ℹ fail 0         <- zero, and the run is RED
ℹ cancelled 1    <- this is the only line that says so
```

So `scripts/lib/gate-totals.mjs` **throws when the totals block is absent**
rather than reporting zeroes for keys it could not find. A run killed by the
wall ceiling printed no failures, and that is not a pass.

## The two hangs, and the two ceilings

They are different failures and neither ceiling catches the other.

| ceiling                    | default | ends                                                       |
| -------------------------- | ------- | ---------------------------------------------------------- |
| `--test-timeout`, per test | 60000ms | one test that never resolves                               |
| wall clock, whole run      | 1800s   | a run whose tests finished and whose process will not exit |

Override with `GATE_TEST_TIMEOUT_MS` and `GATE_WALL_SECONDS`.

🛑 **The per-test knob travels as an ENV VAR, not a flag.**
`npm test -- --test-timeout=X` puts the flag after the glob and node
**silently ignores it**, so the override reads as live and does nothing.
`package.json`'s `test` script interpolates `${GATE_TEST_TIMEOUT_MS:-60000}`
instead. One source of truth, and a bare `npm test` still cannot hang forever.

🛑 **The wall ceiling kills process GROUPS, both of them.** `kill` on the npm
pid leaves `node --test` alive and reparented to pid 1 — the ceiling would not
end the hang it exists for, and the orphan then poisons the next session's
`pgrep -f "node --test"` pre-flight. The same applies to the ceiling's own
subshell: killing it leaves the `sleep` it spawned holding the stdout it
inherited, so a GREEN gate read through a pipe blocks for the full ceiling
before the caller sees EOF.

## Exit codes

| code | meaning                                      |
| ---- | -------------------------------------------- |
| 0    | green                                        |
| 1    | a check failed, or the totals are unreadable |
| 2    | bad usage                                    |
| 3    | refused: the working tree is dirty           |

A gate run against uncommitted edits reports on a tree that will never be
pushed, so a dirty tree is a refusal rather than a warning.

## It does not know which worktree it is in

The repo root is derived from the script's own location. The previous gate
script lived in a context directory and was pinned to one worktree path, so the
agent in the other worktree was told not to run it — two agents, one script,
and one of them with no gate command at all.
