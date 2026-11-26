# AGENTS.md

Guidance for any coding agent working in this repo.

## What this is

`chat-mcp` — a local, no-cloud message bus that lets multiple AI coding
agents (and the human) talk to each other over MCP. TypeScript, Node 22+,
stdio MCP shim + a browser dashboard, backed by a single SQLite file under
`~/.chat-mcp/` (or `$CHAT_MCP_HOME`). Full design: `DESIGN.md`.

⚠️ **There is also a CLI, and it is being PHASED OUT.** Read the directive
below before you build anything on it.

## 🛑 THE WEB UI IS THE OPERATOR SURFACE. THE CLI IS BEING PHASED OUT.

**lee, `#mcp` 15413, 2026-11-17:** _"web ui only. cli will be phased out."_

So a new operator-facing control lands in the browser dashboard, not in
`src/index.ts`. A ticket that proposes both gets the web half only.

- **Do not add a new `program.command(...)`** for an operator action. Propose
  the dashboard control instead and say why in the ticket.
- **The existing CLI commands stay** until lee says otherwise. This is a rule
  about what is ADDED, not a licence to delete what works.
- **The MCP shim tools are NOT the CLI** and are unaffected. Agents reach the
  bus through them, and that is the supported path.
- ⚠️ **`chat-mcp cli` and `chat-mcp web` both still run.** The phase-out is a
  direction, and no removal date has been set.

🛑 **A TICKET WRITTEN BEFORE 2026-11-17 MAY STILL PROPOSE A CLI SURFACE.
THE TICKET IS NOT THE RULING.** Re-scope it to the web UI and say so on the
ticket. #13, #91, #152 and #181 are all in that state today.

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

🛑 **`npm test` IS NOT THE GATE. CI ALSO RUNS `npm run format:check`**, which
is `prettier --check .` over the whole tree. Running `prettier --write` on the
files you happened to name passes locally and still fails CI, so run
`npm run format:check` before you push. One missed test file cost a red check
on PR 296 with a green local suite.

**Tests under the node runner refuse the real `~/.chat-mcp` directory.**
Set `process.env.CHAT_MCP_HOME` to a temp dir _before_ importing anything
that resolves a state path — see `src/util/paths.ts`'s `stateDir()` for why,
and any `test/supervise/*.test.ts` for the pattern.

## Three clones: one runs the bus, two are edited

Two agents work this repo at the same time. A third clone runs the bus they
talk over, so neither agent's work-in-progress can take the comms down.

| clone                 | role                                           | handle    |
| --------------------- | ---------------------------------------------- | --------- |
| `~/dev/chat-mcp-main` | runs the bus for both agents. Stays on `main`. | —         |
| `~/dev/chat-mcp`      | claude1 edits and tests here                   | `claude1` |
| `~/dev/chat-mcp2`     | claude2 edits and tests here                   | `claude2` |

Each agent clone carries a `.mcp.json` at its root, **gitignored and
per-tree**. It names that clone's handle and points at `chat-mcp-main`:

```json
{
  "mcpServers": {
    "chat": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/Users/leejenkins/dev/chat-mcp-main/dist/index.js",
        "--handle",
        "claude2"
      ],
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

Ports are already not a collision: `chat-mcp web` prefers `127.0.0.1:3737` and
falls back to an OS-assigned free port when a sibling already holds it, and
`--port` overrides both. The state is the shared thing. `stateDir()` in `src/util/paths.ts`
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
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/leejenkins/.chat-mcp/adapters/claude-code-claude2.sh"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/Users/leejenkins/.chat-mcp/adapters/claude-code-context-claude2.sh"
          }
        ]
      }
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

> _"NO FILE SHIM SHARING. Put that in AGENTS.md or somewhere that it is
> cannonized"_ — then, scoping it: _"For the dokcer/stdin arc, that is. NO
> FILE SHIMS"_

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
- 🛑 **The install runs `npm ci --ignore-scripts`, and dropping that flag
  breaks two things at once.** Without it `npm ci` runs THIS project's own
  `prepare`, which is `npm run build` — so the install ran `tsc` against the
  host checkout that `/work` binds read-write, writing 14 files into `dist/`.
  **`dist/` is what the host supervisor runs from.** And a failing `tsc` exits
  1, the prelude chains on `&&`, so **no agent starts at all** on any branch
  carrying a type error. Both measured in a built image.
- ⚠️ **The flag costs esbuild nothing.** `@esbuild/<platform>` ships its binary
  as an optional dependency, so no dependency in this lockfile needs a build
  step. A node-gyp addon would, and adding one means revisiting this.
- 🚨 **The install still runs code this project did not write, and it is INSIDE
  the boundary.** `--ignore-scripts` removes the lifecycle-script route, not the
  credentials: the config file at `$HOME` is `0600` owned by the same `agent`
  uid, and `/proc/1/environ` holds all three because docker hands them to PID 1.
  **Both routes measured in a built image.** The `env -u` scrub is NOT a
  boundary. **#231 is the boundary** — the install moving to its own
  credential-free container.
- ⚠️ **The volume is writable, executable code that outlives `--rm`.** One
  hostile install persists, because the lockfile-hash guard then skips the
  reinstall. `docker volume rm` is the only reset. **No CLI prints the name**,
  so list them by prefix:
  `docker volume ls -q --filter name=chat-mcp-node-modules-`.
- ⚠️ **Nothing prunes those volumes.** One per handle × tree, and `resolveCwd`
  accepts any directory contained by an allowed one, so the key space is wider
  than one per checkout.
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

## 🛑 The supervisor starts every container itself

**A container is started by `docker run`, spawned by the supervisor. Never by an
orchestrator that sits between them.**

lee, 2026-11-19, ruling on the #222 override arc:

> _"contianer should NOT be started by docker compose, we want to retail i/o
> control"_

### Why — the three pipes ARE the connection

```js
// src/supervise/drivers/containerized.ts
const child: ChildProcessWithoutNullStreams = spawn("docker", plan.args, {
  stdio: ["pipe", "pipe", "pipe"],
```

The supervisor holds the container's stdin, stdout and stderr in its own hands.
That is how it talks to the agent inside. Any starter placed in between owns
those pipes instead, and the supervisor loses the connection it exists to hold.

### What this forbids

- `docker compose up` as the spawn path, now or later.
- Any orchestrator that declares containers up front. A container here is
  created per handle, at the moment it is needed, which a declared service set
  cannot express.
- A wrapper script that starts the container and hands back a pid. The pid is
  not the pipe.

### What it does NOT touch

🛑 **The test is one question: does this call carry the AGENT's stdin?**
Exactly one `docker` call does — the spawn above. Everything else is outside the
rule, and an enumeration of the exceptions would go stale the moment a new
`docker` call lands.

⚠️ **The host driver carries it too**, at `drivers/host.ts`. Both drivers hand
their child to `wireAgentChild`, so owning the agent's pipes is the shape of
every spawn path here, not a container-only rule.

- **Authoring the config.** A human edits validated JSON, by lee's separate
  ruling of the same day. That is a different half of the same question.
- **Every other `docker` call the supervisor makes for its own bookkeeping** —
  `docker rm -f`, `docker stop`, the dependency-install container, and
  `docker ps -aq` while it waits for a name to disappear.
  ⚠️ **`docker ps` DOES hold a pipe**, `["ignore","pipe","ignore"]`. That
  pipe reads one line of docker's own stdout. It is not the agent's stdin, and
  that distinction is the rule — not the absence of pipes.
- **Building and inspecting the IMAGE.** `docker build` and
  `docker image inspect` live in `src/supervise/container.ts`, outside the
  driver. An image is not a container, so starting one is not what this rule
  governs.
- Generating a compose file as an artifact for a human to read. Nothing reads
  one today, and this rule is about who STARTS a container, not what may be
  written down.

⚠️ **No compose file exists in this repo.** This rule stops one being added to
the spawn path; it removes nothing.

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

## 🛑 A dockerized sibling is presumed DEAD until a round trip comes back

**Liveness belongs to the CHILD, and the container, the socket and the pidfile
all report the SUPERVISOR.** All three outlive a child that has exited, so not
one of them answers "is anyone there". `./scripts/agent status` prints exactly
those three.

- ✅ **`list_agents`' `online` IS the check, since the supervisor started
  clearing a dead child's pid.** `child.onExit` calls `dao.clearAgentPid`, and
  `isProcessAlive(null)` is `false`. **Call it before any hand-off.**
- 🛑 **BEFORE that fix it read the SUPERVISOR, and the reason is worth knowing.**
  A containerized child's row is written by `shimContextFor` running inside the
  host bus, so `row.pid` was the supervisor's and an exited child read
  `online: true`. Full mechanism:
  `docs/system/05-supervision/agent-liveness.md`.
- **`last_seen_at` is the second opinion**, and the one to read when `online`
  is true but the agent is unresponsive. 17 of the 20 shim tools move it;
  `claims`, `health` and `search` move nothing, so it over-reports dead — the
  safe direction.
- 🛑 **`room_send`'s `notified` is a MEMBERSHIP count, not a delivery count.**
  `notified: 4` in a room with one live reader is the normal case, not a fault.
  **Read `online_members` beside it** — that is the live count, and
  `online_members: 0` with `notified` above zero means the send worked and
  nobody is there to read it.
  Reading it as four readers is how a review request goes to a dead agent and
  gets reported as handed off.
- **Silence is not a review, and it is not "no findings".** A dockerized
  sibling that has not answered has not started. Never record its silence as
  either, and never merge on it.
- **Ask for an acknowledgement, not only for the work.** A round trip is the
  one signal that proves the agent is reading, rather than merely running.

⚠️ **This is the process half of #229, and the product half has now landed
too.** `online` tells you whether anybody is there, and `online_members` says
how many in a room. 🛑 **Neither tells you anybody READ it** — only a reply
does, which is why the round-trip rule above still stands.

## 🛑 TAG WHO YOU ARE ADDRESSING. EVERY ROOM POST.

**lee, 2026-11-26: a room post opens with a tag naming its addressee.**

```
#lee:      for lee alone
#claude1:  for claude1 alone
#here:     for everyone in the room
```

- **The tag is the FIRST thing in the post.** It is an addressee line, not a
  mention buried mid-sentence.
- **Tag every post.** An untagged post is exactly the ambiguous case this rule
  exists to remove.
- **Several addressees get several tags** — `#claude1: #claude2:`.
- **`#here` is not a polite default.** It says every member should read this,
  and lee reads the sum of both agents.

### What the tag does to the claim protocol below

🛑 **A tag naming ONE agent makes `claim answer-<id>` UNNECESSARY, and that is
the whole point.** The next section already rules that a question naming one
agent belongs to that agent. **The tag IS that naming, made explicit.**

```
#claude1: ...    claude1 answers. NO claim needed. claude2 stays out.
#here: ...       the claim protocol below applies IN FULL.
untagged          read as #here. Claim before answering.
```

- ⚠️ **A tag does not make the sibling deaf.** Every member still receives every
  room message. The tag says who OWES a reply, never who may see it.
- 🛑 **Do not answer a post tagged for the sibling.** Add to it only when it
  MISSES something, and say that is what you are doing.

⚠️ **lee's bus handle is `leejenkins` and he writes the tag `#lee:`.** Accept
both. `#lee:` is the form he uses.

⚠️ **A leading `#` also starts a ROOM name, so a tag and a room read alike.**
**The trailing colon is what tells them apart, which is why it is not
optional.**

🛑 **`#here` IS RESERVED BY CONVENTION ONLY. THE CODE RESERVES NOTHING.**
`#here` matches the room-name pattern in `util/naming.ts`, and `assertRoomName`
has no reserved list, so `room_join("#here")` would create a real room called
`#here`. **Nothing enforces this rule — if that matters, the guard still has to
be written.**

## 🛑 CLAIM `answer-<id>` BEFORE REPLYING TO lee

**Both agents answer the same question inside 10 seconds, so "read the room
first" cannot reach this.** Measured 2026-11-25: three of lee's questions each
drew two near-identical answers.

```
17348  the README task     8s apart
17360  the context gauge   7s apart
17366  the search scope    9s apart
```

**All six posts were individually correct.** lee reads the SUM of both agents,
so he paid three times for one answer.

- **A question that NAMES one agent is THAT agent's, and no claim is needed.**
  lee does this deliberately — _"that's my drop claude1, I need to address you
  specifically"_. 🛑 **A name that is NEITHER of us is the unnamed branch:
  claude1 answers first.**
- **A question the SIBLING asked is THEIRS.** Check that first. It costs
  nothing and it settles most cases.
- **Otherwise `claim answer-<id>`**, where `<id>` is lee's message id. Both
  agents derive the same resource name from the same input, which is why a
  claim works where an announcement races.
- ✅ **Granted → answer, then RELEASE ON POST.**
- **Refused → WAIT.** When their post lands, add only what it MISSES.
  **Nothing in 2 minutes → ANSWER ANYWAY.**

🛑 **RELEASE-ON-POST IS LOAD-BEARING, BECAUSE THE CLAIM FAILSAFE IS 240
MINUTES.** A holder that stalls without releasing leaves lee unanswered for
four hours. **A duplicate costs lee one read; silence costs him the answer.**

⚠️ **AN IN-ROOM "TAKING 17411" IS NOT THE MECHANISM.** It works only when the
sibling reads before posting, and at 7 seconds neither does. Announce as well
if you like, but claim first.

## Review order: self, then sibling

Run the matching `.claude/agents/*.md` reviewer(s) on your own diff **before**
handing it to the other agent for peer review. "Matching" means the diff
falls inside that agent's own `description:` frontmatter trigger — a diff
that matches no reviewer is exempt; say so at handoff instead of staying
silent. Adapted from `leagues`' CLAUDE.md, which anchors the same reviewers
to before the gate — this repo has none, so the anchor is before sibling
handoff. A finding a sub-agent catches pre-review costs nothing; the same
finding caught by the sibling costs a round trip back to you.
