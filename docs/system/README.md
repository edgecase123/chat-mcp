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

| File                                                           | What it covers                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| [state-directory.md](03-infrastructure/state-directory.md)     | Every entry under `~/.chat-mcp`, who owns it, what is safe to delete                                                |
| [settings.md](03-infrastructure/settings.md)                   | Every env var, CLI flag, state file and hardcoded tunable, and which of them a config UI could safely write         |
| [schema-migrations.md](03-infrastructure/schema-migrations.md) | How the database is migrated, why a shipped migration may never be edited, and how to test one on an older database |

### [05 — Supervision](05-supervision/)

| File                                                            | What it covers                                                                                                                                                       |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [agent-liveness.md](05-supervision/agent-liveness.md)           | How `online` is computed, why a containerized child's row holds the supervisor's pid, and what the exit handler clears                                               |
| [child-output.md](05-supervision/child-output.md)               | The three streams a child writes to, which reach the log, and why stderr went unread                                                                                 |
| [activity-pulse.md](05-supervision/activity-pulse.md)           | How the web UI learns an agent is working, why the supervisor is the HTTP client, and the 401 a url-as-token causes                                                  |
| [project-commands.md](05-supervision/project-commands.md)       | How an agent runs a declared project command on the host, the three limits that bound it, and how an operator sets them in `limits.json`                             |
| [container-isolation.md](05-supervision/container-isolation.md) | The two containers a spawn runs, which one holds the credentials, why the dependency install is not it, and what is still open                                       |
| [handle-overrides.md](05-supervision/handle-overrides.md)       | The two override files, why the container surface stays at five keys, the ADD-only merge, and why a profile name may not be a path                                   |
| [context-gate.md](05-supervision/context-gate.md)               | How a child's context fill triggers its own restart, which of the three layers decides the gate, and why a gate of 50 restarts a container child about every 9 turns |

### [06 — Interfaces](06-interfaces/)

| File                                                   | What it covers                                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| [terminal-ui.md](06-interfaces/terminal-ui.md)         | The fallback terminal surfaces — the ink CLI, the line REPL, shell aliases, the one-shot subcommands, and the layout limits    |
| [stopping-agents.md](06-interfaces/stopping-agents.md) | How an operator stops a running agent from the dashboard, why the socket directory is the register, and what the reply reports |
| [settings-modal.md](06-interfaces/settings-modal.md)   | Where operator configuration lives in the dashboard, why it is a modal and not a sidebar card, and why the tabs are a list     |

### [07 — Operations](07-operations/)

| File                                                     | What it covers                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------- |
| [operator-scripts.md](07-operations/operator-scripts.md) | `./scripts/agent` and `./scripts/web` — start, stop, restart, status |

### [09 — Conventions](09-conventions/)

| File                                          | What it covers                                                                                                |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| [formatting.md](09-conventions/formatting.md) | Prettier's defaults are the rule, why there is no config file, and the two things the one-time reformat broke |

---

## Not written yet

Ranked by what would help most on arrival.

| Section          | What belongs there                                                                                                                |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `01-overview`    | What the bus is, how the pieces fit, a glossary. Today that lives in `README.md` and `DESIGN.md` at the repo root                 |
| `05-supervision` | Still needed: drivers, the host/container split. Today partly in `AGENTS.md`. Liveness and the container boundary are now covered |
| `02-setup`       | The three clones, `CHAT_MCP_HOME` isolation, wiring an MCP client. Today in `AGENTS.md` and `README.md`                           |
| `04-messaging`   | DMs, rooms, read watermarks, claims, the notify wake path                                                                         |
| `06-interfaces`  | Still needed: the MCP shim's tools and the web UI. The terminal surfaces are now covered                                          |
| `08-testing`     | The node test runner, `CHAT_MCP_HOME` isolation, proving a guard non-vacuous. Migrations are now covered in `03-infrastructure`   |
| `09-conventions` | Still needed: TDD, commit style, secret handling. Today in `AGENTS.md` § Conventions. Formatting is now covered                   |

⚠️ **`AGENTS.md`, `README.md` and `DESIGN.md` at the repo root are not
superseded by this tree.** Where a topic moves here, leave a one-line pointer
behind rather than two copies that drift.

## How these relate to `docs/superpowers/`

| Tree                      | Holds                             | Lifetime                           |
| ------------------------- | --------------------------------- | ---------------------------------- |
| `docs/system/`            | How the software works **now**    | Updated with the code, forever     |
| `docs/superpowers/specs/` | What a change was **going** to do | Frozen at the date in its filename |
| `docs/superpowers/plans/` | How that change was **executed**  | Frozen likewise                    |

A spec is a record of a decision. This tree is the current state. Do not read a
dated spec as documentation.

## Keeping these docs current

Every page carries `covers:` frontmatter listing the source files it describes.
**When you change those files, update the page in the same commit.**

`test/docs-covers-paths.test.ts` refuses a `covers:` entry naming a path that
does not exist, so a rename or a delete that leaves the pointer behind turns
the suite red rather than sitting there. An entry may name a directory.

Start a new page from [`_template.md`](_template.md).

**A claim in a doc needs the same evidence as a claim in a comment.** If a page
says "X exits 1 when Y", you ran it. If you inferred it, say so in the page.
