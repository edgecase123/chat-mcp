---
title: Container Isolation
updated: 2026-11-26
covers:
  - src/supervise/drivers/containerized.ts
  - src/supervise/index.ts
  - src/index.ts
---

# Container Isolation

What a containerized agent can reach, which of its two containers holds the
credentials, and why the dependency install is not one of them.

---

## Two containers per spawn, and only one holds a credential

```
1  INSTALL   docker run --rm                         NO -e flags at all
             -v <project>:/work
             -v <volume>:/work/node_modules
             sh -c '<lockfile-guarded npm ci>'

2  AGENT     docker run -i --rm --name chat-mcp-<handle>
             -e <vendor auth>  -e GH_TOKEN  -e CHAT_MCP_MCP_CONFIG
             -v <project>:/work
             -v <volume>:/work/node_modules
             -v <each mounts.json dir>:ro
             --tmpfs /work/.cursor
             sh -c '(write mcp config) && exec "$@"'
```

The install runs to completion first. The agent container never installs
anything.

## Why the install is a separate container

A dependency's lifecycle script runs as `agent`, the same uid as everything
else in the container. Docker hands the credentials to PID 1, which was the
prelude shell. So a script could read all three out of `/proc/1/environ`.

The lockfile that decides which packages install comes from the mounted project
tree. **So the tree chose the code that read them.**

🛑 **No in-container scrub can close that.** The `env -u` that used to wrap the
`npm ci` altered only its own child's environment, never PID 1's. It was
measured open on both routes and has been deleted — a scrub left in place reads
as a boundary it never was.

## Exactly two mounts on the install

Per lee's ruling of 2026-11-14: the project bind and the `node_modules` volume,
nothing else.

The agent's extra `mounts.json` directories do not come here. The only one
configured in practice is the whole local-context store, and an install script
has no business in it.

🛑 **THE `/work/.cursor` MASK IS THE AGENT'S ALONE, FOR THAT RULING.** The
install reads no config directory, so a third mount there buys nothing. It is
emitted by `configMaskArgs`, not by the shared `projectMountArgs`, and the
install's mount count is asserted as two so the shared spelling cannot creep
back.

## The `/work/.cursor` mask, and the shadowing it stops

**A vendor CLI reads the PROJECT config directory before the one in its home
directory. `/work` is the container's cwd, so the host's copy wins — and every
path in the host's copy is a host path.**

```
what the prelude writes   /root/.cursor/mcp.json   http + bus token   CORRECT
what the host arm writes  <project>/.cursor/mcp.json  stdio + nvm node path
what the container read   /work/.cursor/mcp.json   <- the SAME host file
```

`deliverHostGrantFile` writes the host arm's file with
`command: process.execPath`. Inside the container that nvm `node` does not
exist, so the load failed with `spawn …/bin/node ENOENT` and the agent started
with no bus tools at all. It answered in its own transcript and could not
`send`.

⚠️ **`mcp list` IS NOT THE INSTRUMENT.** It reports only
`chat: Error: Connection failed`, which reads as a network fault and sent two
sessions after connectivity. `mcp list-tools chat` names the real cause.

🛑 **A CONFIG BEING CORRECT PROVES NOTHING UNTIL YOU KNOW IT IS THE CONFIG THAT
WINS.** The correct file sat unread in `/root` the whole time, and every check
that read only that file reported healthy.

**Why a tmpfs rather than a volume.** Nothing needs to persist — the mask
exists only so the `/root` copy wins — and a tmpfs is empty by construction,
with none of a volume's copy-up semantics to reason about. Nothing prunes named
volumes either.

**Why it is unconditional rather than gated on the Cursor vendor.** A host
config directory holds host paths inside every vendor's container, and a vendor
branch here is a second thing to drift from the one that decides the prelude's
config path. `.gitignore` excludes `.cursor/`, so no committed project rules
are hidden by the mask.

**A declared read-only path at `.cursor` is REFUSED.** It passes every
containment check and then lands on the mask's destination, which the daemon
rejects while naming neither mount. `CONTAINER_OWNED_PATHS` carries the reason
beside each path, so a `.cursor` collision does not report `node_modules`.

## What has to happen before the first container starts

Three steps, all in the `supervise` action, and all keyed on the **resolved
sandbox mode** rather than on the `--container` flag.

```
resolveDriver({driver, container}).mode === "docker"
  |
  1 CONFIRM   the plan is printed, the operator answers y        once per handle
  2 COMPILE   npm run build                                      EVERY start
  3 BUILD     chat-mcp-agent:local, when the inputs hash moved   when dist moved
             SKIPPED ENTIRELY when the handle runs another image
  |
  startSupervisor()
```

🛑 **STEP 3 IS SKIPPED WHEN THE PLAN'S IMAGE IS NOT `chat-mcp-agent:local`.**
`prepareAgentImage` takes the effective image and returns after the compile
when it is anything else, logging one line that names it.

**Without that, an `image` override paid for a full build of this project's
tag and was THEN refused for not having its own image on the machine.** The
refusal is correct and is lee's ruling of 2026-11-15; what was wrong was
spending minutes of docker before it.

⚠️ **The freshness check is skipped too, not just the build.**
`imageNeedsBuild` inspects `chat-mcp-agent:local` and hashes this project's
sources, so consulting it for a handle on another image is a verdict about the
wrong thing — and it is the call that decides whether the minutes are spent.

🛑 **STEP 2 IS UNCONDITIONAL, AND IT HAS TO COME BEFORE STEP 3.** The inputs
hash covers `dist`, which is build OUTPUT. The compile used to sit inside step
3's branch, so a `src/` edit moved nothing the hash could see: the branch did
not run, the compile did not run, and the container started on the
last-compiled `dist` while the check reported the image as current.

🛑 **A HOIST, NOT A DEDENT.** A compile placed after the freshness verdict —
even outside the branch — still hashes the stale `dist`. The order is the
property, and `prepareAgentImage` in `supervise/container.ts` owns it.
`build-before-freshness.test.ts` asserts the sequence; the dedent is one of
the two mutants it is measured against.

⚠️ **An unconditional compile is not an unconditional docker build.** A no-op
`tsc` is ~1.34s, and `buildInputsHash` is a content hash — identical bytes
produce the same hash, so step 3 still skips.

🛑 **The mode is the gate because `--container` is not the only spelling.**
`--driver docker-claude` resolves to `mode: "docker"` on its own, and an alias
added to `ALIASES` later will too. Keyed on the flag, those spellings reached
`startSupervisor` with no image and no confirmed plan, and it refused the
handle it had just been told to start.

⚠️ **Confirmation comes first, then the compile and the build.** The docker
build is minutes, and an operator who answers `n` must not have paid for an
image they refused. The compile sits on the same side of that question.

🛑 **With no terminal attached the confirmation REFUSES instead of asking.**
`rl.question` resolves to `''` at EOF, which is not `y`, so a scripted start
used to print `aborted` and exit 0 — a green exit code with no agent started.
It now throws, and names approving the plan once from a terminal as the remedy.

## What is still open

🚨 **A substituted package still executes inside the agent container, which
holds every credential.** Splitting the install does not change that — the
agent needs its dependencies and its tokens in the same place.

⚠️ **It is cross-handle, not just self-inflicted.** The volume is keyed on
handle × tree, and a tree is reachable by several handles. So handle A can
write an `.npmrc` into the shared read-write tree, handle B's install pulls the
substituted package into B's own volume, and B executes it with B's
credentials.

🛑 **There is no `--network=none` on either container.** `npm ci` has to reach a
registry, so egress is available to anything that runs.

⚠️ **`buildImage` builds one tag and passes no `--build-arg`.** `Dockerfile`
can produce either vendor's image since #317, but nothing asks it to — so
`chat-mcp-cursor-agent:local` exists only if someone builds it by hand. See
[vendors.md](vendors.md) § One image per vendor for the command.

## Where the install is called from, and why it matters

`runDependencyInstall` is synchronous, so it blocks the supervisor's event
loop.

| call site                         | path | cost                                   |
| --------------------------------- | ---- | -------------------------------------- |
| `startSupervisor`, above the bind | cold | a full `npm ci`, nothing listening yet |
| `spawnContainerized`, every spawn | warm | one container start                    |

**The pre-bind call is what makes the first start's cold install harmless.**
Nothing is waiting on the socket yet, so a caller blocking is honest.

**The per-spawn call is what keeps a restart correct.** A lockfile that changed
mid-session must not leave the agent on the previous dependency tree.

## Common pitfalls

⚠️ **A restart after a lockfile change is still a cold install on a bound
loop.** It is accepted rather than fixed. Refusing that restart was the
alternative and it is worse: `doRestart` kills the child before it spawns, so a
refusal leaves the handle with no agent at all and no remedy short of
restarting the supervisor.

⚠️ **The volume outlives `--rm`.** One install's output is reused by every
later spawn for that handle and tree. `docker volume rm` is the only reset, and
nothing prunes them.

⚠️ **The install's stderr is inherited by the supervisor, not the agent.** That
is where `NO_LOCK_HASH_WARNING` lands.

---

## Source files

| File                                     | Role                                                                |
| ---------------------------------------- | ------------------------------------------------------------------- |
| `src/supervise/drivers/containerized.ts` | Both plans, the install runner, the shared mount and target helpers |
| `src/supervise/index.ts`                 | The pre-bind install call                                           |
| `src/index.ts`                           | The `supervise` action's confirm-then-build gate                    |

## Related docs

- [agent-liveness.md](agent-liveness.md) — whether anybody is actually in the container
- [child-output.md](child-output.md) — which of a child's streams reach the log
- [state-directory.md](../03-infrastructure/state-directory.md) — the host state the container is denied
