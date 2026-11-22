---
title: Supervised Vendors
updated: 2026-11-20
covers:
  - src/supervise/vendor.ts
  - src/supervise/drivers/index.ts
  - src/supervise/drivers/claude.ts
  - src/supervise/drivers/cursor.ts
  - src/adapters/claude-spawn.ts
  - src/adapters/cursor-spawn.ts
  - src/adapters/cursor.ts
  - src/adapters/index.ts
---

# Supervised Vendors

Which agent CLIs the supervisor can drive, and what a vendor has to declare
about itself before it can be spawned.

---

## The two vendors today

|                          | Claude Code            | Cursor                                    |
| ------------------------ | ---------------------- | ----------------------------------------- |
| binary, on the host      | `claude`, on `PATH`    | `cursor-agent`, **absolute path only**    |
| binary, in the container | `claude`, on `PATH`    | `/usr/local/bin/cursor-agent`             |
| installed by             | npm                    | `curl https://cursor.com/install \| bash` |
| one process serves       | many turns             | **one turn**                              |
| turn ends on             | `{"type":"result"}`    | `{"type":"result"}`                       |
| reports a usage window   | yes                    | no                                        |
| reports context fullness | yes                    | no                                        |
| container image          | `chat-mcp-agent:local` | `chat-mcp-cursor-agent:local`             |
| reaches the bus          | yes                    | **not yet**                               |

## A vendor declares its own capabilities; the wiring never infers them

`VendorSpawn` carries three booleans that the supervisor reads rather than
guesses: `reportsUsage`, `reportsContext` and `processPerTurn`.

**Declaring one wrongly fails silently, which is why they are declared at all.**
`reportsUsage: true` promises that the vendor's event router will call the
`usage` sink. A vendor that promises it and never calls it leaves the operator
reading _"awaiting the first reading"_ forever.

⚠️ **Token counts are not a usage window.** Cursor's result event carries five
token-count fields, and `reportsUsage` is still `false`, because the sink takes
a `RateLimitSnapshot` — a subscription status with named windows. The two are
easy to confuse and the confusion reproduces the bug above.

## Sharing an event spelling is a coincidence, not a contract

Both CLIs happen to end a turn with `{"type":"result"}`.

🛑 **That makes a shape-sniffing bug above the driver invisible.** Code that
tested `event.type === "result"` directly would pass for both shipped vendors
and strand the first CLI that disagrees, with the supervisor hanging after its
first message. Each driver still maps its own signals onto the semantic
callbacks.

## One turn per process changes what an exit means

Cursor's `-p` mode reads its prompt from stdin to EOF and then exits.

```
turn ended, then exit 0           a clean turn
turn ended, then exit non-zero    still clean, and the code is reported
exited with NO turn end           a death
```

**A Cursor handle is offline between turns.** Its MCP shim is a child of the
turn's process and dies with it, so Cursor cannot be the test vehicle for a
long-lived-stdio goal.

## In a container, a per-turn vendor runs behind the turn relay

🛑 **The supervisor's stdin and `cursor-agent`'s disagree about lifetime.** The
supervisor writes one prompt to a long-lived stdin and never closes it;
`cursor-agent -p` reads stdin to EOF. Wired together the agent blocks forever
and emits nothing — #380.

So a per-turn vendor's container command is not its CLI. It is the relay:

```
docker run -i  ->  node /opt/chat-mcp/dist/relay/bin.js \
                     --vendor cursor [--resume <id>] -- <cli argv>
```

| part                | who owns it                                            |
| ------------------- | ------------------------------------------------------ |
| one container       | stays alive across turns, so the MCP handshake is once |
| one process a turn  | the relay spawns the CLI and closes THAT stdin         |
| the turn boundary   | the vendor's own `routeEvent`, never a second matcher  |
| the session id      | the relay holds it and appends `resumeFlags` per turn  |
| the prompt envelope | one base64 line, applied by the container driver only  |

⚠️ **The framing is container-specific.** `encodeInput` also feeds the host
per-turn path, which writes straight to the CLI, so the base64 frame is applied
in `spawnContainerized` rather than in the vendor.

🛑 **A prompt reaching the relay unframed is refused, not guessed at.** Base64
decoding cannot fail, so an unframed line would decode to binary garbage and the
agent would answer a prompt nobody wrote.

## Three Cursor flags that fail by producing nothing

Each of these exits cleanly with zero events when omitted, which the supervisor
cannot distinguish from an agent that had nothing to say.

| flag             | what happens without it              |
| ---------------- | ------------------------------------ |
| `--trust`        | exit 1, `Workspace Trust Required`   |
| `--force`        | tools stay gated and nothing answers |
| `--approve-mcps` | the bus servers stay unapproved      |

⚠️ `--yolo` is an alias of `--force`, not a separate enabler. Claude Code's
near-identical pair _is_ an activator/enabler split, and Cursor has no
equivalent — do not carry the habit across.

## How a contained Cursor child reaches the bus

🛑 **`cursor-agent` accepts NO config-path flag.** Measured on #372 against the
live binary: `cursor-agent mcp --help` names `.cursor/mcp.json or
~/.cursor/mcp.json`, and no config-path option appears among its 24 long flags.

**So for Cursor the PATH is the wiring, and `mcpConfigFlags` is correctly
empty.** `--approve-mcps` is what makes the file take effect — without it the
server is prompted for, and a supervised child has no TTY to answer with.

| mode     | where the config goes    | why                                         |
| -------- | ------------------------ | ------------------------------------------- |
| `docker` | `/root/.cursor/mcp.json` | the image has no operator config to clobber |
| host     | the grant's own path     | `~/.cursor/mcp.json` is the human's file    |

⚠️ **A HOST Cursor child still reaches no bus, and that is still deliberate.**
The only way to wire it is a file this project may not own. That is a separate
decision from the container one.

🛑 **`VendorSpawn.containerMcpConfigPath` is REQUIRED and per-vendor.** It was
one `${containerHome}/.chat-mcp-mcp.json` for every vendor, which works only
for a CLI that can be POINTED at a path. Claude Code can be; Cursor cannot. So
the file landed where Cursor never looks, and its contained agent reached the
bus never while reporting a clean start — #372.

🛑 **The prelude `mkdir -p`s the directory before writing.** The Cursor image
has no `/root/.cursor`, and `prelude` chains on `&&`, so a failed redirect
means `exec "$@"` never runs and no agent starts at all.

⚠️ **Still unproven: that this produces a working TURN.** The flags and the
paths are measured; a live containerized Cursor turn needs #317's acceptance
harness and has not been run.

## One image per vendor

Ruled by lee on 2026-11-20: _"cursor should have its own image"_.

**The container is the security boundary, so a single image carrying both CLIs
would put a second agent CLI inside every sandbox with no use for it.**

**One Dockerfile builds both, selected by a build arg.** There is no second
Dockerfile and no `--target`:

```bash
docker build -t chat-mcp-agent:local .                              # claude
docker build -t chat-mcp-cursor-agent:local \
  --build-arg AGENT_VENDOR=cursor .                                 # cursor
```

```
ARG AGENT_VENDOR=claude
FROM node:22-slim AS base      apt, the gh CLI, git config  — vendor-agnostic
FROM base AS cli-claude        npm install -g @anthropic-ai/claude-code
FROM base AS cli-cursor        a pinned tarball into /opt/cursor-agent
FROM cli-${AGENT_VENDOR}       useradd, npm ci, the chowns, USER agent
```

🛑 **A per-vendor `--target` cannot work, and the reason is #242.** The shared
tail ends in `chown -R agent:agent /root`, which exists because a root-run `npm`
repopulates `/root/.npm` after the `useradd` chown. A vendor target would sit
either below that chown, re-breaking #242, or above it, duplicating the 44-line
tail. The dynamic `FROM` keeps one copy of both.

🛑 **The Cursor CLI is pinned by sha256 and installed root-owned.** It checks
for updates with no documented opt-out, so the pin describes nothing unless
`agent` cannot rewrite the install. `/opt/cursor-agent` is outside every path
the shared tail chowns; `/root/.local`, where Cursor's own installer puts it,
is not.

⚠️ **Nothing passes `--build-arg` yet.** `buildImage` hardcodes one tag, so a
containerized Cursor spawn still fails on a missing image rather than silently
running the Claude one.

🛑 **`VendorSpawn` carries TWO binaries, because a container is a different
filesystem.** `binary` is the host path and `containerBinary` is the one the
image installs. Both are REQUIRED, so a new vendor cannot inherit the host path
by omission.

⚠️ **This used to be ONE field, and a containerized Cursor agent had never
started.** The host path lives under the operator's home, which does not exist
in the image, so the container exec'd it and exited 127. That reads as a dead
agent rather than a missing CLI, which is why 2352 passing tests never saw it.

🛑 **`--binary` has NO default, and that is the second half of the same fix.** A
static `"claude"` on the option was forwarded on every invocation, so the
vendor's own value was unreachable from the command line whatever the mode.

## One credential per vendor, never one for all of them

**`secrets.env` holds a token per vendor, keyed by that vendor's
`authEnvVar`.** The storage key and the injected env var name are one string,
so a rename cannot store under one name and inject the other.

Store one with the vendor named:

```bash
pbpaste | chat-mcp auth set-token --vendor cursor
```

`--vendor` defaults to `claude`, so the existing command is unchanged.

🛑 **A SHARED TOKEN SENT A CLAUDE SUBSCRIPTION CREDENTIAL TO CURSOR.**
`dockerRunPlan` read one `readToken()` and injected it under whatever name the
vendor declared — the name changed per vendor and the value never did. #347.

⚠️ **Injecting the wrong token is worse than injecting none.** Measured on
#347: a `CURSOR_API_KEY` that Cursor cannot use **overrides a working login**
rather than filling a gap, and the container exits 1 before its first event.
So a spawn with no credential on file refuses, naming the vendor's env var and
how to obtain the key.

**`VendorSpawn.authSetupHint` carries that instruction**, because it is a
vendor's. A Cursor key comes from a web dashboard; a Claude token comes from
`claude setup-token`. One refusal message naming the wrong CLI sends the
operator to the wrong place.

## Adding a third vendor

1. A driver under `src/supervise/drivers/` — the only file naming that CLI's
   flags and event shapes.
2. A spawn block under `src/adapters/` declaring the three capability booleans,
   its `authEnvVar`, and the `authSetupHint` naming how to obtain that credential.
3. An `Adapter` carrying that spawn block, registered in `src/adapters/index.ts`.
4. A `cli-<vendor>` stage in `Dockerfile`, plus that vendor in
   `AGENT_VENDORS` — which is what makes every Dockerfile assertion run
   against the new image rather than only the two that already existed.
5. Two `ALIASES` entries — the vendor name, and `docker-<vendor>`.
6. **Re-point any negative control that asserts the vendor cannot be spawned.**
   Those tests assert a throw that stops happening the moment the vendor ships.
