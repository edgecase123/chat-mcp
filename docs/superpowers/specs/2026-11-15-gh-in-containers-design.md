# GitHub access for containerized agents

Status: proposal, drafted for a ticket. Claims about GitHub behavior are from memory and need
checking against current GitHub docs before implementation.

## Problem

Agents in the `chat-mcp-agent` container cannot file tickets, open PRs or push. The image is
`node:22-slim` + `git` + `@anthropic-ai/claude-code`, and there is no GitHub credential.
Hit 2026-11-13 when a containerized claude2 was asked to file an issue: no `gh` CLI, no auth.

## Current state (from the source)

- `Dockerfile` installs `git` and the Claude CLI only. It runs as non-root `agent`.
- The only credential is one shared `CLAUDE_CODE_OAUTH_TOKEN` in `stateDir()/secrets.env` (`0600`).
  `readToken()` (`supervise/auth.ts`) reads it, and `dockerRunPlan()`
  (`supervise/drivers/containerized.ts`) passes it as `docker run -e CLAUDE_CODE_OAUTH_TOKEN`,
  by name. The value reaches docker through the client's environment and never appears in argv.
- `/work`'s `origin` is `git@github.com:edgecase123/chat-mcp.git` (SSH). The container has no SSH
  keys, so a push fails even with `gh` installed.

## Proposed work

1. **Dockerfile:** install `gh` from GitHub's apt repository (keyring + source list, then
   `apt-get install gh`), in the same layer style as `git`. A Dockerfile change already triggers an
   image rebuild (`BUILD_INPUT_PATHS` hash in `supervise/container.ts`).
2. **Credential:** `gh` reads `GH_TOKEN` (or `GITHUB_TOKEN`) from the environment, so no interactive
   `gh auth login` is needed. That flow needs a browser or device code, which a container lacks,
   the same constraint as the Claude token. Mirror the existing pattern:
   - store `GH_TOKEN=...` in a `0600` file via `writePrivateFileSync`;
   - add a command such as `chat-mcp auth set-gh-token`, taking the token on stdin or by prompt,
     because a token passed as a CLI argument is readable via `ps` (AGENTS.md forbids it);
   - inject it by name with `-e GH_TOKEN` in `dockerRunPlan`, value in the docker client's env only;
   - make it **optional**: an agent that does not need GitHub must keep starting without it.
3. **git over HTTPS in the container:** run `gh auth setup-git` (credential helper) at start and
   rewrite SSH remotes (`git config url."https://github.com/".insteadOf git@github.com:`), or
   document HTTPS remotes.
4. **Confirmation banner:** `describePlan()` must list `GH_TOKEN` among the env var names so the
   human sees what the container receives.
5. **Docs:** the host setup steps below, and a note that the token is readable by the agent process,
   the same exposure class as the Claude token.

## Host setup steps (human, once)

1. Create a fine-grained personal access token (GitHub > Settings > Developer settings), scoped to
   the specific repositories, with minimal permissions: Issues read/write, Pull requests read/write,
   Contents read/write only if the agent pushes, Metadata read. Give it a short expiry.
2. Store it with the new `chat-mcp auth set-gh-token` command.
3. Restart the supervisor: `chat-mcp agents restart <handle>`.
4. Verify inside the container: `gh auth status`, then `gh issue list`.
5. **Do not** bind-mount `~/.config/gh` or `stateDir()` into the container. AGENTS.md forbids file
   shims across the container boundary. Environment injection only.

## Shared or individual tokens

Technically either works: `GH_TOKEN` is only an environment variable, and nothing in GitHub ties a
token to a container.

| | Shared token | Per-handle token |
|---|---|---|
| Setup | one token | one per agent |
| Revoke one agent | not possible without breaking all | independent |
| Scope | the union every agent needs | only that agent's repos |
| Audit | cannot tell agents apart | token name identifies the agent |
| Fits existing model | the Claude token today (#129 decision 3) | `projects.json`, `mounts.json`, `tokens/<handle>` |

Attribution caveat: fine-grained tokens created by one user all act as that user, so issues and PRs
look the same whichever token made them. Distinct authorship (claude1 vs claude2) needs a separate
machine user per agent, or a GitHub App.

**Recommendation:** per-handle tokens, with an optional shared fallback. Store one file per handle,
as `supervise/handle-tokens.ts` does, to avoid the lost-write race it documents. Starting with a
single shared token is fine if it must work today, provided the storage is per-handle so tightening
later needs no migration.

## Acceptance

- The image contains `gh`.
- A containerized handle with a token can run `gh issue create`.
- The token never appears in argv, `ps`, or logs.
- Tests for the run plan: `-e GH_TOKEN` passed by name, and behavior when the token is absent,
  following the existing `dockerRunPlan` tests.
- The confirmation banner lists `GH_TOKEN`.
