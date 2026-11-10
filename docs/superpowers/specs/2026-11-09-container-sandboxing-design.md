# Container sandboxing for supervised agents (#129)

## Problem

A supervised agent's permission grant constrains nothing beyond the CLI's own prompts. Once a command is approved it runs with the full access of the host process, not just the agent's assigned clone.

## Scope

This spec covers only the container-spawn mechanism itself, for the Claude driver, for one shared auth token. The generalized vendor contract (#131), the registration UI (#132), and the host broker for privileged ops (#133) are separate tickets this spec does not block on.

## Core mechanism

Swap the spawned binary; the `AgentChild` seam does not change.

```
TODAY:  supervisor spawn('claude', [...])            -> host process
#129:   supervisor spawn('docker', ['run','-i','--rm', mounts, env, image,
                          'claude','-p','--allow-dangerously-skip-permissions',...])
```

A new `drivers/docker-claude.ts` builds a different argv. `createLineParser`, `onTurnEnd`/`onDenial`/`onSession`/`onEvent`/`onExit`/`kill` are unchanged — they only read stdout and drive stdin of whatever process `spawn()` started.

## Design decisions

1. **Mount (code)** — reuse `dirsFor(handle)` from `src/supervise/projects.ts`. No new registration for the clone path.

2. **Mount (extra state)** — a per-handle list of extra read-write mounts, keyed and registered explicitly:

   ```
   chat-mcp mount add <handle> <key> <host-dir>
   ```

   `<key>` is a free-form slug, not a fixed enum chat-mcp interprets — chat-mcp only mounts the directory at a matching path in the container; the key is a label the agent itself recognizes by convention (e.g. `local-context`, `memory`). This keeps the mechanism generic: not every user runs the `local-context` skill, so chat-mcp never hardcodes which keys exist or what they mean.

   Example: `chat-mcp mount add claude1 local-context ~/context`.

   Two keys get registered per handle in practice today: `local-context` (this session's base dir), and `memory` (this handle's Claude Code memory dir, `~/.claude/projects/<project-slug>/memory/`). An unregistered key is simply not mounted — externalized state under that key silently does not survive a restart until it is set. Fails explicit, same as `dirsFor`.

   **Advertising mounts to the agent** — no SessionStart hook. On a fresh (non-resumed) spawn, the supervisor prepends the registered keys and their in-container paths to the first dispatch prompt, e.g. `"Mounted directories: local-context -> /mnt/local-context, memory -> /mnt/memory."` chat-mcp does not say what to do with a key — that is the agent's own convention (its CLAUDE.md, its skills) to decide, the same way the mount itself stays key-agnostic. Reuses the existing per-driver dispatch-prompt mechanism (`claude-redispatch.ts`'s pattern), not a new one. A hook would need to be baked correctly into the container image and would fail silently if it weren't; a chat message is the same channel every other turn already uses.

3. **Auth** — one token, shared across all handles for now (expand to per-handle later if concurrent-session limits require it — unproven either way). Setup flow:
   1. `claude setup-token` on the host (interactive, one browser step) -> a one-year OAuth token.
   2. `chat-mcp auth set-token <token>` writes `CLAUDE_CODE_OAUTH_TOKEN=...` to `~/.chat-mcp/secrets.env` (`chmod 600`).
   3. The driver reads that file and injects the value via `docker run -e`.

4. **Permissions** — always `--allow-dangerously-skip-permissions` inside the container. Host-side `grant`/`allowlist`/`denial` logic is skipped entirely for a containerized handle. The container boundary is the gate, not a per-command check. Replaces #39's approval relay for this handle.

5. **Image** — one Dockerfile, checked into this repo: node + git + the `claude` CLI, nothing else. No docker-in-docker. Privileged ops (`run-gate`, `run-deploy`) go through #133's host broker, out of scope here.

6. **Network** — default Docker bridge network, full outbound, no `--network` restriction. Narrowing to an allowlist is #134's manifest edit later, not a #129 blocker.

7. **Confirmation / build** — `chat-mcp supervise <handle> --container` builds the image if missing or stale. The first containerized run for a handle prints the plan (mount paths, env var *names* only, binary, network mode) and requires a y/N confirm. A later run for an already-confirmed handle skips the prompt; only a Dockerfile change forces a rebuild.

8. **Restart** — `kill()` the current `AgentChild` (the container dies with it, via `--rm`), then `spawn()` a fresh one. No `docker exec`, ever. Code on the clone mount survives (bind mount); anything written only to the container's own ephemeral layer does not — that is the clean slate a restart is for. Ships as a new verb, `chat-mcp agents restart <handle>`, composed from #40's stop plus a respawn — decided by lee, 2026-11-09.

   **The agent must be told, not just given a turn.** "Let the current turn finish" by itself gives no reason to externalize anything — the agent does not know a restart is coming. Graceful mode sends a chat message to the handle first: *"This container is restarting. Externalize anything you need now — this is the last turn before shutdown."* Then waits for that specific turn's `onTurnEnd`, then kills, then respawns. `--now` skips the notice and kills immediately, same as #40's existing immediate mode.

9. **Errors** — container exit reuses today's `onExit` path, no new state machine. A missing token fails fast at spawn with an error naming `chat-mcp auth set-token`, not a silent unauthenticated run.

## What to check

- Whether a long-lived container can hold open for a room's full duration (hours) without the host auth session expiring.
- Whether full in-container permissions are actually safe, per lee's ruling of no per-command-class carve-out — untested, needs a smoke test before this ships.
- Whether one shared `CLAUDE_CODE_OAUTH_TOKEN` supports two concurrent container sessions, or whether a second concurrent handle needs its own token.
- Whether the memory dir's host path, nested under `~/.claude/` by Claude Code's own convention, lands at the same relative path under the container's home — otherwise Claude Code inside the container computes a different project slug and writes memory nobody on the host can find.
- A graceful restart's externalize-notice turn must not wait forever on a hung agent — bound the wait, and fall back to an immediate kill on timeout, same escape hatch `--now` already provides.

## What is NOT proven

- Whether a token nearing its one-year expiry fails a running session gracefully or crashes it.

## Open questions for lee

None open.

## Checks

None run yet — this is a design ticket, not an implementation.
