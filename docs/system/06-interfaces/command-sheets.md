---
title: Command sheets
updated: 2026-11-24
covers:
  - web/assets/inventory.js
  - web/assets/logic.js
  - web/assets/app.js
  - src/util/subcommands.ts
  - scripts/agent
  - test/web/command-inventory.test.ts
---

# Command sheets — `/help`, `/cheat-sheet`, `/cli-commands`

> Three commands in the dashboard print a list of commands. They print
> **two different inventories**, and conflating them is what #429 was.

## The split, in one table

| surface         | lists                                   | built by       | carries a copy button |
| --------------- | --------------------------------------- | -------------- | --------------------- |
| `/help`         | the dashboard's own slash commands      | `commandBlock` | no                    |
| `/cheat-sheet`  | the same slash commands, + gestures     | `cheatSheet`   | no                    |
| `/cli-commands` | the CLI, the MCP tools, `scripts/agent` | `commandRows`  | **yes**               |

🛑 **`/cheat-sheet` and `/cli-commands` are different things, not two views
of one.** Ruled by lee, 2026-11-24. Do not merge them, do not cross-link their
content, and do not add a `/cheatsheet` alias.

## Why only one of them can carry a button

`/help` and `/cheat-sheet` render into a single `<pre>`. Text has nowhere to
put a click target, which is why `commandRows` exists beside `commandBlock`
rather than replacing it.

⚠️ **So the slash commands have no copy button, and that is accepted.** It was
the stated cost of pointing `/cli-commands` at the terminal inventory.

## The prefix belongs to the table

`commandRows(commands, labels, prefixes)` takes a prefix **per category**:

```
cli          "chat-mcp "          ->  chat-mcp send <to> [body]
mcp          ""                   ->  room_send
supervisor   "./scripts/agent "   ->  ./scripts/agent start <handle> [dir]
```

🛑 **A category with no prefix THROWS.** A default would render a CLI row as
`/npx chat-mcp install …`, which is the defect #429 reported. An empty prefix
is honoured rather than treated as missing, because an MCP tool name stands
alone.

🛑 **`usage` and `copy` are different strings on purpose.** The row SHOWS
`chat-mcp send <to> [body]` so the reader knows an argument is wanted, and
COPIES `chat-mcp send`, because a clipboard carrying `<to>` is invisible until
someone pastes it.

## Nothing on these sheets runs

Every row is text. `/cli-commands` has a copy button and no run affordance, by
lee's ruling of 2026-11-24. An agent that wants to RUN a project command uses
the `run_command` MCP tool, which is a separate surface with its own limits —
see [project-commands.md](../05-supervision/project-commands.md).

## Where the inventory lives, and why it cannot go stale

`web/assets/inventory.js` holds the rows. The **names** are pinned against the
real sources by `test/web/command-inventory.test.ts`:

| section      | pinned against                                        |
| ------------ | ----------------------------------------------------- |
| `cli`        | `KNOWN_SUBCOMMANDS` in `src/util/subcommands.ts`      |
| `mcp`        | every `registerTool("<name>"` under `src/shim/tools/` |
| `supervisor` | the dispatch `case` arms in `scripts/agent`           |

**Add a CLI command, register a tool, or add a verb to `scripts/agent`, and
that test reds until the sheet lists it.**

⚠️ **The MCP count is NOT the file count.** 21 files register 24 tools —
`claims.ts` registers three and `run_command.ts` registers two. A test that
counted files would under-report the surface by three.

**Descriptions are editorial and are NOT pinned.** The CLI's own are multi-line
`--help` prose and an MCP tool's is a paragraph written for a tool picker.
Neither fits one row. A name appearing or disappearing is the drift that makes
the sheet lie, and that is what the guard catches.

## Adding a command

1. Add it where it really lives — `src/index.ts`, `src/shim/tools/`, or
   `scripts/agent`.
2. Run `npm test`. `command-inventory.test.ts` reds and names the command.
3. Add the row to `web/assets/inventory.js` with a one-line description.

⚠️ **A new DASHBOARD slash command is a different path.** It goes in `COMMANDS`
in `app.js`, which feeds `/help`, `/cheat-sheet` and the composer's
autocomplete together, and it needs a `case` in `tryDispatchSlashCommand`.
**Putting a CLI command in `COMMANDS` would offer it in the composer with
nothing to dispatch it, so Enter would send it as a chat message.**
