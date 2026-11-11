# AGENTS.md

Guidance for any coding agent working in this repo.

## What this is

`chat-mcp` — a local, no-cloud message bus that lets multiple AI coding
agents (and the human) talk to each other over MCP. TypeScript, Node 22+,
stdio MCP shim + CLI + a browser dashboard, backed by a single SQLite file
under `~/.chat-mcp/` (or `$CHAT_MCP_HOME`). Full design: `DESIGN.md`.

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

## One clone per agent, one handle each

Two agents work this repo at the same time, each in its own clone. The clone
is what decides which bus handle that session answers to.

| clone | handle |
|---|---|
| `~/dev/chat-mcp` | `claude1` |
| `~/dev/chat-mcp2` | `claude2` |

The binding lives in `.mcp.json` at the clone root, which is **gitignored and
per-tree**. It points at that clone's own build:

```json
{
  "mcpServers": {
    "chat": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/this/clone/dist/index.js", "--handle", "claude2"],
      "env": {}
    }
  }
}
```

Two things to know before you touch it:

- **`npm run build` first, and again after every pull.** `.mcp.json` runs
  `dist/`, so a clone with no `dist/` has no bus at all. A stale `dist/` is
  worse than a missing one: it can be silently corrupt, and only the paths
  importing the broken module die. One was found beginning `ximport;` while
  `--handle` kept answering correctly throughout, so a healthy handshake
  proves nothing about the rest of the build.
- **It points at the local build on purpose, not `npx github:…`.** In this
  repo npx would run a different version than the one you are editing. It
  also writes a shared npx cache directory that both clones resolve to, which
  is its own failure mode.

A new clone needs its own `.mcp.json` written by hand. Nothing in the repo can
supply it, because the whole point is that each one differs.

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
- `src/supervise/` — spawning and driving an agent process, container or host. **Never imports from `src/adapters/`** — that direction is the one architectural rule this repo enforces by convention, not by the type system. A violation passes `tsc` and breaks only at runtime.
- `src/storage/` — the only code that touches SQLite (`db.ts` schema/migrations, `dao.ts` reads/writes). Everything else goes through `dao.ts`.
- `src/shim/` — the MCP server exposed to each agent (tools + resources).
- `src/cli/` — the terminal UI (`ink/`) and the browser dashboard server (`web/`).
- `src/oneshot/` — one-off CLI subcommands that don't need the full shim running.

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
