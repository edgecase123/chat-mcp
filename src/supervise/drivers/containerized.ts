import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentChild, BusEndpoint, SpawnOptions } from '../child.js';
import type { VendorSpawn } from '../vendor.js';
import { wireAgentChild } from './wiring.js';
import { mountsFor, containerPathFor } from '../mounts.js';
import { GH_TOKEN_KEY, readGhToken, readToken } from '../auth.js';
import { assertProjectDirOutsideState, checkedMountPath } from '../containment.js';
import { assertHandle } from '../../util/naming.js';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';

export const CONTAINER_PROJECT_DIR = '/work';

/** Carries the whole MCP config, token included, so none of it is in argv. */
export const CONTAINER_MCP_CONFIG_ENV = 'CHAT_MCP_MCP_CONFIG';

/**
 * What `gh` reads to authenticate, so an agent can file a ticket or open a PR
 * (#214). `gh` picks this up with no `gh auth login`, which is what makes it
 * usable in a container — that flow wants a browser or a device code, the
 * same constraint as the Claude token.
 *
 * ⚠️ `git push` NEEDS MORE THAN THIS VAR. Plain git does not read `GH_TOKEN`;
 * it needs the credential helper that `gh auth setup-git` installs, and the
 * image configures that helper at build time. Raised in review, where this
 * comment claimed push worked on the var alone.
 *
 * 🛑 RE-EXPORTED, NOT REDECLARED. The storage key IS the env var name, and
 * `auth.ts` owns the file format.
 */
export const CONTAINER_GH_TOKEN_ENV = GH_TOKEN_KEY;

/**
 * 🛑 HOW A CONTAINER REACHES THE HOST, AND `127.0.0.1` IS NOT IT. The host's
 * loopback is the CONTAINER's loopback from in there, so the listener's own
 * `url` describes a bus the agent cannot reach. It would look configured and
 * connect to nothing.
 */
const HOST_FROM_CONTAINER = 'host.docker.internal';

/**
 * Seconds between `docker stop`'s SIGTERM and SIGKILL. Not a measured figure
 * — lee's chosen default (#149), raised from docker's own 10s default so a
 * session has time to externalize before being cut off. Per-handle
 * overridable via `SpawnOptions.shutdownGraceSeconds`.
 */
export const DEFAULT_SHUTDOWN_GRACE_SECONDS = 60;

export { containerPathFor };

/** Where the prelude writes the config, inside the container only. */
export function containerMcpConfigPath(vendor: VendorSpawn): string {
  return `${vendor.containerHome}/.chat-mcp-mcp.json`;
}

/** The listener's host-side url, as the container must dial it. */
export function containerBusUrl(hostUrl: string): string {
  const url = new URL(hostUrl);

  url.hostname = HOST_FROM_CONTAINER;

  return url.toString();
}

/**
 * The container's MCP config: an HTTP client of the host's listener.
 *
 * 🛑 NOT A COMMAND ANY MORE. This used to launch a stdio shim INSIDE the
 * container, which called `openDb()` and read `chat.db` across the mounted
 * state dir — so the container was a second process on the host's database
 * rather than a client of the host (#162).
 *
 * 🛑 THE TOKEN ONLY BECAME THE BOUNDARY WHEN THE MOUNT WENT WITH IT. While
 * `stateDir()` was mounted, `tokens/<handle>.json` was writable from inside,
 * and `authenticateToken` trusts the digest on disk — so a container could
 * forge ANY handle and reach the command broker as it. Deleting the transport
 * without deleting the mount would have left that live under a comment saying
 * it was closed.
 */
export function buildContainerMcpConfig(bus: BusEndpoint): string {
  const config = {
    mcpServers: {
      chat: {
        type: 'http',
        url: containerBusUrl(bus.url),
        headers: { Authorization: `Bearer ${bus.token}` },
      },
    },
  };

  return JSON.stringify(config);
}

/**
 * The shell prelude that materialises the config inside the container.
 *
 * 🛑 `exec "$@"` AND A `$0` PLACEHOLDER, NOT AN INTERPOLATED COMMAND. `sh -c
 * 'script' name args…` leaves every CLI argument a separate argv entry, so
 * nothing here re-quotes or re-splits them. Building one command string would
 * put the agent's own flags through a shell parse.
 *
 * `exec` also matters on its own: the supervisor drives the child over stdin,
 * and a forked `sh` sitting in the middle would own the pipe instead.
 */
function mcpConfigStep(vendor: VendorSpawn): string {
  const path = containerMcpConfigPath(vendor);

  // umask, because the file holds a bearer token for the whole bus.
  return `(umask 077; printf "%s" "$${CONTAINER_MCP_CONFIG_ENV}" > '${path}')`;
}

/**
 * 🛑 THE VOLUME COMES UP EMPTY, so without this the overlay only trades a
 * WRONG-platform `node_modules` for NO `node_modules`. The image has nothing
 * at `/work`, and docker seeds a volume from the image layer, never from the
 * bind under it — so there is no copy of the host's tree to inherit, which is
 * the whole point and also why something must install.
 *
 * ⚠️ GUARDED ON npm's OWN MARKER, not on the directory existing. The volume's
 * mount point exists from the moment docker creates it, so `[ -d ]` would read
 * every empty volume as populated and never install.
 */
function nodeModulesInstallStep(): string {
  return `[ -e '${CONTAINER_PROJECT_DIR}/node_modules/.package-lock.json' ] || npm ci`;
}

/**
 * The steps joined, then `exec "$@"` so the agent replaces this shell rather
 * than running under it.
 *
 * 🛑 `&&`, SO A FAILED STEP STOPS THE CHAIN. An install that half-finished and
 * then started the agent anyway is the case that produces a review claiming a
 * green suite it never ran.
 *
 * 🛑 EACH STEP IS PARENTHESISED, BECAUSE `&&` AND `||` BIND EQUALLY AND LEFT
 * TO RIGHT. Joined bare, `cfg && [ -e m ] || install` groups as
 * `((cfg && [ -e m ]) || install)` — so a FAILED `cfg` still reaches `exec`
 * whenever `install` succeeds, and the agent starts with no MCP config. The
 * group makes a step atomic whatever operators it contains.
 *
 * `exec "$@"` stays OUTSIDE a group: a subshell `exec` replaces the subshell
 * and leaves the real shell waiting on it, owning the stdin pipe the
 * supervisor drives the agent over.
 */
export function prelude(steps: string[]): string {
  return [...steps.map((step) => `( ${step} )`), 'exec "$@"'].join(' && ');
}

/**
 * The name `docker run --name` is given, so `kill()` has something to
 * address a `docker stop` to. One supervisor handle runs one container at a
 * time, so the handle alone is a stable, collision-free name.
 */
export function containerNameFor(supervisorHandle: string): string {
  return `chat-mcp-${supervisorHandle}`;
}

/**
 * The named volume carrying one handle's container-side `node_modules` for one
 * project tree.
 *
 * 🛑 KEYED ON BOTH, BECAUSE NEITHER ALONE IDENTIFIES A DEPENDENCY TREE.
 * `ProjectConfig.agents` maps a handle to a LIST of directories it may work
 * in, and `resolveCwd` accepts anything contained by one of them — so a handle
 * spans several trees, and a tree is reachable by several handles. Keyed on the
 * handle alone, the first tree to install wins and every later one imports its
 * dependencies forever, because the install guard sees a populated marker.
 *
 * ⚠️ `realpathSync`, so a symlinked checkout is the same tree and not a second
 * volume with a second install.
 *
 * ⚠️ Named rather than anonymous so it survives the `--rm`. Drop a stale one
 * with `docker volume rm $(chat-mcp` ... `)` — the name this function returns,
 * never a hand-spelled copy of the prefix.
 */
export function nodeModulesVolumeFor(supervisorHandle: string, projectDir: string): string {
  // 12 hex chars of sha256. Long enough that a collision is not a practical
  // concern, short enough that `docker volume ls` stays readable.
  const digest = createHash('sha256').update(realpathSync(projectDir)).digest('hex').slice(0, 12);

  return `chat-mcp-node-modules-${supervisorHandle}-${digest}`;
}

/** The one place that validates the field both `dockerRunPlan` and `spawnContainerized` need. */
function requireSupervisorHandle(opts: SpawnOptions): string {
  if (!opts.supervisorHandle) {
    throw new Error('a containerized spawn needs opts.supervisorHandle to find its mounts');
  }

  // 🛑 SHAPE, NOT JUST PRESENCE. The handle reaches the argv inside a `-v`
  // mount spec, where a colon separates source from destination — so an
  // unchecked one is a way to write a mount nobody declared. `--name` used to
  // be its only argv home, and the daemon vetted that itself.
  assertHandle(opts.supervisorHandle);

  return opts.supervisorHandle;
}

/**
 * The argv for `docker run`, plus the environment the docker CLIENT must be
 * spawned with.
 *
 * 🛑 THE TWO HALVES SHIP TOGETHER OR THE CONTAINER STARTS WITH NO CREDENTIAL.
 * `-e NAME` with no `=` tells docker to copy the value from its own
 * environment, so argv alone is not a runnable plan. An earlier
 * `dockerArgsForVendor` returned only the argv, and a caller keeping that
 * shape would drop the token in silence.
 */
export interface DockerRunPlan {
  readonly args: string[];
  readonly env: NodeJS.ProcessEnv;
}

export function dockerRunPlan(vendor: VendorSpawn, opts: SpawnOptions): DockerRunPlan {
  const token = readToken();
  // Optional, unlike the Claude token. Most handles need no GitHub access, and
  // one that does not must still be able to start.
  const ghToken = readGhToken();
  if (!token) {
    throw new Error(
      'no Claude OAuth token on file; run `claude setup-token` on the host, then ' +
        '`pbpaste | chat-mcp auth set-token` (stdin, never argv)',
    );
  }

  const supervisorHandle = requireSupervisorHandle(opts);
  const projectDir = opts.cwd;
  if (!projectDir) {
    throw new Error('a containerized spawn needs a resolved cwd');
  }

  // 🛑 CHECKED HERE AS WELL AS AT REGISTRATION. `projects.json` is a file on
  // disk, so a registration made before this guard existed is still live, and
  // `opts.cwd` can reach this from `resolveCwd` without passing
  // `registerProject` at all. The argv below is what mounts it.
  assertProjectDirOutsideState(projectDir);

  const args = [
    'run',
    '-i',
    '--rm',
    '--name',
    containerNameFor(supervisorHandle),
    // 🛑 BY NAME, NEVER `NAME=value`. The value in the argv is readable through
    // `ps` for the life of the container, which `AGENTS.md` forbids in those
    // words. Docker copies it from this process's environment instead.
    '-e',
    vendor.authEnvVar,
    '-v',
    `${projectDir}:${CONTAINER_PROJECT_DIR}`,
    // 🛑 A DOCKER VOLUME, SO NO HOST DIRECTORY IS BOUND HERE. `/work` carries
    // the host's macOS `node_modules`, and `esbuild` resolves a
    // platform-specific binary package, so a Linux container loading it dies
    // before the first test runs. The volume hides the host's copy from the
    // container without writing to it.
    //
    // Its argv position is incidental, per the measured note below: the daemon
    // sorts mount destinations, so this does not rely on being emitted here.
    '-v',
    `${nodeModulesVolumeFor(supervisorHandle, projectDir)}:${CONTAINER_PROJECT_DIR}/node_modules`,
  ];

  // 🛑 NAMED ONLY WHEN THERE IS ONE, because `-e NAME` with no `=` copies
  // whatever this process has — including nothing. An empty `GH_TOKEN` inside
  // the container reads to `gh` as a BAD credential rather than as no
  // credential, so the agent gets an auth error in place of the clear
  // "run `chat-mcp auth set-gh-token`" it should get.
  if (ghToken) args.push('-e', CONTAINER_GH_TOKEN_ENV);

  // 🛑 BOTH SIDES COME FROM ONE CHECKED VALUE. A host side built from the
  // realpath and a container side built from the raw declared string let a
  // symlink put one directory at two container paths, only one read-only.
  //
  // Order does not matter — measured both ways, the daemon sorts bind
  // destinations. ⚠️ Docker 24.0.7 / macOS, UNRUN ON LINUX.
  for (const entry of opts.readOnlyPaths ?? []) {
    const { host, inner } = checkedMountPath(projectDir, entry, 'read-only path');

    // 🛑 REFUSE RATHER THAN EMIT TWO SPECS FOR ONE DESTINATION. A declared
    // `node_modules` passes every containment check — it is relative,
    // colon-free, and inside the project — and then lands on the same
    // destination as the volume above. Docker refuses a duplicate destination,
    // so the symptom without this is a spawn that dies in the daemon with no
    // line connecting it to the manifest that caused it.
    const segment = inner.toLowerCase();

    if (segment === 'node_modules' || segment.startsWith('node_modules/')) {
      throw new Error(
        `read-only path '${entry}' collides with the container-owned node_modules volume ` +
          `at ${CONTAINER_PROJECT_DIR}/node_modules; the container installs its own, so it ` +
          'cannot also be mounted from the host',
      );
    }

    args.push('-v', `${host}:${CONTAINER_PROJECT_DIR}/${inner}:ro`);
  }

  // 🛑 AN EXTRA MOUNT CARRIES NO `:ro`, so it is the project-tree hole through a
  // different door. Re-checked here because `mounts.json` outlives the guard in
  // `registerMount`.
  for (const [key, hostDir] of Object.entries(mountsFor(supervisorHandle))) {
    assertProjectDirOutsideState(hostDir);
    args.push('-v', `${hostDir}:${containerPathFor(key)}`);
  }

  const env: NodeJS.ProcessEnv = { ...process.env, [vendor.authEnvVar]: token };

  // 🛑 DELETED, NOT MERELY LEFT UNSET. This inherits `process.env`, so a
  // `GH_TOKEN` exported in the supervisor's own shell would sit in the docker
  // CLIENT's environment while the argv above declines to name it. Nothing
  // reaches the container either way, but the plan would then describe a
  // credential the file never granted, and whether a spawn carried one would
  // depend on the operator's shell.
  if (ghToken) env[CONTAINER_GH_TOKEN_ENV] = ghToken;
  else delete env[CONTAINER_GH_TOKEN_ENV];

  if (opts.grant) args.push('-e', CONTAINER_MCP_CONFIG_ENV);

  args.push('-w', CONTAINER_PROJECT_DIR, vendor.image);

  const cli = [opts.binary ?? vendor.binary, ...vendor.argsFor(opts, 'docker')];

  // 🛑 ON BOTH BRANCHES, NOT JUST THE GRANTED ONE. Only a granted spawn used
  // to need a shell at all, so an install added to that branch alone would be
  // present in every granted test and missing from every plain one.
  if (!opts.grant) {
    args.push('sh', '-c', prelude([nodeModulesInstallStep()]), 'sh', ...cli);

    return { args, env };
  }

  // 🛑 REFUSE RATHER THAN START BLIND. A granted child with no bus endpoint
  // would come up with an MCP config pointing nowhere, and the only symptom is
  // an agent that answers nothing.
  if (!opts.bus) {
    throw new Error('a containerized spawn with a grant needs opts.bus to reach the host bus');
  }

  cli.push('--mcp-config', vendor.mcpConfigFor(opts.grant, 'docker'), '--strict-mcp-config');

  env[CONTAINER_MCP_CONFIG_ENV] = buildContainerMcpConfig(opts.bus);

  // Config first, because it is instant and the install is not. A spawn that
  // dies in `npm ci` then still leaves the config written for the retry.
  args.push('sh', '-c', prelude([mcpConfigStep(vendor), nodeModulesInstallStep()]), 'sh', ...cli);

  return { args, env };
}

/**
 * `kill()`'s `stop` override for a container by name.
 *
 * Exported so `container-removal.test.ts` can exercise this exact closure
 * instead of a hand-written copy — a copy proves `docker stop` works, not
 * that `spawnContainerized` is wired to call it (claude2, PR #147 review).
 */
export function dockerStopFor(
  name: string,
  graceSeconds: number = DEFAULT_SHUTDOWN_GRACE_SECONDS,
): () => void {
  return () => {
    // 🛑 DETACHED, NOT `execFileSync`. PID 1 in a container ignores SIGTERM,
    // so `docker stop` always waits out its full `-t` — 60s by default. Doing
    // that synchronously froze the whole supervisor for that minute: no
    // logging, no socket handling, and a second Ctrl-C did nothing. The
    // daemon owns the teardown, so this process does not need to watch it.
    const stopper = spawn('docker', ['stop', '-t', String(graceSeconds), name], {
      stdio: 'ignore',
      detached: true,
    });
    // An unhandled 'error' event on a child process is an uncaught exception,
    // so this handler is load-bearing rather than defensive. `kill()` is
    // best-effort by contract, and there is no logger at this layer.
    stopper.on('error', () => undefined);
    stopper.unref();
  };
}

/**
 * `awaitTeardown()` for a container by name: resolve once it is gone.
 *
 * 🛑 `docker wait` IS THE WRONG TOOL. It resolves on the container EXITING,
 * and a `--rm` container is removed a moment later — so a restart in that
 * window still meets `Conflict. The container name is already in use`. This
 * polls for the NAME being free, which is the condition the next spawn needs.
 *
 * Resolves rather than throwing on timeout. A stop that cannot confirm is
 * still a stop, and the caller prints what it was able to observe.
 */
export function dockerTeardownFor(
  name: string,
  graceSeconds: number = DEFAULT_SHUTDOWN_GRACE_SECONDS,
): () => Promise<void> {
  const POLL_MS = 250;

  return async () => {
    // One grace period plus a margin for the daemon's own removal step.
    const deadline = Date.now() + graceSeconds * 1000 + 5_000;

    while (Date.now() < deadline) {
      let present = false;
      try {
        const out = execFileSync('docker', ['ps', '-aq', '--filter', `name=^${name}$`], {
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        present = out.toString().trim().length > 0;
      } catch {
        // No daemon, or docker gone. Nothing left to wait for.
        return;
      }

      if (!present) return;

      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  };
}

/**
 * Spawn a vendor's CLI inside `docker run`.
 *
 * 🛑 ONE `docker run` PROCESS, DRIVEN OVER STDIN AND STDOUT. No `docker exec`,
 * ever — decision 8 of the #129 spec. Removal on kill is proved by
 * `container-removal.test.ts`, not just asserted here.
 */
export function spawnContainerized(vendor: VendorSpawn, opts: SpawnOptions = {}): AgentChild {
  const name = containerNameFor(requireSupervisorHandle(opts));

  // 🛑 BUILD THE PLAN BEFORE THE REMOVAL BELOW, BECAUSE THE REMOVAL IS
  // DESTRUCTIVE AND THIS THROWS. A missing token, an unresolved cwd, a
  // containment violation or a missing bus endpoint all raise here — and
  // running `docker rm -f` first meant a spawn that could never succeed
  // SIGKILLed the live agent on its way to the error. `dockerRunPlan` is pure.
  const plan = dockerRunPlan(vendor, opts);

  // 🛑 CLEAR THE NAME FIRST, SYNCHRONOUSLY. The name is fixed per handle, and
  // `kill()` no longer waits for the teardown — so restarting a handle inside
  // the grace window meets `Conflict. The container name is already in use`
  // (claude2, PR #153 re-review). `-f` SIGKILLs rather than waiting out a
  // grace period, so this is short even against a container mid-stop, and it
  // also clears the stale container a crashed supervisor leaves behind.
  //
  // Only ever this handle's own container. `startSupervisor` refuses a second
  // supervisor for a live handle as its first statement, before anything
  // spawns, proved by `second-supervisor-refused.test.ts` asserting the spawn
  // count stays at 1. So there is no rival agent for this to take down.
  try {
    execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  } catch {
    // Nothing by that name — the normal case, and not distinguishable from a
    // missing docker without a logger at this layer.
  }

  const child: ChildProcessWithoutNullStreams = spawn('docker', plan.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: plan.env,
  }) as ChildProcessWithoutNullStreams;

  const graceSeconds = opts.shutdownGraceSeconds ?? DEFAULT_SHUTDOWN_GRACE_SECONDS;

  return wireAgentChild(child, vendor, {
    stop: dockerStopFor(name, graceSeconds),
    teardown: dockerTeardownFor(name, graceSeconds),
  });
}
