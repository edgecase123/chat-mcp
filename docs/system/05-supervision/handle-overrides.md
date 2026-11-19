---
title: Per-handle container overrides
updated: 2026-11-19
covers:
  - src/supervise/overrides.ts
---

# Per-handle container overrides

How one agent gets a capability another agent does not: a validated JSON file
per handle, optionally pointing at a shared profile. Read this before adding a
key, and before writing a reader for either file.

---

## Two files, two layers

```
~/.chat-mcp/profiles/<name>.json     the five container keys
~/.chat-mcp/overrides/<handle>.json  the five, plus `profile`
                                     |
                          mergeOverrides(profile, handle)
                                     |
                              one ContainerOverride
```

A handle file may stand alone. A profile exists so several handles can share
one capability set without a second copy of it.

🛑 **Both files must sit outside every container mount.** `/work` is mounted,
so an in-tree override would let an agent widen its own next spawn.

⚠️ **NOT YET ENFORCED, because neither directory exists in code yet.** There is
no `profilesDir()` or `overridesDir()` in `src/util/paths.ts`, and the guard
that would cover them, `assertProjectDirOutsideState` in `containment.ts`,
only reaches paths under `stateDir()`. **Whoever adds the reader owes that pin
and its test.**

## The keys

| Key              | Value                                 | Merge    |
| ---------------- | ------------------------------------- | -------- |
| `env`            | object of NAME to string, no newline  | union    |
| `readOnlyMounts` | array of project-relative paths       | union    |
| `image`          | a registry reference                  | replace  |
| `memory`         | docker's own form, `512m`, never zero | replace  |
| `cpus`           | a decimal, `1.5`, never zero          | replace  |
| `profile`        | a profile name, handle file only      | resolved |

🛑 **The container surface is five keys. `profile` is a pointer, not a sixth
thing docker is told.** That is why `ALLOWED_OVERRIDE_KEYS` holds five and
`ALLOWED_HANDLE_KEYS` holds six, and why a profile file refuses `profile`.

🛑 **A sixth container key must be classified union or replace DELIBERATELY.**
`SCALAR_KEYS` is the complement of `UNION_KEYS`, so an unclassified key joins
the replacing half and a handle file could then drop what a profile set. The
`MERGE_BEHAVIOUR` table in `test/supervise/overrides.test.ts` does not compile
until the new key is written down.

## ADD-only, which is a ruling and not a default

**An override may change what a name is SET TO. It may never drop a name.**
lee ruled this on 2026-11-19.

- `env` and `readOnlyMounts` union, and the handle wins a name collision.
- `{"BLANKED": ""}` sets the value to empty. It does not remove the name.
- Removal, if it is ever wanted, is a separate key such as
  `readOnlyMountsRemove`, never a sentinel character inside a value.

🛑 **The reason a sentinel is refused: `checkReadOnlyMounts` has no allowlist
pattern, so `!docs` is a legal mount path today.** A later sentinel syntax
would silently redefine an existing file.

## Zero is not a small limit

**`memory` and `cpus` refuse every spelling of zero**, which is 13 for memory
and 7 for cpus. Measured on this host, docker 24.0.7: `--memory 0` leaves
`memory.max` at `max`, and `--cpus 0` leaves `cpu.max` with no quota.

🛑 **The ADD-only ruling cannot reach this.** The ruling protects a NAME, and
for these two keys the value is the only thing there is. A handle file writing
`"memory": "0"` would nullify a profile's cap and obey the letter of the rule.

## One path, one spelling

**A mount path must already be canonical.** No `.` segment, no doubled slash,
no trailing slash.

🛑 **The duplicate check compares STRINGS.** So `docs` in a profile and
`./docs` in a handle file were two mounts of one directory, and the union
merge doubles the chance of a second spelling reaching it.

**Case is NOT folded, deliberately.** `docs` and `Docs` are different
directories on a case-sensitive filesystem, so refusing the pair would reject
a legal layout. Two read-only views of one directory is not a containment
problem.

## A profile name is not a path

`^[a-z0-9][a-z0-9-]*$`. No dot, no slash, no upper case.

🛑 **The name becomes a path segment, so a name that is a path is a
traversal.** The refusal is on the characters rather than on where the
resolved path landed, because two readings of one path is the shape that puts
a directory at two destinations.

**No chaining.** A profile may not name a profile. Two layers stay two layers,
so resolution needs no cycle detection.

## Common pitfalls

- **An unresolvable profile name must be a loud refusal at spawn.** A silent
  fall back to the default container shows an operator a capability the agent
  did not get. ⚠️ **NOT BUILT. Nothing resolves a name yet**, so this is an
  obligation on the reader rather than a description of today.
- **A refusal names the whole file, not the key.** A partial parse would apply
  the legal half of a file and silently drop the rest.
- **`env` may not name `CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN` or
  `CHAT_MCP_MCP_CONFIG`.** `docker run -e NAME` copies this process's value,
  so an override that re-declared one would choose the agent's credential.

---

## Source files

| File                         | Role                                             |
| ---------------------------- | ------------------------------------------------ |
| `src/supervise/overrides.ts` | The two allowlists, every value check, the merge |

## Related docs

- [container-isolation.md](container-isolation.md) — what the default container is, before any override
