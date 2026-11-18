import {
  execFileSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import type { AgentChild, BusEndpoint, SpawnOptions } from "../child.js";
import type { VendorSpawn } from "../vendor.js";
import { wireAgentChild } from "./wiring.js";
import { mountsFor, containerPathFor } from "../mounts.js";
import { GH_TOKEN_KEY, readGhToken, readToken } from "../auth.js";
import {
  assertProjectDirOutsideState,
  checkedMountPath,
} from "../containment.js";
import { assertHandle } from "../../util/naming.js";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

export const CONTAINER_PROJECT_DIR = "/work";

/**
 * The project-relative directory the container owns rather than reads from the
 * bind. One spelling, because the volume destination, the install guard, the
 * collision refusal and the Dockerfile's pre-created mount point must agree.
 */
export const CONTAINER_NODE_MODULES_DIR = "node_modules";

/** Carries the whole MCP config, token included, so none of it is in argv. */
export const CONTAINER_MCP_CONFIG_ENV = "CHAT_MCP_MCP_CONFIG";

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
const HOST_FROM_CONTAINER = "host.docker.internal";

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
        type: "http",
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
 * Every credential `dockerRunPlan` may name with `-e`, in ONE place.
 *
 * 🛑 THE `-e` PUSHES AND `dockerInstallPlan`'s REMOVALS BOTH DERIVE FROM THIS.
 * A fourth credential added to the agent's argv must become a fourth thing the
 * install container is denied, in the same edit — and two hand-kept lists that
 * merely coincided is how the old scrub rotted. Pinned by "the install
 * container is handed NO credential at all".
 */
export function containerCredentialEnvVars(
  vendor: VendorSpawn,
): readonly string[] {
  return [vendor.authEnvVar, CONTAINER_GH_TOKEN_ENV, CONTAINER_MCP_CONFIG_ENV];
}

/**
 * What the prelude writes to stderr when the lockfile hash comes back empty.
 *
 * 🛑 IT NAMES THE CONDITION, NOT ONE CAUSE OF IT. A first cut said "shasum is
 * missing" and hung off `command -v shasum`, which tests RESOLUTION. The
 * defect #234 reports is an EMPTY HASH, and a `shasum` that resolves but
 * cannot execute produces one while passing `command -v` — so the warning was
 * silent in a case it exists for. Found by claude2 on PR 241.
 *
 * 🛑 EXPORTED SO THE SUITE HAS NO SECOND LITERAL. A test matching its own copy
 * of this sentence passes while the prelude says something else entirely.
 */
export const NO_LOCK_HASH_WARNING =
  "chat-mcp: shasum produced no hash, so every warm spawn reinstalls all dependencies";

/**
 * 🛑 THE VOLUME COMES UP EMPTY, so without this the overlay only trades a
 * WRONG-platform `node_modules` for NO `node_modules`. The image carries only
 * an empty, agent-owned directory at the destination — which is where the
 * volume gets its ownership — and docker seeds a volume from the image layer,
 * never from the bind under it. So there is no copy of the host's tree to
 * inherit, which is the whole point and also why something must install.
 *
 * 🛑 NO LOCKFILE MEANS SKIP, NOT FAIL. A configured project need not be a node
 * project, and the prelude chains on `&&` — so a failed install is an agent
 * that never starts, not an agent that starts without dependencies.
 *
 * 🛑 GUARDED ON THE LOCKFILE'S HASH, NOT ON npm's OWN MARKER. The volume
 * outlives the `--rm`, so a marker-only guard installs once and then runs
 * every later suite against the dependency tree of a lockfile the host has
 * since changed — a pass that proves nothing, which is this ticket's own
 * failure mode arriving by a second route.
 *
 * ⚠️ AN UNREADABLE HASH INSTALLS. `want` empty would otherwise equal an absent
 * stamp and skip, so the cheap failure is a reinstall rather than a false
 * green.
 *
 * 🛑 THE WARNING HANGS OFF THAT SAME EMPTINESS, #234, so it reports every way
 * the hash can fail — an absent binary, a broken interpreter, a future `-a
 * 256` typo. Testing `command -v shasum` instead tested a PROXY, and a
 * `shasum` that resolves without a working perl passed it silently.
 *
 * 🛑 IT REPORTS AND LETS THE INSTALL PROCEED. The prelude chains on `&&` and
 * ends in `exec "$@"`, so a check that exited non-zero would mean no agent
 * starts at all on a `perl`-less image.
 *
 * 🛑 STDERR, NOT STDOUT. `child.ts` drops a non-JSON stdout line on purpose,
 * so a warning written there vanishes exactly as quietly as the defect it
 * reports.
 *
 * ⚠️ `shasum`'s OWN stderr IS LEFT ALONE, NOT SILENCED. `sh: shasum: not
 * found` names the cause; the line above names the consequence. Both belong on
 * the channel that exists to carry them.
 *
 * ⚠️ `shasum -a 256`, NOT `sha256sum`. Both the image and a macOS host carry
 * `shasum`; only the image carries `sha256sum`, and the suite runs on the host.
 *
 * 🛑 THIS RUNS IN ITS OWN CONTAINER NOW, AND THAT CONTAINER IS HANDED NO
 * CREDENTIAL. The `env -u` scrub that used to wrap the `npm ci` was never a
 * boundary: docker hands the credentials to PID 1, so a lifecycle script read
 * them straight out of `/proc/1/environ` whatever `env -u` did to its own
 * child. Both routes were MEASURED on #231, not reasoned. `dockerInstallPlan`
 * is the boundary, and the scrub is DELETED rather than left in to read as
 * one.
 *
 * ⚠️ SO THIS STEP NO LONGER NAMES A CREDENTIAL AT ALL, and it must not start
 * naming one again. A `-u` list here is a textual claim about an environment
 * this container does not have.
 *
 * 🛑 `--ignore-scripts`, BECAUSE `npm ci` RUNS THIS PROJECT'S OWN `prepare`.
 * That script is `npm run build`, so the install ran `tsc` against the host
 * checkout `/work` binds read-write — 14 files into `dist/`, measured. Worse,
 * a failing `tsc` exits 1 and the `&&` below means no agent starts at all, on
 * any branch carrying a type error.
 *
 * ⚠️ IT DOES NOT COST esbuild ITS BINARY. `@esbuild/<platform>` ships the
 * binary as an optional dependency, so nothing here needs a build step. A
 * dependency that genuinely needs one — a node-gyp addon — would, and this
 * lockfile has none.
 *
 * ⚠️ `containerWorkDir`, NOT the host's project dir. `dockerRunPlan` holds a
 * host `projectDir` that reads as the natural argument and would emit a host
 * path into a script running inside the container. The parameter exists so the
 * suite can drive this step against a real directory in a real `sh`.
 */
export function nodeModulesInstallStep(
  containerWorkDir: string = CONTAINER_PROJECT_DIR,
): string {
  const lock = `${containerWorkDir}/package-lock.json`;
  const stamp = `${containerWorkDir}/${CONTAINER_NODE_MODULES_DIR}/.lock-sha`;

  return (
    `if [ ! -f '${lock}' ]; then :; else ` +
    `want=$(shasum -a 256 '${lock}' | cut -d' ' -f1); ` +
    `if [ -n "$want" ] && [ "$want" = "$(cat '${stamp}' 2>/dev/null)" ]; then :; else ` +
    `[ -n "$want" ] || echo '${NO_LOCK_HASH_WARNING}' >&2; ` +
    `npm ci --ignore-scripts && printf '%s' "$want" > '${stamp}'; fi; fi`
  );
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
  return [...steps.map((step) => `( ${step} )`), 'exec "$@"'].join(" && ");
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
 * ⚠️ Named rather than anonymous so it survives the `--rm`. No CLI surfaces
 * the name, so an operator drops one by prefix:
 * `docker volume ls -q --filter name=chat-mcp-node-modules-`.
 *
 * ⚠️ NOTHING PRUNES THESE. Each holds a full `node_modules`, the key space is
 * one per handle × tree, and `resolveCwd` accepts any directory CONTAINED by
 * an allowed one — so the space is wider than one per checkout. Filed as a
 * question rather than guessed at a policy.
 */
export function nodeModulesVolumeFor(
  supervisorHandle: string,
  projectDir: string,
): string {
  // 12 hex chars of sha256. Long enough that a collision is not a practical
  // concern, short enough that `docker volume ls` stays readable.
  const digest = createHash("sha256")
    .update(realpathSync(projectDir))
    .digest("hex")
    .slice(0, 12);

  return `chat-mcp-node-modules-${supervisorHandle}-${digest}`;
}

/**
 * The handle and project dir both plans need, validated once.
 *
 * 🛑 ONE FUNCTION, BECAUSE THE TWO CONTAINERS MUST AGREE ON THE TREE. The
 * install writes `node_modules` for the tree the agent then reads, so a
 * containment check that ran for one plan and not the other would let the
 * install populate a volume keyed to a directory the agent was refused.
 */
function containerTarget(opts: SpawnOptions): {
  supervisorHandle: string;
  projectDir: string;
} {
  const supervisorHandle = requireSupervisorHandle(opts);
  const projectDir = opts.cwd;

  if (!projectDir) {
    throw new Error("a containerized spawn needs a resolved cwd");
  }

  // 🛑 CHECKED HERE AS WELL AS AT REGISTRATION. `projects.json` is a file on
  // disk, so a registration made before this guard existed is still live, and
  // `opts.cwd` can reach this from `resolveCwd` without passing
  // `registerProject` at all. The argv below is what mounts it.
  assertProjectDirOutsideState(projectDir);

  return { supervisorHandle, projectDir };
}

/**
 * The project bind and the `node_modules` volume — the two mounts BOTH
 * containers get, and the only two the install container gets.
 *
 * 🛑 A DOCKER VOLUME, SO NO HOST DIRECTORY IS BOUND AT `node_modules`. `/work`
 * carries the host's macOS copy, and `esbuild` resolves a platform-specific
 * binary package, so a Linux container loading it dies before the first test
 * runs. The volume hides the host's copy from the container without writing to
 * it.
 *
 * 🛑 SHARED, SO THE TWO CONTAINERS CANNOT DRIFT APART. The install writing one
 * volume while the agent reads another is a silently empty `node_modules`, and
 * the symptom is a suite that fails on an import rather than on anything that
 * names the cause.
 *
 * Argv position is incidental — the daemon sorts mount destinations, measured
 * both ways. ⚠️ Docker 24.0.7 / macOS, UNRUN ON LINUX.
 */
function projectMountArgs(
  supervisorHandle: string,
  projectDir: string,
): string[] {
  return [
    "-v",
    `${projectDir}:${CONTAINER_PROJECT_DIR}`,
    "-v",
    `${nodeModulesVolumeFor(supervisorHandle, projectDir)}:${CONTAINER_PROJECT_DIR}/${CONTAINER_NODE_MODULES_DIR}`,
  ];
}

/** The one place that validates the field both `dockerRunPlan` and `spawnContainerized` need. */
function requireSupervisorHandle(opts: SpawnOptions): string {
  if (!opts.supervisorHandle) {
    throw new Error(
      "a containerized spawn needs opts.supervisorHandle to find its mounts",
    );
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

/**
 * The argv and environment for the dependency install, as its OWN
 * `docker run` — the one that is handed no credential.
 *
 * 🚨 THIS IS #231's BOUNDARY, AND IT IS STRUCTURAL RATHER THAN TEXTUAL. The
 * install used to run in the agent's own container, which docker hands every
 * credential as PID 1 — so a dependency's lifecycle script read the bus bearer
 * token, `GH_TOKEN` and the Claude OAuth token out of `/proc/1/environ`. Both
 * routes were measured in a built image. The lockfile that picks which
 * packages install comes from the mounted project tree, so the tree chose the
 * code that read them. A container with no credentials has none to leak.
 *
 * 🛑 EXACTLY TWO MOUNTS, per lee's ruling of 2026-11-14 on #231: *"drop
 * them"*. The agent's extra `mounts.json` mounts do not come here. The only
 * one configured in practice is the whole local-context store, and the install
 * has no business in it.
 *
 * ⚠️ NO `--name`. The agent's container is named so `kill()` can address a
 * `docker stop` to it; this one is synchronous and `--rm`, so a name would
 * only create a collision for a restart to trip over.
 *
 * ⚠️ NO `--network=none`, AND THAT IS DELIBERATE. `npm ci` has to reach a
 * registry. Egress control is a separate problem and #231 does not ask for it.
 */
export function dockerInstallPlan(
  vendor: VendorSpawn,
  opts: SpawnOptions,
): DockerRunPlan {
  const { supervisorHandle, projectDir } = containerTarget(opts);

  const args = [
    "run",
    "--rm",
    ...projectMountArgs(supervisorHandle, projectDir),
    "-w",
    CONTAINER_PROJECT_DIR,
    vendor.image,
    "sh",
    "-c",
    nodeModulesInstallStep(),
  ];

  // 🛑 REMOVED FROM THE CLIENT'S ENVIRONMENT TOO, NOT JUST LEFT OUT OF THE
  // ARGV. `-e NAME` with no `=` tells docker to copy the value from its own
  // environment, so an argv-only guard leaves this one stray `-e` away from
  // re-opening #231. With the names gone from here, even that stray flag
  // carries nothing.
  const env: NodeJS.ProcessEnv = { ...process.env };

  for (const name of containerCredentialEnvVars(vendor)) delete env[name];

  return { args, env };
}

/**
 * Run the install container to completion, or throw naming why.
 *
 * 🛑 SYNCHRONOUS, AND THE AGENT MUST NOT START WITHOUT IT. The agent reads
 * `node_modules` from the volume this writes, so an install that runs
 * afterwards or alongside hands the suite an empty or half-written tree. That
 * is the false green the old prelude's `&&` existed to prevent, and splitting
 * the containers must not lose it.
 *
 * ⚠️ IT BLOCKS THE EVENT LOOP, SO WHERE IT IS CALLED FROM MATTERS. A warm
 * spawn is one container start, around a second, which is the bar `docker rm
 * -f` is already held to. A COLD install is a full `npm ci` and blocks for as
 * long as that takes — `startSupervisor` therefore calls this once BEFORE it
 * binds the wake listener, so the first start's cold install happens while
 * nothing is waiting for an answer.
 *
 * 🛑 STDERR IS INHERITED, BECAUSE `NO_LOCK_HASH_WARNING` GOES THERE. Piping it
 * would swallow the one line that reports a `shasum` that cannot hash, which
 * is #234's whole symptom. npm's chatty stdout is dropped instead.
 */
export function runDependencyInstall(
  vendor: VendorSpawn,
  opts: SpawnOptions,
): void {
  const plan = dockerInstallPlan(vendor, opts);

  // 🛑 THE IMAGE IS CHECKED SEPARATELY, BECAUSE ITS ABSENCE IS AN OPERATOR
  // SETUP ERROR AND NOT A DEPENDENCY PROBLEM. Reported through the wrapper
  // below it reads "the dependency install container failed", which sends the
  // operator to npm when the fix is one flag.
  //
  // 🛑 `prepareAgentImage` CANNOT COVER THIS, BECAUSE IT BUILDS A DIFFERENT
  // THING FROM WHAT IS INSPECTED HERE. It only ever builds `IMAGE_TAG`, while
  // this line inspects `vendor.image` — a per-vendor field. `claudeSpawn` is
  // the only vendor today and sets them equal, so they agree by coincidence;
  // a second vendor naming its own image would reach here with nothing built.
  //
  // ⚠️ `startSupervisor` IS ALSO A LIBRARY EXPORT. Its one production caller
  // is `src/index.ts`, immediately after `prepareAgentImage` — but nothing in
  // the type stops another entry point calling it with no image on the
  // machine.
  //
  // ⚠️ IT REFUSES RATHER THAN BUILDING, per lee's ruling of 2026-11-15 — a
  // supervisor that is up with an agent that can never start is a worse lie
  // than refusing.
  //
  // 🛑 THE ORIGINAL REASON HERE WAS A `--driver docker-claude` HOLE AND IT IS
  // GONE, in both halves. `src/index.ts` now keys the block on
  // `selection.mode`, so that flag does enter it, and the
  // `imageNeedsBuild()`/`buildImage()` pair it named no longer exists there.
  try {
    execFileSync("docker", ["image", "inspect", vendor.image], {
      stdio: "ignore",
    });
  } catch {
    throw new Error(
      `the container image '${vendor.image}' is not on this machine, so no ` +
        "agent was started and no dependencies were installed. Start this " +
        "handle once with `--container`, which builds it, rather than with " +
        "`--driver docker-claude`, which selects a container without building " +
        "one.",
    );
  }

  try {
    execFileSync("docker", plan.args, {
      stdio: ["ignore", "ignore", "inherit"],
      env: plan.env,
    });
  } catch (err) {
    // 🛑 NAMED, NOT RE-THROWN BARE. `execFileSync`'s own message is
    // `Command failed: docker run …`, which reads as a docker fault rather
    // than as this project's dependencies failing to install — and the argv it
    // prints is 11 items of mount spec.
    throw new Error(
      "the dependency install container failed, so no agent was started; " +
        `its stderr is above: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

export function dockerRunPlan(
  vendor: VendorSpawn,
  opts: SpawnOptions,
): DockerRunPlan {
  const token = readToken();
  // Optional, unlike the Claude token. Most handles need no GitHub access, and
  // one that does not must still be able to start.
  const ghToken = readGhToken();
  if (!token) {
    throw new Error(
      "no Claude OAuth token on file; run `claude setup-token` on the host, then " +
        "`pbpaste | chat-mcp auth set-token` (stdin, never argv)",
    );
  }

  const { supervisorHandle, projectDir } = containerTarget(opts);

  const args = [
    "run",
    "-i",
    "--rm",
    "--name",
    containerNameFor(supervisorHandle),
    // 🛑 BY NAME, NEVER `NAME=value`. The value in the argv is readable through
    // `ps` for the life of the container, which `AGENTS.md` forbids in those
    // words. Docker copies it from this process's environment instead.
    "-e",
    vendor.authEnvVar,
    // 🛑 THE SAME TWO MOUNTS THE INSTALL CONTAINER GETS, FROM ONE FUNCTION.
    // The install populates this volume and this container reads it, so the
    // two argvs agreeing is a correctness requirement rather than a tidiness
    // one.
    ...projectMountArgs(supervisorHandle, projectDir),
  ];

  // 🛑 NAMED ONLY WHEN THERE IS ONE, because `-e NAME` with no `=` copies
  // whatever this process has — including nothing. An empty `GH_TOKEN` inside
  // the container reads to `gh` as a BAD credential rather than as no
  // credential, so the agent gets an auth error in place of the clear
  // "run `chat-mcp auth set-gh-token`" it should get.
  if (ghToken) args.push("-e", CONTAINER_GH_TOKEN_ENV);

  // 🛑 BOTH SIDES COME FROM ONE CHECKED VALUE. A host side built from the
  // realpath and a container side built from the raw declared string let a
  // symlink put one directory at two container paths, only one read-only.
  //
  // Order does not matter — measured both ways, the daemon sorts bind
  // destinations. ⚠️ Docker 24.0.7 / macOS, UNRUN ON LINUX.
  for (const entry of opts.readOnlyPaths ?? []) {
    const { host, inner } = checkedMountPath(
      projectDir,
      entry,
      "read-only path",
    );

    // 🛑 REFUSE RATHER THAN EMIT TWO SPECS FOR ONE DESTINATION. A declared
    // `node_modules` passes every containment check — it is relative,
    // colon-free, and inside the project — and then lands on the same
    // destination as the volume above. Docker refuses a duplicate destination,
    // so the symptom without this is a spawn that dies in the daemon with no
    // line connecting it to the manifest that caused it.
    const segment = inner.toLowerCase();

    if (
      segment === CONTAINER_NODE_MODULES_DIR ||
      segment.startsWith(`${CONTAINER_NODE_MODULES_DIR}/`)
    ) {
      throw new Error(
        `read-only path '${entry}' collides with the container-owned ` +
          `${CONTAINER_NODE_MODULES_DIR} volume at ` +
          `${CONTAINER_PROJECT_DIR}/${CONTAINER_NODE_MODULES_DIR}; the container installs its ` +
          "own, so it cannot also be mounted from the host",
      );
    }

    args.push("-v", `${host}:${CONTAINER_PROJECT_DIR}/${inner}:ro`);
  }

  // 🛑 `:ro`, BECAUSE THE TREE CHOOSES THE CODE THAT RUNS HERE. A project
  // `.npmrc` picks the registry, the container reaches it, and the substituted
  // package executes later as the agent — all three legs measured on #231. An
  // extra mount attached read-write made that a write path onto the host
  // directory it names, and the one configured in practice is the whole
  // local-context store.
  //
  // `assertProjectDirOutsideState` is re-checked here because `mounts.json`
  // outlives the guard in `registerMount`.
  for (const [key, hostDir] of Object.entries(mountsFor(supervisorHandle))) {
    assertProjectDirOutsideState(hostDir);
    args.push("-v", `${hostDir}:${containerPathFor(key)}:ro`);
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

  if (opts.grant) args.push("-e", CONTAINER_MCP_CONFIG_ENV);

  args.push("-w", CONTAINER_PROJECT_DIR, vendor.image);

  const cli = [opts.binary ?? vendor.binary, ...vendor.argsFor(opts, "docker")];

  // 🛑 ONE PUSH, SO THE TWO BRANCHES CANNOT DIVERGE AGAIN. Only a granted
  // spawn used to need a shell at all, so an install added to that branch
  // alone was present in every granted test and missing from every plain one.
  // Building one step list removes the shape that allowed it.
  const steps: string[] = [];

  if (opts.grant) {
    // 🛑 REFUSE RATHER THAN START BLIND. A granted child with no bus endpoint
    // would come up with an MCP config pointing nowhere, and the only symptom
    // is an agent that answers nothing.
    if (!opts.bus) {
      throw new Error(
        "a containerized spawn with a grant needs opts.bus to reach the host bus",
      );
    }

    cli.push(
      ...vendor.mcpConfigFlags(vendor.mcpConfigFor(opts.grant, "docker")),
    );

    env[CONTAINER_MCP_CONFIG_ENV] = buildContainerMcpConfig(opts.bus);

    // Config first, because it is instant and the install is not. A spawn that
    // dies in `npm ci` then still leaves the config written for the retry.
    steps.push(mcpConfigStep(vendor));
  }

  // 🚨 NO INSTALL STEP HERE, AND THAT IS #231's FIX. This container holds
  // every credential, so running `npm ci` in it put the project tree's choice
  // of packages in the same process tree as the bus token, `GH_TOKEN` and the
  // Claude OAuth token. `runDependencyInstall` does it first, in a container
  // handed none of them.
  args.push("sh", "-c", prelude(steps), "sh", ...cli);

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
    const stopper = spawn(
      "docker",
      ["stop", "-t", String(graceSeconds), name],
      {
        stdio: "ignore",
        detached: true,
      },
    );
    // An unhandled 'error' event on a child process is an uncaught exception,
    // so this handler is load-bearing rather than defensive. `kill()` is
    // best-effort by contract, and there is no logger at this layer.
    stopper.on("error", () => undefined);
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
        const out = execFileSync(
          "docker",
          ["ps", "-aq", "--filter", `name=^${name}$`],
          {
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
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
export function spawnContainerized(
  vendor: VendorSpawn,
  opts: SpawnOptions = {},
): AgentChild {
  const name = containerNameFor(requireSupervisorHandle(opts));

  // 🛑 BUILD THE PLAN BEFORE THE REMOVAL BELOW, BECAUSE THE REMOVAL IS
  // DESTRUCTIVE AND THIS THROWS. A missing token, an unresolved cwd, a
  // containment violation or a missing bus endpoint all raise here — and
  // running `docker rm -f` first meant a spawn that could never succeed
  // SIGKILLed the live agent on its way to the error. `dockerRunPlan` is pure.
  const plan = dockerRunPlan(vendor, opts);

  // 🚨 THE CREDENTIAL-FREE INSTALL, AND IT RUNS BEFORE THE REMOVAL BELOW
  // BECAUSE IT THROWS. The agent container holds every credential, so running
  // `npm ci` in it put the project tree's choice of packages in the same
  // process tree as the bus token, `GH_TOKEN` and the Claude OAuth token.
  //
  // 🛑 ABOVE `docker rm -f`, FOR THE SAME REASON `dockerRunPlan` IS. A
  // registry 503 throws here, and ordered after the removal that throw cost a
  // live container its life on the way out — a spawn that could not succeed
  // taking down the agent it was replacing. Raised by claude1 on PR 259; the
  // first cut had it on the wrong side and the test pinned it open.
  //
  // ⚠️ NOTHING IS RACED BY MOVING IT UP. `doRestart` and `replaceChild` both
  // call `child.kill()` before they reach `spawnFn`, so no live container is
  // reading this volume while the install writes it.
  //
  // ⚠️ EVERY SPAWN, INCLUDING A RESTART. `startSupervisor` also calls this once
  // before binding its wake listener, which is what keeps the FIRST start's
  // cold install off a loop anybody is waiting on. Dropping it here would leave
  // a restart after a lockfile change running the agent against the previous
  // dependency tree, with nothing saying so.
  runDependencyInstall(vendor, opts);

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
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  } catch {
    // Nothing by that name — the normal case, and not distinguishable from a
    // missing docker without a logger at this layer.
  }

  const child: ChildProcessWithoutNullStreams = spawn("docker", plan.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: plan.env,
  }) as ChildProcessWithoutNullStreams;

  const graceSeconds =
    opts.shutdownGraceSeconds ?? DEFAULT_SHUTDOWN_GRACE_SECONDS;

  return wireAgentChild(child, vendor, {
    stop: dockerStopFor(name, graceSeconds),
    teardown: dockerTeardownFor(name, graceSeconds),
  });
}
