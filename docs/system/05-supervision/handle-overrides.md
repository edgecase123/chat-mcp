---
title: Per-handle container overrides
updated: 2026-11-19
covers:
  - src/supervise/overrides.ts
  - src/supervise/overrideStore.ts
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

✅ **ENFORCED, and by the guard that was read as the gap.** `profilesDir()` and
`overridesDir()` are CHILDREN of `stateDir()`, so
`assertProjectDirOutsideState`'s existing `stateDir()` branch refuses an
overlapping project directory for both. Measured on all four spellings — the
two directories, the state dir itself, and its parent.

🛑 **A THIRD `assertDisjoint` CALL PER DIRECTORY WOULD BE DEAD CODE.** The
`stateDir()` branch fires first, so the new branch is unreachable and a test
for it could only pass vacuously. What ships instead is a test on the
CONTAINMENT, `test/util/override-dirs.test.ts`. Move either directory out from
under `stateDir()` — the way `manifestDir()` is a sibling — and it goes red,
which is the signal the explicit call is then owed.

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

- **An unresolvable profile name is a loud refusal.** A silent fall back to the
  default container shows an operator a capability the agent did not get.
  ✅ **BUILT.** `resolveOverrideFor` throws naming three things: which handle
  asked, which name it asked for, and the path it looked at. The path is there
  because an operator who wrote the file into the wrong tree sees a name they
  recognise and a location they do not.
- **A refusal names the whole file, not the key.** A partial parse would apply
  the legal half of a file and silently drop the rest.
- **`env` may not name `CLAUDE_CODE_OAUTH_TOKEN`, `GH_TOKEN` or
  `CHAT_MCP_MCP_CONFIG`.** `docker run -e NAME` copies this process's value,
  so an override that re-declared one would choose the agent's credential.

---

## Source files

| File                             | Role                                                     |
| -------------------------------- | -------------------------------------------------------- |
| `src/supervise/overrides.ts`     | The two allowlists, every value check, the merge. PURE   |
| `src/supervise/overrideStore.ts` | Reads both files off disk and resolves the pointer       |
| `src/util/paths.ts`              | `profilesDir`, `overridesDir`, and the two path builders |
| `src/util/naming.ts`             | `assertProfileName` — the ONE copy of the name pattern   |

🛑 **`overrides.ts` STAYS PURE, AND THE SPLIT IS WHY.** It is the module a
reviewer reads to answer "what may a human write", and mixing `readFileSync`
into it means every test of a value check needs a temp directory.

🛑 **THE NAME PATTERN LIVES IN `util/naming.ts`, NOT `overrides.ts`.**
`profilePathFor` needs it and `src/util` cannot import from `src/supervise`
without a cycle — so a local regex in each place was two copies that could
disagree about what a name is.

## Still open

**`mergeOverrides({ profile: handle, handle: profile })` still type-checks.**
`HandleOverride` is `ContainerOverride` plus an optional key, so each is
assignable to the other and the transposition is invisible to the compiler.
Naming the arguments removed the POSITIONAL slip only. Branding the two layers
would close it, and would ripple into the consumer type.

⚠️ **What holds today is a test, not the type** — `🛑 the HANDLE wins a
collision, not the profile` in `test/supervise/override-store.test.ts`.
Verified non-vacuous by transposing the call: 1 of 12 goes red, and only that
one, because `env` unions in both directions.

## The spawn seam

**`startSupervisor` resolves the override ONCE and injects it at the `spawnFn`
wrapper.** `dockerRunPlan` reads it off `SpawnOptions.containerOverride` and
never touches disk itself.

```
startSupervisor   resolveOverrideFor(handle)   once, before anything spawns
      |
   spawnFn        { ...o, containerOverride }  the ONE wrapper
      |
      +-- first start   -+
      +-- restart       -+--> dockerRunPlan --> docker run flags
      +-- replace       -+
```

🛑 **THE WRAPPER, NOT THE THREE CALL SITES.** An override added per call site
is an override that will be at two of them next time someone adds a fourth,
and the one it loses is the restart — so a handle restarted for a full context
comes back uncapped with the operator's file still on disk. Pinned by
_"a RESTARTED child carries the same override"_, which is red when the
injection moves to the first call site and green when it does not.

⚠️ **A HOST HANDLE WITH AN OVERRIDE FILE IS WARNED, NOT REFUSED.** Every key
is a `docker run` flag, so a host spawn can honour none of them — and without a
line saying so the file sits on disk looking effective. Refusing the start
would be worse: it would break a handle configured for the mode it is going
back to. Raised by claude2 reviewing PR 337.

🛑 **AT START, NOT PER SPAWN.** A malformed or dangling override throws.
`doRestart` kills the child before it respawns, so a throw at spawn time leaves
the handle with no agent and no remedy short of restarting the supervisor. The
cost is that editing a file mid-session needs a supervisor restart.

### What is wired, and what is not

| key              | wired          | why not                                                    |
| ---------------- | -------------- | ---------------------------------------------------------- |
| `memory`         | ✅ `--memory`  |                                                            |
| `cpus`           | ✅ `--cpus`    |                                                            |
| `image`          | ✅ the operand |                                                            |
| `env`            | ❌             | the operator's consent banner must show it too — see below |
| `readOnlyMounts` | ❌             | same banner, and it must route through `checkedMountPath`  |

🛑 **`image` HAS THREE READERS AND ONE RESOLVER.** `effectiveImage(vendor,
opts)` in `drivers/containerized.ts` is the only place the choice is made.

```
dockerRunPlan                    the agent container's image operand
dockerInstallPlan                the install container's image operand
runDependencyInstall             what `docker image inspect` is asked about
```

**Honouring an override in one of the three is worse than honouring it in
none.** The agent loads `node_modules` out of the volume the install container
wrote, so two images means a native module built against one runtime and
loaded by another. A guard that inspects the vendor's image while the plan runs
the override's passes, and docker then fails on the real image with the bare
`Unable to find image` the guard exists to replace.

⚠️ **`--container` IS THE WRONG REMEDY FOR A MISSING OVERRIDE IMAGE**, so the
refusal has two forms. That flag builds this project's own tag and never builds
or pulls one a human named in a file. An operator told to re-run with it
watches it succeed and hits the identical refusal.

🛑 **THE INSTALL CALL IS NOT THE SPAWN SEAM.** `startSupervisor` builds the
`installDeps` argument itself, beside the spawn rather than through the
`spawnFn` wrapper, so the seam's injection cannot reach it. The override is put
on that object explicitly, and a test asserts both the presence and the
`null` control.

🛑 **THE RESOURCE FLAGS GO IN THE ARGV BEFORE THE IMAGE NAME.** `docker run`
reads its own flags up to the image and hands everything after it to the
container as a command. A `--memory` below that point reaches `sh` inside the
container as an unknown argument, so the container runs UNCAPPED and docker
reports nothing — an operator reading `docker inspect` sees no limit and has no
error to connect it to.

## 🔴 The consent banner reads no override

**`describePlan` builds its `mounts:` line from `readMounts()` and its
`env vars` line from the vendor plus `GH_TOKEN`.** It reads no override, and it
has no field for `memory`, `cpus` or `image`.

So an override setting `env` or `readOnlyMounts` would reach the spawn and
never reach the sentence the operator agreed to.

🔴 **THREE WIRED KEYS ALREADY SIT IN THAT GAP, AND `image` IS THE WIDEST OF
THEM.** `memory` and `cpus` narrow what the agent may consume, so a banner that
does not name them understates the sandbox. **`image` replaces the filesystem
and every tool in it**, which is a different thing entirely from a cap.

```
memory / cpus    a banner that omits them UNDERSTATES the limits
image            a banner that omits it DESCRIBES THE WRONG CONTAINER
```

⚠️ **This is not an argument to unwire `image`.** It is the reason the banner
question outranks the two keys still waiting on it. Tracked on #222.

⚠️ **`isConfirmed` latches per handle, so the banner is shown on the FIRST
start only.** An override written after that first start is shown to nobody at
any time. That is why `env` and `readOnlyMounts` are not wired ahead of the
banner.

## Related docs

- [container-isolation.md](container-isolation.md) — what the default container is, before any override
