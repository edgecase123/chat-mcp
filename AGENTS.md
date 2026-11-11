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
