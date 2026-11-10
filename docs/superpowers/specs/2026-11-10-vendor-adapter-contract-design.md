# Vendor adapter contract — design (#131)

## The problem

`src/adapters/` abstracts per-vendor differences for wake hooks only. It has no
contract for how to spawn and sandbox a vendor's CLI. So adding Cursor means a
branch in spawn code rather than a new file.

Two registries exist today, and they are keyed on different axes.

```
src/adapters/            Adapter {name, description, scopes, defaultScope, install, uninstall}
                         entries: claude-code, claude-code-context   <- keyed by HOOK

src/supervise/drivers/   Driver {spawn, redispatchPrompt}
                         entries: claude, docker-claude              <- keyed by VENDOR x SANDBOX
```

Both hold two entries for one vendor, for unrelated reasons. Merging them
naively produces a cartesian product: adding Cursor would mean `cursor` plus
`docker-cursor`, and the pairing has to be remembered by hand at every call
site.

## Decisions

### One interface, not two — lee, 2026-11-09

> *"For 131, there want both the the wake interface and the new adapter
> interface should be the same if possible so that both can be treated
> interchangeably."*

### Container-ness is a modifier, not a vendor — lee, 2026-11-10

`docker-claude` stops being a sibling of `claude` in the registry. The registry
holds vendors. Sandbox mode is a separate axis.

This supersedes the header comment in `docker-claude.ts` reading "A SECOND
DRIVER of drivers/claude.ts, NOT A FLAG ON IT". That comment cited decision 8
of the #129 spec, which forbids `docker exec`. Decision 8 still binds: the
generic container spawner drives one `docker run` process over stdin and
stdout, and never execs into a running container.

### Three PRs, not one — lee, 2026-11-10

PR 3 touches the spawn path #129 shipped the same day, so it is reviewed on its
own rather than buried under an interface change.

## The interface

`spawn` is optional, which is what lets one interface serve both kinds of
consumer. A wake-only adapter supplies nothing extra. A spawn consumer never
reads hook fields.

```ts
export interface Adapter {
  name: string;          // 'claude-code-context'  user-facing, UNCHANGED
  vendor: string;        // 'claude'               NEW
  description: string;
  scopes: readonly string[];
  defaultScope: string;
  install(opts: AdapterInstallOptions): Promise<AdapterResult>;
  uninstall(opts: AdapterInstallOptions): Promise<AdapterResult>;
  spawn?: VendorSpawn;   //                        NEW
}

export type SandboxMode = 'host' | 'docker';

export interface VendorSpawn {
  readonly binary: string;        // 'claude'
  readonly image: string;         // this vendor's container image tag
  readonly containerHome: string; // '/root' — what makes the state dir resolve
  readonly authEnvVar: string;    // 'CLAUDE_CODE_OAUTH_TOKEN'

  readonly argsFor: (opts: SpawnOptions, mode: SandboxMode) => string[];
  /** The config path to point the CLI at, written first if the mode needs it. */
  readonly mcpConfigFor: (grant: ChildGrant, mode: SandboxMode) => string;
  readonly routeEvent: EventRouter;
  readonly encodeInput: (text: string) => string;
  readonly redispatchPrompt: (input: RedispatchInput) => string;
}
```

### Why `vendor` is needed

`claude-code` and `claude-code-context` are both Claude Code. They differ only
in which hook they install. Without `vendor` there is no way to say which
adapter's spawn config a vendor uses.

The two are NOT merged. `claude-code-context` is a published install name in
the README, so merging them would break the CLI for anyone following the docs.
Instead, at most one adapter per vendor carries `spawn`, and a guard test
asserts that.

### Why `argsFor` takes a mode

The host and container flag sets are mutually exclusive, by decision 4 of the
#129 spec.

```
host      --permission-mode <x> --allowedTools <y>
docker    --allow-dangerously-skip-permissions
```

A static array cannot express that. A vendor owns both sets and picks by mode,
which keeps decision 4 inside the file whose flags it names.

### Three fields that exist because a second vendor would break on them

| field | what is wrong today |
|---|---|
| `image` | `IMAGE_TAG` is one constant, and `container.ts` keeps one `builtHash` |
| `containerHome` | `CONTAINER_STATE_DIR = '/root/.chat-mcp'` works only because the image's `HOME` is `/root`. A vendor image with a different `HOME` breaks the bus silently. |
| `authEnvVar` | the env var name is written inline in `dockerArgsFor` |

## File layout

```
src/adapters/types.ts              Adapter + VendorSpawn + SandboxMode
src/adapters/claude-spawn.ts       NEW  the VendorSpawn for claude
src/adapters/claude-code.ts        + vendor, + spawn
src/supervise/drivers/wiring.ts    NEW  the duplicated child wiring, once
src/supervise/drivers/host.ts           generic, was claude.ts
src/supervise/drivers/containerized.ts  generic, was docker-claude.ts
```

`wiring.ts` exists because `docker-claude.ts` duplicates `claude.ts`'s child
wiring almost verbatim — event callbacks, the line parser, `onTurnEnd` /
`onUsage` / `onDenial` / `onSession` / `onEvent` / `onExit`. Measured over
`docker-claude.ts:110-179` against `claude.ts:240-326`, ignoring blank lines
and indentation: 60 of the container driver's 65 lines are identical to the
host driver's, which is 92% of that block. That
duplication is the cartesian product showing up as code. Extracting it is what
makes a third vendor one file instead of a third copy.

## CLI compatibility

Every published invocation keeps working, because `--driver` values become
aliases over a (vendor, mode) pair.

| invocation | resolves to |
|---|---|
| `--driver claude` | vendor `claude`, mode `host` |
| `--driver docker-claude` | vendor `claude`, mode `docker` |
| `--container`, no `--driver` | vendor `claude`, mode `docker` |
| `--driver cursor` | vendor `cursor`, mode `host` |
| `--driver cursor --container` | vendor `cursor`, mode `docker` |

`--driver` keeps its no-default behaviour. The existing comment in `index.ts`
explains why a static default erases "the caller never named a driver", which
is what made `--container` alone spawn on the host during the #129 smoke test.

### This retires the `requiresContainer` finding

Both #137 reviewers flagged that the confirm gate reads
`opts.container || opts.driver === 'docker-claude'`, a hardcoded string a second
container vendor would silently skip. Under this design the gate reads
`mode === 'docker'`, so no vendor can skip it by being spelled differently. No
`requiresContainer` field is needed.

## Staging

| PR | content | risk |
|---|---|---|
| 1 | the interface, `claude-spawn.ts`, guard test. No behaviour change. | low |
| 2 | extract the duplicated child wiring into `wiring.ts` | low, pure move |
| 3 | collapse the two drivers into `host.ts` + `containerized.ts`, alias resolution | can break spawning |

## Testing

- **Guard test, PR 1.** No vendor has two adapters carrying `spawn`. Fails if a
  second `spawn`-carrying adapter is added for an existing vendor.
- **Guard test, PR 1.** Every adapter declares a `vendor`.
- **Equivalence tests, PR 3.** For each alias in the table above, the resolved
  argv matches what today's `dockerArgsFor` and the host driver produce. These
  are the tests that make PR 3 safe, because they compare against current
  behaviour rather than against the new code's own idea of correct.
- **Gate test, PR 3.** A `mode === 'docker'` spawn with no confirmed token
  refuses, reached through a vendor name that is not `docker-claude`. The
  existing test cannot distinguish the gate from `dockerArgsFor` throwing the
  same message, so this one selects the path by mode.

## What is NOT proven

- **Container removal still has no automated test.** `kill()` terminates the
  `docker run` process, proved in #139. That `--rm` then removes the container
  has only ever been shown by a manual run against real Docker. `kill()` moves
  into `containerized.ts` in PR 3, and the removal proof belongs there.
- **Cursor's credential path and `HOME`** are unverified. No Cursor adapter
  ships here. The contract is designed so that getting them wrong is a one-file
  fix rather than a spawn-path change.

## Out of scope

- Writing a Cursor adapter. #131 is the contract; Cursor is a later ticket.
- Per-vendor image build state in `container.ts`. PR 1 adds the `image` field;
  making `builtHash` per-vendor is only needed when a second vendor exists.
