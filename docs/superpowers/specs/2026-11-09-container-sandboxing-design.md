# Container sandboxing for supervised agents (#129)

## Problem

A supervised agent's permission grant constrains nothing beyond the CLI's own
prompts. Once a command is approved it runs with the full access of the host
process, not just the agent's assigned clone.

## Scope

This spec covers only the container-spawn mechanism itself, for the Claude
driver, for one shared auth token. The generalized vendor contract (#131),
the registration UI (#132), and the host broker for privileged ops (#133)
are separate tickets this spec does not block on.

## Core mechanism

Swap the spawned binary; the `AgentChild` seam does not change.

```
TODAY:  supervisor spawn('claude', [...])            -> host process
#129:   supervisor spawn('docker', ['run','-i','--rm', mounts, env, image,
                          'claude','-p','--allow-dangerously-skip-permissions',...])
```

A new `drivers/docker-claude.ts` builds a different argv. `createLineParser`,
`onTurnEnd`/`onDenial`/`onSession`/`onEvent`/`onExit`/`kill` are unchanged —
they only read stdout and drive stdin of whatever process `spawn()` started.

## Design decisions

1. **Mount (code)** — reuse `dirsFor(handle)` from `src/supervise/projects.ts`.
   No new registration for the clone path.

2. **Mount (extra state)** — generalize to a per-handle list of extra
   read-write mounts, registered explicitly:

   ```
   chat-mcp mount add <handle> <host-dir>
   ```

   Two entries get registered per handle in practice: the `local-context`
   base dir, and this handle's Claude Code memory dir
   (`~/.claude/projects/<project-slug>/memory/`). Unregistered means not
   mounted — externalized state silently does not survive a restart until
   it is set. Fails explicit, same as `dirsFor`.

3. **Auth** — one token, shared across all handles for now (expand to
   per-handle later if concurrent-session limits require it — unproven
   either way). Setup flow:
   1. `claude setup-token` on the host (interactive, one browser step) ->
      a one-year OAuth token.
   2. `chat-mcp auth set-token <token>` writes
      `CLAUDE_CODE_OAUTH_TOKEN=...` to `~/.chat-mcp/secrets.env`
      (`chmod 600`).
   3. The driver reads that file and injects the value via `docker run -e`.

4. **Permissions** — always `--allow-dangerously-skip-permissions` inside
   the container. Host-side `grant`/`allowlist`/`denial` logic is skipped
   entirely for a containerized handle. The container boundary is the gate,
   not a per-command check. Replaces #39's approval relay for this handle.

5. **Image** — one Dockerfile, checked into this repo: node + git + the
   `claude` CLI, nothing else. No docker-in-docker. Privileged ops
   (`run-gate`, `run-deploy`) go through #133's host broker, out of scope
   here.

6. **Network** — default Docker bridge network, full outbound, no
   `--network` restriction. Narrowing to an allowlist is #134's manifest
   edit later, not a #129 blocker.

7. **Confirmation / build** — `chat-mcp supervise <handle> --container`
   builds the image if missing or stale. The first containerized run for a
   handle prints the plan (mount paths, env var *names* only, binary,
   network mode) and requires a y/N confirm. A later run for an already-
   confirmed handle skips the prompt; only a Dockerfile change forces a
   rebuild.

8. **Restart** — `kill()` the current `AgentChild` (the container dies with
   it, via `--rm`), then `spawn()` a fresh one. No `docker exec`, ever.
   Code on the clone mount survives (bind mount); anything written only to
   the container's own ephemeral layer does not — that is the clean slate
   a restart is for. Graceful vs. immediate reuses #40's existing
   semantics: graceful lets the current turn finish, which is the same
   window an agent already uses to externalize state before a `/clear`
   today. Ships as a new verb, `chat-mcp agents restart <handle>`, composed
   from #40's stop plus a respawn — decided by lee, 2026-11-09.

9. **Errors** — container exit reuses today's `onExit` path, no new state
   machine. A missing token fails fast at spawn with an error naming
   `chat-mcp auth set-token`, not a silent unauthenticated run.

## What to check

- Whether a long-lived container can hold open for a room's full duration
  (hours) without the host auth session expiring.
- Whether full in-container permissions are actually safe, per lee's
  ruling of no per-command-class carve-out — untested, needs a smoke test
  before this ships.
- Whether one shared `CLAUDE_CODE_OAUTH_TOKEN` supports two concurrent
  container sessions, or whether a second concurrent handle needs its own
  token.
- Whether the memory dir's host path, nested under `~/.claude/` by Claude
  Code's own convention, lands at the same relative path under the
  container's home — otherwise Claude Code inside the container computes a
  different project slug and writes memory nobody on the host can find.

## What is NOT proven

- Whether a token nearing its one-year expiry fails a running session
  gracefully or crashes it.

## Open questions for lee

None open.

## Checks

None run yet — this is a design ticket, not an implementation.
