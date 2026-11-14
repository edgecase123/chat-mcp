# System Documentation

> Living reference for anyone — human or agent — working on chat-mcp.
> If something here is wrong or stale, fix it here. These docs are part of the
> codebase.

## What this is

Developer documentation for chat-mcp: a local message bus that lets AI coding
agents talk to each other and to their operator over MCP, and that can spawn
each agent inside its own Docker container.

**This tree is new and mostly empty.** It was started on 2026-11-14 with two
pages. The section folders below exist so there is an obvious place to put the
next one, and the "Not written yet" list is the backlog.

🛑 **The index below is the canonical list of what exists.** A page that is not
listed here will not be found. Add the row in the same commit as the page.

---

## Contents

### [03 — Infrastructure](03-infrastructure/)
| File | What it covers |
|---|---|
| [state-directory.md](03-infrastructure/state-directory.md) | Every entry under `~/.chat-mcp`, who owns it, what is safe to delete |

### [07 — Operations](07-operations/)
| File | What it covers |
|---|---|
| [operator-scripts.md](07-operations/operator-scripts.md) | `./scripts/agent` and `./scripts/web` — start, stop, restart, status |

---

## Not written yet

Each folder exists and is empty. Ranked by what would help most on arrival.

| Section | What belongs there |
|---|---|
| `01-overview` | What the bus is, how the pieces fit, a glossary. Today that lives in `README.md` and `DESIGN.md` at the repo root |
| `05-supervision` | Supervisors, drivers, the container boundary, the host/container split. Today partly in `AGENTS.md` |
| `02-setup` | The three clones, `CHAT_MCP_HOME` isolation, wiring an MCP client. Today in `AGENTS.md` and `README.md` |
| `04-messaging` | DMs, rooms, read watermarks, claims, the notify wake path |
| `06-interfaces` | The MCP shim's tools, the web UI, the ink CLI, the one-shot subcommands |
| `08-testing` | The node test runner, `CHAT_MCP_HOME` isolation, proving a guard non-vacuous |
| `09-conventions` | TDD, commit style, secret handling. Today in `AGENTS.md` § Conventions |

⚠️ **`AGENTS.md`, `README.md` and `DESIGN.md` at the repo root are not
superseded by this tree.** Where a topic moves here, leave a one-line pointer
behind rather than two copies that drift.

## How these relate to `docs/superpowers/`

| Tree | Holds | Lifetime |
|---|---|---|
| `docs/system/` | How the software works **now** | Updated with the code, forever |
| `docs/superpowers/specs/` | What a change was **going** to do | Frozen at the date in its filename |
| `docs/superpowers/plans/` | How that change was **executed** | Frozen likewise |

A spec is a record of a decision. This tree is the current state. Do not read a
dated spec as documentation.

## Keeping these docs current

Every page carries `covers:` frontmatter listing the source files it describes.
**When you change those files, update the page in the same commit.**

Start a new page from [`_template.md`](_template.md).

**A claim in a doc needs the same evidence as a claim in a comment.** If a page
says "X exits 1 when Y", you ran it. If you inferred it, say so in the page.
