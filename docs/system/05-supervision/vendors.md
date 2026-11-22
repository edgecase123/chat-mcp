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

## How a host grant is delivered is DECLARED, never inferred

`VendorSpawn.hostGrantDelivery` is one of `"flags"`, `"file"` or `"none"`, and
`assertHostGrantReachesBus` refuses a GRANTED host child whose vendor says
`"none"`.

| vendor | value     | why                                                         |
| ------ | --------- | ----------------------------------------------------------- |
| claude | `"flags"` | `claudeArgs` names `--mcp-config` and `--strict-mcp-config` |
| cursor | `"file"`  | no flag exists, so `<cwd>/.cursor/mcp.json` IS the wiring   |

🛑 **`"file"` IS NOT SELF-ENFORCING, AND THE GUARD ALONE DOES NOT COVER IT.**
`assertHostGrantReachesBus` admits `"file"` by NOT being `"none"`, so flipping
the field and forgetting the writer would stop the refusal and restore the
silence it was added for. Two things close that:

1. **`hostGrantConfigPath` is required in practice whenever the value is
   `"file"`.** `hostGrantConfigPathFor` throws when the pair disagrees, because
   the type system cannot — `tsconfig.json` includes `src/**` only.
2. **`host-grant-delivered-on-spawn.test.ts` asserts the FILE LANDS**, driven
   through `spawnOnHost` with `node:child_process` mocked. Asserting the writer
   directly was not enough: deleting its call site from `spawnOnHost` left all
   19 of the writer's own tests green.

🛑 **BOTH WAYS OF INFERRING THIS WERE PROPOSED AND BOTH ARE MEASURABLY
WRONG.** They are recorded because each looks correct until measured.

1. **`mcpConfigFlags` being empty does NOT mean "no route".** Cursor returns
   `[]` from it and reaches the bus in a container through a written file. The
   host path never calls it at all — one call site in `src/`, in
   `containerized.ts`.
2. **Argv identity between a granted and an ungranted child does NOT mean "no
   route" either.** A route delivered by WRITING a config file changes no argv,
   so the inference would refuse the very thing that works.

⚠️ **A POSITIVE DECLARATION CANNOT BE SATISFIED BY ACCIDENT, and that is the
whole reason for the field.** `host-grant-reaches-bus.test.ts` pins each value
against the argv, so a vendor declaring `"flags"` while ignoring the grant
fails rather than silently never triggering the refusal.

## A vendor reports its OWN tool calls, because the shapes are not alike

`EventRouter` carries `toolCall?(name: string | null)`. The supervisor turns
that into `turn.sent` for the silent-reply detector, and into nothing else.

| vendor | a tool call arrives as                                        |
| ------ | ------------------------------------------------------------- |
| claude | a `tool_use` BLOCK inside an `assistant` message's `content`  |
| cursor | a TOP-LEVEL `tool_call` event, `subtype` started or completed |

🛑 **THE DETECTOR USED TO SNIFF FOR THE CLAUDE SHAPE ITSELF**, one layer above
the drivers, so it was blind to Cursor and every Cursor turn that sent was
reported as having answered nobody. #392.

**Cursor's shape, read out of the shipped bundle at 2026.11.19-f005e9d:**

```
type:"tool_call",subtype:"started",call_id:…,tool_call:…,session_id:…
```

🛑 **THE EVENT KEYS ARE HAND-WRITTEN snake_case AND THE NESTED VALUE IS NOT.**
The writer passes `tool_call: n.message.value.toolCall`, a raw internal object,
so the keys under it are camelCase. `mcp_tool_call` appears in that bundle
twice and both are protobuf schema strings.

🛑 **THE CALL IS NAMED FROM ITS VARIANT KEY, NOT FROM ITS CONTENTS.**
`tool_call` is a oneof whose variants are each `*_tool_call`, and 49 distinct
camelCase `*ToolCall` keys appear in the bundle. Exactly one such key
identifies the call even when the inside surprises us.

| the `tool_call` object has           | the name is    |
| ------------------------------------ | -------------- |
| exactly one `*ToolCall` key          | that key       |
| `mcpToolCall` with a `toolName`      | the `toolName` |
| `mcpToolCall` with no `toolName`     | `null`         |
| no `*ToolCall` key, or more than one | `null`         |

⚠️ **A `kind` FALLBACK WAS TRIED AND IT DEFEATED THE GUARD.** Every sampled
`toolCall` object carries a `kind`, so an unrecognised shape was named
`"other"` — not null, no signal — and a bus `send` under a wrong path would
have produced the same false warning as #392 with nothing reporting it.

⚠️ **AN MCP CALL THAT CANNOT BE NAMED REPORTS `null`, NEVER ITS KEY.**
`mcpToolCall` is the only variant a bus `send` arrives under, so naming it
`"mcpToolCall"` would assert "a tool ran and it was not a send" — the one claim
that must never rest on a guess.

⚠️ **THAT NESTING IS READ OFF A BUNDLE, NOT OFF A CAPTURED EVENT.** So an
unreadable shape reports `null` rather than being skipped, and the supervisor
logs it — a wrong field path would otherwise reproduce #392 exactly.

⚠️ **BOTH SUBTYPES ARE EMITTED FOR ONE CALL.** `turn.sent` only moves to true,
so this costs nothing today; a future COUNT of them would double.

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

| mode     | where the config goes          | why                                         |
| -------- | ------------------------------ | ------------------------------------------- |
| `docker` | `/root/.cursor/mcp.json`       | the image has no operator config to clobber |
| host     | `<child cwd>/.cursor/mcp.json` | the only location this CLI reads            |

🛑 **A GRANTED HOST CURSOR CHILD IS NOW WIRED, NOT REFUSED.** lee approved
writing the project-local file on 2026-11-21, bounded: _"as long as it cannot
be used to run unauthorized paths or bypass gates and gaurds"_. It previously
started, took its prompt and answered nothing, because the config went to
`grant.configPath` and was never named — #219's shape, and #348.

⚠️ **THE WRITER REFUSES AN EXISTING FILE RATHER THAN OVERWRITING IT.** That
file is the operator's own MCP configuration and this project may destroy it
exactly never. `wx` backs the readable `existsSync` check, so two supervisors
in one project directory cannot race past it.

🛑 **RE-DELIVERING THE IDENTICAL FILE IS A NO-OP, NOT A REFUSAL.** Nothing
deletes this file, so a blanket refusal meant a granted handle started exactly
ONCE per project directory, and the second start blamed the operator for a file
the supervisor itself had written. The content is fully determined by the
handle, so "is this already ours?" is answerable exactly.

| `<cwd>/.cursor/mcp.json` is… | result            |
| ---------------------------- | ----------------- |
| absent                       | written           |
| byte-identical to ours       | left alone, no-op |
| anything else                | refused           |

⚠️ **THE REFUSAL CLAIMS NO AUTHOR.** It used to say "the supervisor did not
create it", which is false whenever an older build of this project wrote it.
It now names the file and the handle and says what to do.

**The bound is enforced as tests, not as a comment.** The written file declares
exactly one server named `chat`, and its `command` is this process's own
interpreter running this build's own entry point — so the file cannot name a
path the supervisor is not already running. The handle is validated here rather
than borrowed from the state-dir writer's call path, and the file is 0600.

🛑 **A SUPERVISED PROJECT IS NOT TRUSTED INPUT, AND `wx` ALONE DOES NOT MAKE IT
SAFE.** `O_CREAT|O_EXCL` refuses to follow a symlink planted at `mcp.json`, and
does nothing about `.cursor` itself being one: `mkdirSync({recursive:true})`
no-ops on the resolved directory, `wx` succeeds, and the config lands in the
link's TARGET. Measured — `.cursor -> /tmp/elsewhere` put the file at
`/tmp/elsewhere/mcp.json`.

🛑 **THE CHECK WALKS UP TO THE NEAREST EXISTING ANCESTOR.** Returning early
when the config directory was absent left the escape open: `mkdirSync` with
`recursive` FOLLOWS a symlinked ancestor and creates the leaf outside it.

**So the writer refuses a symlinked config directory, using `realContains` from
`containment.ts`** — the same `realpathSync` discipline the manifest script
path uses, and for the same reason: `resolve` is lexical and cannot see a
symlink.

| `<cwd>/.cursor` is…                     | result  |
| --------------------------------------- | ------- |
| absent                                  | created |
| a real directory                        | used    |
| a symlink OUT of the project            | refused |
| a symlink back INSIDE it                | refused |
| reached through an intermediate symlink | refused |
| ABSENT, under a symlinked ancestor      | refused |

⚠️ **A symlinked CWD is legitimate and stays allowed.** macOS `/tmp` is one.
Containment is judged on real paths rather than by banning them.

🛑 **THE CWD FALLBACK IS `process.cwd()`, SO A SUPERVISOR WITH NO EXPLICIT
`cwd` WRITES INTO ITS OWN DIRECTORY.** That is correct — the child runs there
too — but in a git checkout it shows up as an untracked `.cursor/`. `.gitignore`
carries it for that reason.

**An UNGRANTED host Cursor child still works, and no file is written for it.**
A config planted for a child that was promised no bus is litter in the
operator's project.

🛑 **THE OLD CLAIM THAT ONLY `~/.cursor/mcp.json` COULD WIRE A HOST CHILD IS
WRONG, and it was wrong when it was written here.** Measured on #348 against
`cursor-agent 2026.11.19-f005e9d`, with an empty-cwd control:

| cwd                        | `cursor-agent mcp list`                          |
| -------------------------- | ------------------------------------------------ |
| no `.cursor/mcp.json`      | `No MCP servers configured`                      |
| `.cursor/mcp.json` present | the server is named, `needs approval`            |
| plus its approval on file  | `chat: ready`, and `list-tools` returns 24 tools |

🛑 **THAT THIRD ROW WAS DOCUMENTED AND NEVER IMPLEMENTED, AND #348 SHIPPED IN
THE SECOND ROW.** The table above is from slice 2; the supervisor wrote the
config and performed no approval, so a granted host Cursor child started with
`chat: not loaded (needs approval)` and no bus tools at all. See the approval
section below. The row count moved from 22 tools to 24 between
2026-11-21 and 2026-11-22 — the shim gained tools, nothing here changed.

**A project-local `.cursor/mcp.json` is read, and the human's home config is
never touched.** lee answered the question this paragraph used to leave open:
the supervisor may create that file, and refuses rather than overwriting one it
did not create.

🛑 **`VendorSpawn.containerMcpConfigPath` is REQUIRED and per-vendor.** It was
one `${containerHome}/.chat-mcp-mcp.json` for every vendor, which works only
for a CLI that can be POINTED at a path. Claude Code can be; Cursor cannot. So
the file landed where Cursor never looks, and its contained agent reached the
bus never while reporting a clean start — #372.

🛑 **The prelude `mkdir -p`s the directory before writing.** The Cursor image
has no `/root/.cursor`, and `prelude` chains on `&&`, so a failed redirect
means `exec "$@"` never runs and no agent starts at all.

🟢 **PROVEN LIVE on 2026-11-21: a contained Cursor agent completes a turn and
reaches the bus.** `scripts/cursor-container-acceptance.mjs` sent a prompt and
the agent's `send` arrived, so **closing the per-turn child's stdin IS
sufficient** for a turn to end.

🟢 **AND `--resume` REACHES THE SAME SESSION.**
`scripts/cursor-container-resume-acceptance.mjs` plants a nonce on turn one and
asks for it back on turn two. **The nonce is never in turn two's prompt, and the
script asserts that absence** — a fresh session cannot produce the word, so
recall is the proof. The session store therefore survives inside the container.

⚠️ **Both scripts spend real money and need `CHAT_MCP_LIVE=1`.** They are
acceptance checks, never suite tests, so nothing in `npm test` needs docker or
a credential.

## 🛑 The config makes the server SEEN. The APPROVAL makes it LOADED.

🛑 **WRITING `.cursor/mcp.json` IS NOT WIRING THE BUS, AND BELIEVING IT WAS
COST #348 A WHOLE SLICE.** Measured against `cursor-agent 2026.11.19-f005e9d`
in a temp cwd holding only the config this project writes:

| step                  | result                               |
| --------------------- | ------------------------------------ |
| our config written    | `chat: not loaded (needs approval)`  |
| `mcp list-tools chat` | refused, `has not been approved`     |
| `mcp enable chat`     | `chat: ready`, `list-tools` gives 24 |

**So `spawnOnHost` runs the vendor's own approval subcommand after writing the
file.** The vendor names it through `VendorSpawn.hostGrantApproveArgs`, and the
driver owns the execution, the cwd and the refusal.

🛑 **IT RUNS IN THE CHILD'S CWD, BECAUSE THE APPROVAL IS PER PROJECT.** Cursor
records it at `~/.cursor/projects/<slug>/mcp-approvals.json`, and **the slug is
built from that directory's REAL path** — a `/var/...` cwd lands under
`private-var-...` on macOS. An approval run in the supervisor's own directory
approves a different project and leaves the child deaf.

🛑 **THE RECORD IS CURSOR'S INTERNAL SHAPE, SO WE DO NOT WRITE IT.** It is
`["chat-<16 hex>"]`, where the suffix hashes the server's command+args. Writing
that file directly means re-implementing a hash this project does not own, which
is why the fix is the documented `mcp enable` subcommand.

🛑 **A FAILED APPROVAL THROWS AND FAILS THE SPAWN.** A warning would leave a
child running with no `send`, which is indistinguishable from #348's silence and
from a model that chose not to answer. The spawn is the last moment it is
detectable.

⚠️ **A VENDOR THAT DECLARES NO APPROVAL STEP IS A REAL ANSWER.** Claude's grant
arrives by flags and is live at startup, and `claude` has no `mcp enable`
subcommand — approving unconditionally would break the vendor that worked.

⚠️ **STILL UNPROVEN: THAT THE HOST PATH PRODUCES A WORKING TURN.** The config
lands, the approval runs, and `mcp list` / `mcp list-tools` were measured
directly against the live binary — but no live host Cursor TURN has completed.
The two acceptance scripts above cover the CONTAINER only. **`mcp list` is free;
a turn is not**, which is why the cheap half is measured and the expensive half
is still open.

🛑 **ONE REASON IT COULD NOT HAVE WORKED IS NOW KNOWN AND FIXED: the child was
never handed its API key.** #396, found by the paid host run on 2026-11-22 —
8 of 9 checks passed and the 9th was the turn. See _The HOST child gets the same
injection_ above. **A turn is still unmeasured, so this closes a cause and not
the question.**

## `--binary` is a HOST flag, and a container refuses it

🛑 **`SpawnOptions.binary` is one string for two filesystems.** A host path
exec'd inside Linux exits 127, and the supervisor reports that as a dead agent
rather than as a missing CLI — the operator is never told their own flag named
the cause. lee ruled "refuse on both" for this and #368, 2026-11-21.

```
--binary <path> --driver docker-cursor   ->  REFUSED at plan time
--binary <path> --driver cursor          ->  honoured, host filesystem
no --binary     --driver docker-cursor   ->  vendor.containerBinary
```

⚠️ **The refusal carries the vendor's `containerBinary`**, because a path
inside an image the operator cannot list is not guessable.

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

🛑 **`prepareAgentImage` BUILDS A VENDOR'S IMAGE AND SKIPS A STRANGER'S, AND THE
TELL IS WHETHER A VENDOR WAS NAMED.** It used to skip every tag that was not
`IMAGE_TAG`, so a Cursor handle was told its own image was somebody else's and
no build ever ran. The container then came up on whatever had been built by
hand, exec'd a module the image did not contain, and exited 1 with no prompt
sent — which reads as a dead agent rather than a missing build.

⚠️ **An operator override image is STILL skipped**, which is lee's ruling of
2026-11-15. The caller names a vendor only when the plan's image is that
vendor's own.

🛑 **THE FRESHNESS HASH IS KEYED BY IMAGE.** One `builtHash` for the whole file
is satisfied by whichever image was built last, so building either one marked
BOTH current and the second vendor's image was then never rebuilt again. The
pre-existing single key is folded into the map under the Claude tag, so no
install rebuilds once for nothing.

⚠️ **`vendor` IS the `AGENT_VENDOR` value, not a second spelling of it.** The
Dockerfile's `cli-*` stages are pinned against `vendorsWithSpawn()`, so a
vendor's own name already selects its stage.

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

### The HOST child gets the same injection, and it did not for a whole slice

🛑 **A HOST CHILD WAS NEVER GIVEN ITS KEY, SO EVERY TURN WAS LOST AND THE START
LOOKED CLEAN.** `spawnOnHost` passed `cwd` and `stdio` to `spawn` and no `env`,
so the child inherited a `process.env` the token has never been in. The store
is a file under the state dir. #396.

```
← child stderr: Error: Authentication required. Please run 'agent login'
                first, or set CURSOR_API_KEY environment variable.
  child exited code=1 signal=null; 0 prompt(s) never sent
```

| path      | how the credential arrives                                      |
| --------- | --------------------------------------------------------------- |
| container | `-e NAME` on the `docker run` argv, value from the client's env |
| host      | `env` on the `spawn` call, one key, the vendor's own            |

🛑 **IN THE CHILD'S ENVIRONMENT, NEVER IN ARGV.** `ps` exposes an argv for the
life of the process, which `AGENTS.md` forbids for a secret. Ruled by lee
2026-11-22.

🛑 **AND NEVER WRITTEN INTO `process.env`.** That would reach every later child
of every vendor, which is #347 arriving by a second route.

🛑 **A CHILD WITH NO TOKEN ON FILE IS REFUSED AT SPAWN, NOT ALLOWED TO START
AND EXIT 1.** Ruled by lee 2026-11-22. The prompt is lost either way, and only
the refusal names the cause — a clean start that answers nothing is
indistinguishable from #348 and from a model that chose not to reply.

⚠️ **THE CHECK RUNS BEFORE THE GRANT FILE IS WRITTEN.** A refusal that came
after it would leave `.cursor/mcp.json` in the operator's own project directory
for a child that never ran.

⚠️ **THE APPROVAL EXEC IS HANDED NO CREDENTIAL, AND THAT IS A DECISION.**
`cursor-agent mcp enable` needs none, measured, so least privilege applies. A
test asserts the absence, so a later change cannot widen it silently.

🛑 **"A REAL KEY IS ON FILE" IS NOT EVIDENCE THE CHILD HAS ONE.** The host
acceptance script's first check passed throughout the window this bug was open.
On file is not in the child's environment, which is why the test asserts the
`env` that `spawn` RECEIVES.

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
