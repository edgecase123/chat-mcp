# AGENTS.md

Guidance for any coding agent working in this repo.

## What this is

`chat-mcp` — a local, no-cloud message bus that lets multiple AI coding
agents (and the human) talk to each other over MCP. TypeScript, Node 22+,
stdio MCP shim + CLI + a browser dashboard, backed by a single SQLite file
under `~/.chat-mcp/` (or `$CHAT_MCP_HOME`). Full design: `DESIGN.md`.

## Where documentation goes

`docs/system/` is the living reference for how the software works now. Its
`README.md` is the index, and **a page not listed there will not be found** —
add the row in the same commit as the page.

- Adding or changing a service, command, table, env var or state-dir entry
  means a `docs/system/**` update in the same commit.
- `docs/superpowers/specs/` and `plans/` are frozen records of one decision,
  dated in the filename. Do not read them as current documentation.
- This file, `README.md` and `DESIGN.md` are not superseded. Where a topic
  moves into `docs/system/`, leave a one-line pointer rather than a second
  copy that drifts.

Start a page from `docs/system/_template.md`.

## Commands

```bash
npm run build   # tsc -> dist/
npm run dev     # tsx src/index.ts, no build step
npm test        # node --test --experimental-test-module-mocks --import tsx 'test/**/*.test.ts'
npx tsc --noEmit
node --import tsx src/index.ts --help   # proves the module graph actually boots —
                                         # tsc --noEmit cannot see an import cycle
```

**Tests under the node runner refuse the real `~/.chat-mcp` directory.**
Set `process.env.CHAT_MCP_HOME` to a temp dir *before* importing anything
that resolves a state path — see `src/util/paths.ts`'s `stateDir()` for why,
and any `test/supervise/*.test.ts` for the pattern.

## Three clones: one runs the bus, two are edited

Two agents work this repo at the same time. A third clone runs the bus they
talk over, so neither agent's work-in-progress can take the comms down.

| clone | role | handle |
|---|---|---|
| `~/dev/chat-mcp-main` | runs the bus for both agents. Stays on `main`. | — |
| `~/dev/chat-mcp` | claude1 edits and tests here | `claude1` |
| `~/dev/chat-mcp2` | claude2 edits and tests here | `claude2` |

Each agent clone carries a `.mcp.json` at its root, **gitignored and
per-tree**. It names that clone's handle and points at `chat-mcp-main`:

```json
{
  "mcpServers": {
    "chat": {
      "type": "stdio",
      "command": "node",
      "args": ["/Users/leejenkins/dev/chat-mcp-main/dist/index.js", "--handle", "claude2"],
      "env": {}
    }
  }
}
```

- **Not that clone's own build.** Comms is infrastructure, and you do not run
  infrastructure off a working copy. Break your `src/`, rebuild, and you lose
  your own bus mid-task — which happened on 2026-11-11.
- **Not `npx github:…` either.** npx resolves one cache directory per spec
  string, shared by both clones, and rewrites it in place when `main` moves. A
  session starting during that rewrite reads a launcher with no execute bit
  and dies with `Permission denied`.
- **`cd ~/dev/chat-mcp-main && git pull && npm ci && npm run build`** after
  anything lands on `main`. A stale `dist/` is worse than a missing one: it can
  be silently corrupt, and only the paths importing the broken module die. One
  was found beginning `ximport;` while `--handle` kept answering correctly, so
  a healthy handshake proves nothing about the rest of the build.
- **Never symlink `node_modules` between clones.** It faked five failures and
  shrank the test denominator by 60 on PR #147. Run `npm ci` in each clone.

A new agent clone needs its own `.mcp.json` written by hand. Nothing in the
repo can supply it, because the whole point is that each one differs.

### Testing a clone in isolation uses `CHAT_MCP_HOME`, not ports

Ports are already not a collision: `chat-mcp web --port` defaults to a random
free port. The state is the shared thing. `stateDir()` in `src/util/paths.ts`
resolves all five of `chat.db`, `notify/`, `sock/`, `mcp/` and `adapters/`
under one root, and `CHAT_MCP_HOME` is that root.

```bash
CHAT_MCP_HOME=/tmp/chat-mcp-test-$$ node ./dist/index.js --handle probe
```

The suite enforces this: `stateDir()` throws under the node test runner when
`CHAT_MCP_HOME` is unset, because binding a socket in the live directory
unlinks whatever looks stale and silently stops a running agent.

### `.mcp.json` alone leaves the agent DEAF

Registering on the bus is not the same as noticing a message. `.mcp.json`
gives the session its handle and its tools. Nothing in it wakes the model when
a message lands, so an agent with only `.mcp.json` answers nothing and looks
identical to one that is ignoring you.

The wake trigger is a hook, in `.claude/settings.local.json` at the clone root
— also gitignored and per-tree:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command",
        "command": "/Users/leejenkins/.chat-mcp/adapters/claude-code-claude2.sh" } ] }
    ],
    "PreToolUse": [
      { "hooks": [ { "type": "command",
        "command": "/Users/leejenkins/.chat-mcp/adapters/claude-code-context-claude2.sh" } ] }
    ]
  }
}
```

Those two scripts are per-handle and are installed, not written by hand:

```bash
chat-mcp install claude-code --handle <handle>
chat-mcp install claude-code-context --handle <handle>
```

Two things that cost time here:

- **An agent cannot write this file for itself.** Claude Code's
  `[Self-Modification]` classifier denies it, so a human creates it or grants
  the write. Both agents hit that on 2026-11-11.
- **Check for an adapter before installing one.** `ls ~/.chat-mcp/adapters/`
  already holds several handles' scripts. A missing one is the exception.

## Layout

- `src/adapters/` — per-vendor CLI integration (flags, event shapes). May import from `src/supervise/`.
- `src/supervise/` — spawning and driving an agent process, container or host. **Never imports from `src/adapters/`** — that direction is one of the two architectural rules this repo enforces by convention rather than by the type system, the other being the container boundary below. A violation passes `tsc` and breaks only at runtime.
- `src/storage/` — the only code that touches SQLite (`db.ts` schema/migrations, `dao.ts` reads/writes). Everything else goes through `dao.ts`.
- `src/shim/` — the MCP server exposed to each agent (tools + resources).
- `src/cli/` — the terminal UI (`ink/`) and the browser dashboard server (`web/`).
- `src/oneshot/` — one-off CLI subcommands that don't need the full shim running.

## 🛑 No file shims across the container boundary

**A containerized agent never reaches the bus through a shared file.** It
connects to the host over HTTP with a per-handle bearer token.

lee, 2026-11-13, ruling on the docker/stdin arc:

> *"NO FILE SHIM SHARING. Put that in AGENTS.md or somewhere that it is
> cannonized"* — then, scoping it: *"For the dokcer/stdin arc, that is. NO
> FILE SHIMS"*

### What this forbids

- Bind-mounting `stateDir()`, or any part of it, into a container.
- Writing an MCP config that launches a **stdio shim inside** the container.
  That shim calls `openDb()`, which reaches `chat.db` across the mount.
- Any new host/container handoff that CROSSES the boundary as a file — a
  shared notify file, a mounted socket path, a spool directory either side can
  see.

### What it does NOT touch

🛑 **The ban is scoped to the container boundary. It is not a ban on the file
path anywhere else.**

- `notify/` and every host `fs.watch` on it. Unsupervised host clients keep
  working, by a separate ruling that still stands.
- The stdio transport for **host** agents, which is first-class.
- `/work`, the project mount. That is a requirement, not a leak.
- The per-handle named volume at `/work/node_modules`. It names no host path,
  so there is no source side to leak. It exists to hide the host's macOS
  `node_modules` from a Linux container, not to carry anything across, and the
  container installs its own into it on first start. ⚠️ **A declared
  `readOnlyPaths` entry of `node_modules` now REFUSES the spawn**, because it
  would put a host bind on the same destination.
- 🚨 **The install is the one prelude step that runs code this project did not
  write, and it IS INSIDE the boundary, not outside it.** `npm ci` fires every
  dependency's lifecycle scripts, and they can read all three credentials: the
  config file at `$HOME` is `0600` owned by the same `agent` uid they run as,
  and `/proc/1/environ` holds the lot because docker hands them to PID 1. **Both
  routes measured in a built image.** The `env -u` scrub on the install stops a
  script that merely dumps its environment and is NOT a boundary. **#231 is the
  boundary** — the install moving to its own credential-free container.
- ⚠️ **The volume is writable, executable code that outlives `--rm`.** One
  hostile install persists, because the lockfile-hash guard then skips the
  reinstall. `docker volume rm` is the only reset, and the name comes from
  `nodeModulesVolumeFor`, never a hand-spelled prefix.
- The install is guarded on the **lockfile's sha256**, stamped into the volume.
  The volume outlives the `--rm`, so a presence-only guard would run every
  later suite against the dependency tree of a lockfile the host had since
  changed. A project with **no** lockfile skips the install and still starts.
- A config file written **inside** the container from an env var at spawn time.
  It holds the URL and the bearer token, and it is neither shared nor mounted,
  so nothing crosses the boundary through it. ⚠️ **The test is whether both
  sides can SEE the file, not whether a file exists.**

### Why a mount is not a boundary

A mounted `stateDir()` makes the container a second process on the host's
database rather than a client of the host. One file was ever needed —
`mcp/<handle>.json` — and the whole directory was mounted to deliver it, which
handed over every DM and every room.

⚠️ **A loopback bind is not a boundary either.** A host server on `127.0.0.1`
is reachable from a container through `host.docker.internal` on Docker
Desktop, measured on this setup. So the HTTP listener authenticates every
request; `cli/web/server.ts` additionally refuses a forged `Host` header, and
that guard is the one thing that ever refused a container's request.

⚠️ **The MCP listener deliberately does NOT share that `Host` allowlist.** A
container's request arrives with `Host: host.docker.internal:<port>`, which a
loopback allowlist never contains, so it would refuse the caller this transport
exists for. The bearer token is the whole boundary there.


## Conventions

- TDD: write the failing test first, run it, confirm it fails for the stated
  reason, then implement. Prove a new guard test non-vacuous by temporarily
  breaking the thing it guards and watching it fail.
- A `catch` that falls back to a default must log what it swallowed first
  (path, or the value that failed to parse) — a silent fallback reads as a
  clean first-run state instead of corruption. See `container.ts`.
- Secret-bearing files go through `writePrivateFileSync` (`util/paths.ts`),
  which sets `0600`. Don't pass a secret as a `spawn`/`execFileSync` CLI
  argument — it's readable via `ps`/`/proc` for the life of the process.
- Commit/PR titles state the problem a user or agent hits, not the
  mechanism — see `git log --oneline` for the house style.

## Agents and skills available in this repo

- `.claude/agents/dry-solid-reviewer.md` — DRY/SOLID review against this codebase's own patterns.
- `.claude/agents/security-scanner.md` — scans for this repo's actual attack surface (command injection, secret handling, path traversal, SQL interpolation).
- `.claude/skills/local-context/` — per-task working-memory skill (`/local-context`).

## Review order: self, then sibling

Run the matching `.claude/agents/*.md` reviewer(s) on your own diff **before**
handing it to the other agent for peer review. "Matching" means the diff
falls inside that agent's own `description:` frontmatter trigger — a diff
that matches no reviewer is exempt; say so at handoff instead of staying
silent. Adapted from `leagues`' CLAUDE.md, which anchors the same reviewers
to before the gate — this repo has none, so the anchor is before sibling
handoff. A finding a sub-agent catches pre-review costs nothing; the same
finding caught by the sibling costs a round trip back to you.
