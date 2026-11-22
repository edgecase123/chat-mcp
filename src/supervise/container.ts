import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { execFileSync as realExecFileSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureStateDir,
  stateDir,
  writePrivateFileSync,
} from "../util/paths.js";
import { isProcessAlive } from "../util/process.js";

export const IMAGE_TAG = "chat-mcp-agent:local";

/**
 * The Cursor agent image, ruled separate by lee 2026-11-20: *"cursor should
 * have its own image"*.
 *
 * 🛑 ONE IMAGE PER VENDOR, BECAUSE THE CONTAINER IS THE SECURITY BOUNDARY.
 * A single image carrying both CLIs would put a second agent CLI inside every
 * sandbox that has no use for it, which is the opposite of what #222 exists to
 * achieve.
 *
 * ⚠️ NOTHING BUILDS THIS TAG YET. Unit 2 only declares it, so a containerized
 * Cursor spawn fails on a missing image rather than silently running the
 * Claude one. Unit 3 owns the Dockerfile.
 */
export const CURSOR_IMAGE_TAG = "chat-mcp-cursor-agent:local";

export interface ContainerPlan {
  readonly mountPaths: readonly string[];
  readonly envVarNames: readonly string[];

  /**
   * A digest over the override's env VALUES, never the values themselves.
   *
   * 🛑 THE GATE STORED NAMES ONLY, SO A ROTATED VALUE WAS INVISIBLE. An
   * operator approved `MY_VAR`; somebody changed what `MY_VAR` held; the plan
   * was byte-identical and the container ran a value nobody had approved. The
   * operator approved a NAME and believed they had approved its contents
   * (#356). lee ruled it: *"Yes it should. Security first."*
   *
   * 🛑 REQUIRED, LIKE `image`. An optional field would compile without
   * touching the diff's coverage test and slip through green — and an absent
   * one reads as `(not recorded)`, which is CHANGED, which is the direction
   * that re-prompts rather than the one that blesses.
   *
   * ⚠️ NOT IN THE BANNER AND NOT IN THE RE-PROMPT. `describePlan` omits it
   * and `diffPlans` redacts it to `(not shown)`.
   *
   * ⚠️ `GET /api/agents/plan` DOES RETURN IT, because the confirm echoes the
   * whole plan back and the server re-derives the comparison from it. That is
   * why the digest is an HMAC under a per-install key rather than a bare hash:
   * what reaches the dashboard is not invertible. Replacing the echo with a
   * server-held token is the better fix and is not this ticket.
   */
  readonly envValuesDigest: string;
  readonly binary: string;
  readonly networkMode: string;

  /**
   * The image the container will actually run.
   *
   * 🛑 THE OPERATOR WAS CONFIRMING A CONTAINER NOBODY HAD NAMED. The banner
   * listed mounts, env var names, binary and network, and an override may
   * replace the IMAGE — so an operator could approve a plan and a different
   * image would start, as PID 1 beside three credentials.
   */
  readonly image: string;

  /**
   * The caps the container will run under, or `null` for no cap at all.
   *
   * 🛑 `null` IS PRINTED, NOT OMITTED. An absent key means docker imposes no
   * limit and reports none, so a banner that simply dropped the line would let
   * an operator read silence as a cap.
   *
   * 🛑 REQUIRED, LIKE `image`. An optional field would let a future caller
   * build a plan that silently went back to describing nothing.
   */
  readonly memory: string | null;
  readonly cpus: string | null;

  /**
   * What the DEPENDENCY-INSTALL container runs under, which is not always what
   * the agent container runs under.
   *
   * 🛑 A CAP BELOW #346's FLOOR IS RAISED FOR THAT CONTAINER. A banner that
   * printed the handle's own number and stopped understated the peak — `512m`
   * on the banner, `--memory 1g` on a container that actually ran. A number
   * reads as more authoritative than an omission, so that is worse than the
   * silence it replaced.
   */
  readonly installMemory: string | null;
  readonly installCpus: string | null;
}

interface ContainerState {
  /**
   * The pre-multi-image shape, which described the claude image alone.
   *
   * ⚠️ STILL ON DISK, SO IT IS STILL READ. `readContainerState` folds it into
   * `builtHashes` under `IMAGE_TAG`, because dropping it would make every
   * existing install rebuild once for nothing.
   */
  builtHash: string | null;

  /**
   * What each IMAGE was last built from, keyed by image.
   *
   * 🛑 PER IMAGE, BECAUSE ONE KEY MADE THE SECOND VENDOR'S IMAGE UNBUILDABLE.
   * A single hash is satisfied by whichever image was built last, so building
   * one marks the other current — and the other is then never built again,
   * silently. A contained cursor agent died on a module the image did not
   * have, which reads as a dead agent rather than a missing build.
   */
  builtHashes: Record<string, string>;

  /**
   * The plan each handle approved, keyed by handle.
   *
   * 🛑 THE PLAN IS STORED, NOT A HASH. A digest can say that something
   * changed; only the plan can say the image WAS `chat-mcp-agent:local`. The
   * hash is derivable from the plan and the plan is not derivable from the
   * hash, so storing the hash throws away the re-prompt's content.
   *
   * ⚠️ `true` IS THE PRE-FINGERPRINT SHAPE and still appears on disk. It
   * records which plan was approved nowhere, so it compares to nothing.
   */
  confirmed: Record<string, ContainerPlan | true>;
}

const EMPTY_STATE: ContainerState = {
  builtHash: null,
  builtHashes: {},
  confirmed: {},
};

function containerStatePath(): string {
  return join(stateDir(), "container.json");
}

function readContainerState(): ContainerState {
  const path = containerStatePath();

  if (!existsSync(path)) return EMPTY_STATE;

  try {
    const parsed = JSON.parse(
      readFileSync(path, "utf8"),
    ) as Partial<ContainerState>;

    const legacy = parsed.builtHash ?? null;
    const hashes = { ...(parsed.builtHashes ?? {}) };

    // The legacy key described `IMAGE_TAG` and nothing else, so it fills that
    // slot only when the per-image map has not already answered for it.
    if (legacy && hashes[IMAGE_TAG] === undefined) hashes[IMAGE_TAG] = legacy;

    return {
      builtHash: legacy,
      builtHashes: hashes,
      confirmed: parsed.confirmed ?? {},
    };
  } catch {
    console.error(
      `container state at ${path} is not valid JSON — falling back to empty state`,
    );
    return EMPTY_STATE;
  }
}

/** The lock every `container.json` read-modify-write is taken under. */
function containerLockPath(): string {
  return `${containerStatePath()}.lock`;
}

/**
 * How long a LIVE holder is waited for before the update is abandoned.
 *
 * A dead holder is never waited for at all — see `acquireContainerLock`.
 */
const LOCK_WAIT_MS = 2_000;

/** One pause between attempts. */
const LOCK_POLL_MS = 5;

/**
 * Pause without yielding.
 *
 * 🛑 EVERY FUNCTION ON THIS PATH IS SYNCHRONOUS, down to `readFileSync`, so
 * there is no event loop to await on. `Atomics.wait` on a throwaway buffer is
 * the only sync sleep in Node that does not spin a core.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Whether the process named inside the lock file is still running.
 *
 * 🛑 AN EMPTY OR UNPARSEABLE LOCK READS AS ALIVE, AND THAT IS THE WHOLE
 * CORRECTNESS ARGUMENT. Writing the file is not instantaneous, so a lock
 * caught mid-creation holds no pid yet. Reading that as dead lets two
 * processes break each other's fresh locks, which is a slower version of the
 * defect this lock exists to fix.
 */
function lockHolderIsAlive(path: string): boolean {
  let raw: string;

  try {
    raw = readFileSync(path, "utf8").trim();
  } catch {
    // Vanished or unreadable between the failed create and this read. The
    // caller retries, so claiming it is alive costs one poll interval.
    return true;
  }

  const pid = Number.parseInt(raw, 10);

  if (!Number.isInteger(pid) || pid <= 0) return true;

  return isProcessAlive(pid);
}

/**
 * Take the lock, or throw having taken nothing.
 *
 * 🛑 LIVENESS IS CHECKED INSTEAD OF A STALE-AGE BEING GUESSED. A `SIGKILL`ed
 * supervisor leaves its lock behind, and an age threshold has to choose
 * between breaking a slow writer's lock and bricking every spawn until a
 * human deletes a file. `process.kill(pid, 0)` answers it in one syscall, and
 * its failure mode is benign: pid reuse makes a dead holder read as alive, so
 * the caller waits and throws rather than losing a write.
 */
function acquireContainerLock(): string {
  const path = containerLockPath();
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      // 🛑 ONE CALL, NOT `openSync` THEN `writeSync`. Two calls leave the lock
      // momentarily EMPTY, which is the case the liveness check above has to
      // treat as alive. `host-grant.ts` writes its grant the same way.
      writePrivateFileSync(path, `${process.pid}\n`, "wx");
      return path;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${LOCK_WAIT_MS}ms waiting for ${path}. A live process ` +
          `holds it. If nothing is running, delete that file.`,
      );
    }

    // A dead holder is broken immediately and retried with no pause.
    if (lockHolderIsAlive(path)) sleepSync(LOCK_POLL_MS);
    else rmSync(path, { force: true });
  }
}

/**
 * The ONLY way `container.json` is written.
 *
 * 🛑 THE READ AND THE WRITE ARE ONE CRITICAL SECTION, AND THAT IS THE FIX.
 * Two unlocked read-modify-writes lose the first one's change: the operator
 * approves a plan on the web card, a concurrent `buildImage` writes back the
 * state it read before that approval, and the card still reports success. The
 * worse direction is a lost `builtHash`, which makes `imageNeedsBuild` report
 * a stale image as current.
 *
 * ⚠️ `writeContainerState` IS GONE RATHER THAN KEPT BESIDE THIS. An unlocked
 * write left in reach is how the next caller reintroduces the defect without
 * touching this file.
 *
 * Staged and renamed as well as locked, because the lock orders writers in
 * THIS codebase and a reader needs no lock at all once every write is atomic.
 */
function updateContainerState(
  mutate: (state: ContainerState) => ContainerState,
): void {
  ensureStateDir();

  const path = containerStatePath();
  const staging = `${path}.${process.pid}.tmp`;
  const lock = acquireContainerLock();

  try {
    writePrivateFileSync(
      staging,
      `${JSON.stringify(mutate(readContainerState()), null, 2)}\n`,
    );
    renameSync(staging, path);
  } finally {
    // ⚠️ BOTH, AND IN THIS ORDER. A mutator that throws must leave neither the
    // lock nor a staging file behind. After a successful rename the staging
    // path is already gone, so the first call is a no-op.
    rmSync(staging, { force: true });
    rmSync(lock, { force: true });
  }
}

export function dockerfilePath(): string {
  const fromDist = fileURLToPath(new URL("../../Dockerfile", import.meta.url));
  if (existsSync(fromDist)) return fromDist;

  const fromSource = fileURLToPath(
    new URL("../../../Dockerfile", import.meta.url),
  );
  if (existsSync(fromSource)) return fromSource;

  throw new Error(`cannot locate Dockerfile next to ${import.meta.url}`);
}

/**
 * Every path the Dockerfile copies into the image, relative to the build
 * context. The hash covers all of them.
 *
 * 🛑 KEEP THIS IN STEP WITH THE DOCKERFILE'S `COPY` LINES. A build input
 * that is copied but not hashed is invisible to the freshness check, which is
 * the whole defect this file exists to fix. `DockerfileInputsTest` fails if
 * the Dockerfile copies something this list does not name.
 */
export const BUILD_INPUT_PATHS = [
  "package.json",
  "package-lock.json",
  "dist",
] as const;

/** The build context: `docker build` is handed `dirname(dockerfilePath())`. */
function contextPath(): string {
  return dirname(dockerfilePath());
}

/**
 * What kind of thing `path` is, without ever throwing.
 *
 * 🛑 `statSync` THROWS ON A BROKEN SYMLINK, and `dist` is build output that
 * a half-finished build leaves them in. An unguarded stat took
 * `supervise --container` down with an opaque ENOENT instead of rebuilding
 * the image — the one action that would have cleared it. Raised by claude2
 * on PR 211.
 */
function kindOf(path: string): "file" | "dir" | "unreadable" {
  try {
    return statSync(path).isDirectory() ? "dir" : "file";
  } catch {
    return "unreadable";
  }
}

/**
 * Entries under `root`, relative to it. A single file yields `['']`.
 *
 * ⚠️ AN UNREADABLE ENTRY IS KEPT, NOT SKIPPED. Dropping it would make a
 * tree with a broken symlink hash identically to one without, so replacing a
 * real file with a dangling link would not rebuild.
 */
function filesUnder(root: string): string[] {
  if (kindOf(root) !== "dir") return [""];

  return readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((rel) => kindOf(join(root, rel)) !== "dir")
    .sort();
}

/**
 * 🛑 THE DOCKERFILE ALONE IS NOT WHAT THE IMAGE CONTAINS. It says
 * `COPY dist ./dist`, so the image is mostly BUILT CODE that the Dockerfile's
 * own bytes never change. Hashing only the Dockerfile reported an image built
 * before three merges as current, and the container then ran a `dist` with no
 * HTTP bus in it at all — `agents start` came up and answered nothing.
 *
 * ⚠️ `package-lock.json` COUNTS TOO, and it was the second half of the same
 * hole. The Dockerfile copies it and runs `npm ci`, so bumping a dependency
 * changes what the image contains while the Dockerfile stays byte-identical.
 * Raised by claude2 on PR 211.
 *
 * 🛑 CONTENT, NOT MTIME. A rebuild that writes identical bytes must not force
 * a docker build, and a stale `dist` restored with a fresh mtime must not pass.
 */
export function buildInputsHash(context: string = contextPath()): string {
  const hash = createHash("sha256");

  hash.update(readFileSync(dockerfilePath()));

  for (const input of BUILD_INPUT_PATHS) {
    const root = join(context, input);

    if (!existsSync(root)) {
      // A distinct value, so a MISSING input can never collide with a
      // present one that happens to be empty.
      hash.update(`\0absent:${input}\0`);
      continue;
    }

    for (const rel of filesUnder(root)) {
      const full = rel ? join(root, rel) : root;

      hash.update(`\0${input}/${rel}\0`);

      if (kindOf(full) === "unreadable") {
        hash.update("\0unreadable\0");
        continue;
      }

      hash.update(readFileSync(full));
    }
  }

  return hash.digest("hex");
}

export type Runner = (cmd: string, args: readonly string[]) => Buffer;

/**
 * What one `docker build` of this project produces.
 *
 * 🛑 `vendor` IS THE DOCKERFILE'S `AGENT_VENDOR` VALUE, not a second spelling
 * of it. `dockerfile-vendor-stages.test.ts` pins the `cli-*` stages against
 * `vendorsWithSpawn()`, so a vendor's own name already selects its stage.
 */
export interface ImageBuild {
  readonly image: string;
  readonly vendor: string;
}

/**
 * Whether `image` has to be built before a handle can run it.
 *
 * 🛑 IT INSPECTS THE IMAGE IT WAS ASKED ABOUT. It used to inspect `IMAGE_TAG`
 * whatever it was asked, so a present claude image answered "fresh" for a
 * cursor image that did not exist at all.
 */
export function imageNeedsBuild(
  run: Runner = realExecFileSync,
  image: string = IMAGE_TAG,
): boolean {
  const state = readContainerState();

  if (state.builtHashes[image] !== buildInputsHash()) return true;

  try {
    run("docker", ["image", "inspect", image]);
    return false;
  } catch {
    return true;
  }
}

/**
 * Build one image, defaulting to the claude one with no `--build-arg`.
 *
 * 🛑 THE DEFAULT PASSES NO `--build-arg`, AND THAT IS A CONTRACT. The
 * Dockerfile's own `ARG AGENT_VENDOR=claude` is what makes a bare
 * `docker build` still produce the claude image, and a test pins that default.
 * Naming it here as well would put the same value in two places.
 */
export function buildImage(
  run: Runner = realExecFileSync,
  build?: ImageBuild,
): void {
  const image = build?.image ?? IMAGE_TAG;

  run("docker", [
    "build",
    "-t",
    image,
    // 🛑 WITHOUT THIS THE DOCKERFILE DEFAULT WINS AND BAKES THE WRONG CLI.
    // The command would tag a CLAUDE image with the CURSOR name, and that
    // container starts, finds no `cursor-agent`, and exits 127.
    ...(build ? ["--build-arg", `AGENT_VENDOR=${build.vendor}`] : []),
    "-f",
    dockerfilePath(),
    dirname(dockerfilePath()),
  ]);

  // 🛑 HASHED BEFORE THE LOCK IS TAKEN, NOT INSIDE THE MUTATOR. It walks
  // `dist` and that is slow enough to matter: held inside the critical
  // section it is wait every other writer pays for, and `LOCK_WAIT_MS` is
  // what they run out of. The ordering against the `docker build` above is
  // unchanged, which is the part that has to stay true.
  const hash = buildInputsHash();

  updateContainerState((state) => ({
    ...state,
    builtHashes: { ...state.builtHashes, [image]: hash },
  }));
}

/**
 * Compile the TypeScript, then rebuild the image if its inputs moved.
 *
 * 🛑 THE COMPILE IS UNCONDITIONAL AND IT RUNS FIRST. It used to sit INSIDE the
 * `if (imageNeedsBuild())` branch, and `BUILD_INPUT_PATHS` names `dist` — build
 * OUTPUT. So editing `src/` moved nothing the hash could see, the branch never
 * ran, the compile never ran, and the container started on the last-compiled
 * `dist` while the check reported the image as current. lee ruled option B on
 * 2026-11-16: make the compile unconditional and leave the hash alone.
 *
 * 🛑 A HOIST, NOT A DEDENT, AND THAT IS THE WHOLE FIX. A compile left below
 * the check — even dedented out of the branch — still hashes the stale `dist`,
 * because the freshness verdict has already been computed. The order is the
 * property; a test asserts it.
 *
 * ⚠️ IT DOES NOT MAKE EVERY START PAY FOR A DOCKER BUILD. A no-op `tsc` is
 * ~1.34s, and `buildInputsHash` is a CONTENT hash — identical bytes produce
 * the same hash, so the docker build is still skipped.
 */
export function prepareAgentImage(
  compile: () => void,
  opts: {
    run?: Runner;
    needsBuild?: (run: Runner, image: string) => boolean;
    logLine?: (line: string) => void;

    /**
     * The image this handle will actually run, from
     * `effectiveImage(vendor, override)`.
     *
     * 🛑 DEFAULTS TO `IMAGE_TAG`, SO OMITTING IT MEANS "BUILD AS BEFORE". The
     * skip below is the new behaviour and a default of `undefined` must not
     * reach it, or every caller that omits this stops building.
     */
    image?: string;

    /**
     * The vendor whose image `image` is, when it is a vendor's at all.
     *
     * 🛑 ITS PRESENCE IS WHAT SEPARATES A VENDOR IMAGE FROM A STRANGER'S.
     * This project can build any vendor's image and cannot build an operator
     * override, so the skip below keys on this rather than on the tag — a
     * check against `IMAGE_TAG` alone called the cursor image somebody
     * else's and never built it.
     */
    buildVendor?: string;
  } = {},
): void {
  const run = opts.run ?? realExecFileSync;
  const needsBuild = opts.needsBuild ?? imageNeedsBuild;
  const logLine = opts.logLine ?? ((line: string) => console.log(line));
  const image = opts.image ?? IMAGE_TAG;
  const vendor = opts.buildVendor;

  compile();

  // 🛑 AFTER THE COMPILE, NEVER BEFORE IT. A handle on another image still
  // mounts and runs THIS project's `dist`, so the compile is unconditional —
  // lee's option B of 2026-11-16. Only the DOCKER build is skipped.
  //
  // 🛑 THE FRESHNESS CHECK IS SKIPPED TOO, NOT JUST THE BUILD. It hashes this
  // project's sources and inspects an image, so its verdict is about something
  // this handle will not run — and it is the call that decides whether minutes
  // of docker get spent.
  //
  // ⚠️ IT STILL REFUSES LATER, AND THAT IS lee's RULING OF 2026-11-15.
  // `runDependencyInstall` inspects this same value and refuses when it is not
  // present. What this skip removes is paying for a build before that refusal,
  // not the refusal.
  if (image !== IMAGE_TAG && !vendor) {
    logLine(
      `"${image}" is not an image this project can build, so ` +
        "no image was built for this handle",
    );
    return;
  }

  if (!needsBuild(run, image)) return;

  logLine(`building ${image} (sources, Dockerfile or image changed)...`);
  buildImage(run, vendor ? { image, vendor } : undefined);
}

export interface PlanChange {
  readonly field: string;
  readonly from: string;
  readonly to: string;
}

/**
 * Whether the handle may start without asking, and why not when it may not.
 *
 * `legacy` is separate from `unseen` so the re-prompt can say the approval is
 * being re-taken rather than taken for the first time.
 */
export type ConfirmVerdict =
  | { readonly kind: "confirmed" }
  | { readonly kind: "unseen" }
  | { readonly kind: "legacy" }
  | { readonly kind: "changed"; readonly changes: readonly PlanChange[] };

/** What a field the stored plan never carried reads as. */
const NOT_RECORDED = "(not recorded)";

/** What a redacted field reads as in a re-prompt. */
const NOT_SHOWN = "(not shown)";

/**
 * What a usable `env-digest-key` file holds, and nothing else will do.
 *
 * 🛑 THE SHAPE IS THE WHOLE GUARD, BECAUSE A LENGTH CHECK IS NOT ENOUGH.
 * `Buffer.from(x, "hex")` stops at the first byte it cannot read and returns
 * what it already had, so 64 good characters followed by junk still decodes to
 * a full 32 bytes and a file of pure junk decodes to NONE. `createHmac` takes a
 * zero-length key without complaint, which leaves the digest a function of its
 * input alone — the install-independent value this key exists to prevent.
 */
const ENV_DIGEST_KEY_HEX = /^[0-9a-f]{64}$/;

/**
 * The per-install key the env digest is taken under.
 *
 * 🛑 WITHOUT IT THE DIGEST IS A GUESSABLE FUNCTION OF A SECRET. The names
 * ship in the same object, and the serialisation is public, so an unsalted hash
 * leaves only the VALUES to search — and `"1"`, `"true"` or a short enum falls
 * to an offline sweep in milliseconds. `/api/agents/plan` echoes the whole plan
 * to the dashboard, so the digest leaves the host process whether or not the
 * re-prompt prints it.
 *
 * ⚠️ IT DOES NOTHING AGAINST SOMEBODY WHO CAN WRITE THIS DIRECTORY. They can
 * rewrite the stored plan outright, which was already unauthenticated. The key
 * answers one threat only: a reader of the dashboard's HTTP responses who
 * cannot read these files.
 *
 * ⚠️ LOSING IT RE-PROMPTS EVERY HANDLE ONCE, and that is the safe direction.
 * It is never rotated, because rotating it would do that on purpose.
 *
 * ⚠️ SO A MALFORMED FILE IS REPLACED RATHER THAN REFUSED. `writePrivateFileSync`
 * is not atomic, so an interrupted first write leaves a partial key, and a
 * throw there would brick every container spawn over one lost byte.
 */
function envDigestKey(): Buffer {
  const path = join(stateDir(), "env-digest-key");

  if (existsSync(path)) {
    const stored = readFileSync(path, "utf8").trim();

    if (ENV_DIGEST_KEY_HEX.test(stored)) return Buffer.from(stored, "hex");

    // ⚠️ SAID OUT LOUD, BECAUSE THE SYMPTOM IS A MASS RE-PROMPT. Every handle
    // re-prompts once after this, and an operator with no stated cause reads
    // that as the gate malfunctioning rather than as a damaged file.
    console.error(
      `env digest key at ${path} is not 64 hex characters — minting a new one, which re-prompts every handle once`,
    );
  }

  const key = randomBytes(32).toString("hex");
  ensureStateDir();

  // 🛑 CHECKED OUTSIDE THE BRANCH ABOVE, BECAUSE `existsSync` FOLLOWS THE LINK.
  // A DANGLING link reads as absent and reaches this write just the same.
  //
  // ⚠️ REFUSED RATHER THAN REGENERATED, UNLIKE A MALFORMED FILE. Nothing here
  // ever writes a link, so one is deliberate rather than damage, and
  // `writeFileSync` plus `chmodSync` would both land on its TARGET — an
  // arbitrary file overwritten with hex and chmodded 0600.
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error(
      `refusing to write the env digest key through ${path}: it is a symlink, so ` +
        `the key would land in the link's target and overwrite whatever is there. ` +
        `Remove the link.`,
    );
  }

  writePrivateFileSync(path, key);

  return Buffer.from(key, "hex");
}

/**
 * One digest over an override's env values (#356).
 *
 * 🛑 THE NAME IS HASHED WITH ITS VALUE, SO A SWAP IS A CHANGE. Hashing the
 * values alone makes `{A:"1",B:"2"}` and `{A:"2",B:"1"}` identical, and that is
 * two credentials handed to the wrong variables with the gate silent.
 *
 * 🛑 SORTED, SO KEY ORDER IS NOT A CHANGE. An override file rewritten with
 * its keys reordered would otherwise re-prompt for nothing, and a gate that
 * cries wolf is one an operator learns to click through.
 *
 * ⚠️ NO OVERRIDE AT ALL IS A REAL DIGEST, not an empty string. An empty
 * string would be indistinguishable from a field that was never recorded.
 */
export function envValuesDigest(
  env: Readonly<Record<string, string>> | undefined,
): string {
  const entries = Object.entries(env ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  return createHmac("sha256", envDigestKey())
    .update(JSON.stringify(entries))
    .digest("hex");
}

interface PlanField {
  readonly label: string;
  readonly keys: readonly (keyof ContainerPlan)[];
  readonly read: (plan: Partial<ContainerPlan>) => string;

  /**
   * Compare on this field, but never PRINT what it holds (#356).
   *
   * 🛑 `read` SERVES TWO MASTERS AND ONE OF THEM IS A DISCLOSURE SURFACE.
   * `diffPlans` compares its output and `describeChanges` prints it, so a
   * field whose value is a function of a secret cannot use the same string for
   * both. The operator needs the CATEGORY that moved, not the bytes.
   *
   * ⚠️ `(not recorded)` IS STILL SHOWN. It discloses nothing and it is the
   * one thing a reader of a legacy re-prompt actually needs to know.
   */
  readonly secret?: true;
}

/**
 * 🔴 `JSON.stringify`, NOT `join`. A joined string is not a comparison: a
 * mount key containing `", /mnt/"` made `["/work", "/mnt/a, /mnt/b"]` and
 * `["/work", "/mnt/a", "/mnt/b"]` render identically, and the gate reported
 * `confirmed` while the container gained two host directories nobody
 * approved. Mount keys are unvalidated BY DESIGN — see `mounts.ts`.
 *
 * 🛑 NO SEPARATOR IS SAFE, SO THERE IS NO SEPARATOR. Picking a rarer
 * character needs an argument about what a key cannot contain, and the key is
 * free-form. Found by claude2 on PR 352.
 *
 * ⚠️ IT ALSO READS BETTER IN THE RE-PROMPT, because the quotes show the
 * operator where one path ends and the next begins.
 */
function asList(value: unknown): string {
  return Array.isArray(value) ? JSON.stringify(value) : NOT_RECORDED;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : NOT_RECORDED;
}

/**
 * ⚠️ `undefined` AND `null` MEAN DIFFERENT THINGS HERE. `null` is a cap the
 * operator declined to set, which the banner prints as `no limit`. `undefined`
 * is a field the stored plan never carried, which must not read as a decision.
 */
function asCap(agent: unknown, install: unknown): string {
  if (agent === undefined) return NOT_RECORDED;

  return capLine(agent as string | null, (install ?? null) as string | null);
}

/**
 * What a secret field prints in a re-prompt.
 *
 * ⚠️ `(not recorded)` SURVIVES REDACTION. It is not derived from the secret,
 * and it is the difference between "this moved" and "this was never stored" —
 * which is the only part of a legacy re-prompt an operator can act on.
 */
function redact(value: string): string {
  return value === NOT_RECORDED ? NOT_RECORDED : NOT_SHOWN;
}

/**
 * The banner's lines, and which plan fields each one reads.
 *
 * 🛑 ONE LINE PER OPERATOR DECISION, NOT ONE PER FIELD. `installMemory` is
 * derived from `memory`, so diffing the two separately would report a single
 * decision as two changes.
 *
 * 🛑 `keys` EXISTS SO THE COVERAGE CAN BE ASSERTED. A field added to
 * `ContainerPlan` that no line reads is a change the operator is never shown,
 * and nothing else in the suite can see that gap.
 *
 * ⚠️ THAT GUARD RESTS ON THE FIELD BEING REQUIRED. A required addition breaks
 * the coverage test's own plan factory at `tsc` first. An OPTIONAL one would
 * compile without touching the factory and slip through green.
 */
const PLAN_FIELDS: readonly PlanField[] = [
  { label: "mounts", keys: ["mountPaths"], read: (p) => asList(p.mountPaths) },
  {
    label: "env vars",
    keys: ["envVarNames"],
    read: (p) => asList(p.envVarNames),
  },
  // 🛑 ITS OWN LINE, THOUGH A NAME ADDED MOVES BOTH. The docblock above
  // asks for one line per operator DECISION, and adding a name is one decision
  // that now reports two changes. That noise is the deliberate trade: folding
  // the digest into the names line means one `read` string has to be both the
  // comparison and the printed text, and this one cannot be printed.
  {
    label: "env var values",
    keys: ["envValuesDigest"],
    read: (p) => asText(p.envValuesDigest),
    secret: true,
  },
  { label: "binary", keys: ["binary"], read: (p) => asText(p.binary) },
  {
    label: "network",
    keys: ["networkMode"],
    read: (p) => asText(p.networkMode),
  },
  { label: "image", keys: ["image"], read: (p) => asText(p.image) },
  {
    label: "memory",
    keys: ["memory", "installMemory"],
    read: (p) => asCap(p.memory, p.installMemory),
  },
  {
    label: "cpus",
    keys: ["cpus", "installCpus"],
    read: (p) => asCap(p.cpus, p.installCpus),
  },
];

/** Every `ContainerPlan` field the diff reads. Asserted against the type. */
export const PLAN_FIELD_KEYS: readonly string[] = PLAN_FIELDS.flatMap(
  (field) => field.keys,
);

/**
 * What changed between the plan the operator approved and the one about to
 * run, named as the banner names it.
 *
 * ⚠️ `before` IS PARTIAL ON PURPOSE. It came off disk, possibly from an older
 * build, so a field it never carried reads as `(not recorded)` and therefore
 * as CHANGED. Reading the gap as equal is the fails-open direction.
 */
export function diffPlans(
  before: Partial<ContainerPlan>,
  after: ContainerPlan,
): PlanChange[] {
  const changes: PlanChange[] = [];

  for (const field of PLAN_FIELDS) {
    const from = field.read(before);
    const to = field.read(after);

    if (from === to) continue;

    changes.push({
      field: field.label,
      from: field.secret ? redact(from) : from,
      to: field.secret ? redact(to) : to,
    });
  }

  return changes;
}

export function confirmVerdict(
  handle: string,
  plan: ContainerPlan,
): ConfirmVerdict {
  const stored = readContainerState().confirmed[handle];

  if (stored === undefined) return { kind: "unseen" };

  // 🛑 lee RULED A, 2026-11-20. A legacy `true` counts as NOT confirmed, so
  // the handle re-prompts once at a terminal. Treating it as confirmed would
  // bless an override written after the original approval, which is the exact
  // defect this gate exists to close.
  if (typeof stored !== "object" || stored === null) return { kind: "legacy" };

  const changes = diffPlans(stored, plan);

  return changes.length === 0
    ? { kind: "confirmed" }
    : { kind: "changed", changes };
}

export function markConfirmed(handle: string, plan: ContainerPlan): void {
  updateContainerState((state) => ({
    ...state,
    confirmed: { ...state.confirmed, [handle]: plan },
  }));
}

/** The changed lines, one per line, for the re-prompt. */
export function describeChanges(changes: readonly PlanChange[]): string {
  return changes
    .map((change) => `  ${change.field}: ${change.from} -> ${change.to}`)
    .join("\n");
}

/** What an absent cap reads as, so the uncapped case is said out loud. */
const NO_LIMIT = "no limit";

/**
 * One cap as the operator reads it, naming the install container only when it
 * differs.
 *
 * 🛑 THE SUFFIX IS CONDITIONAL AND THE OMISSION IS NOT. An absent cap still
 * prints `no limit`, because docker reports no limit either way. The install
 * suffix is dropped only when the two values are EQUAL, so nothing is hidden
 * by its absence.
 */
function capLine(agent: string | null, install: string | null): string {
  // 🛑 THROWS RATHER THAN DROPPING THE INSTALL VALUE. Unreachable today —
  // both come off one `override` — but the `agent === null` early return
  // would silently discard a non-null install cap, which is the shape this
  // function exists to stop. Raised by claude2 on PR 349.
  if (agent === null && install !== null) {
    throw new Error(
      `an install cap of "${install}" with no agent cap cannot be described; ` +
        "the banner would drop it silently",
    );
  }

  if (agent === null) return NO_LIMIT;
  if (install === null || install === agent) return agent;

  return `${agent} (dependency install: ${install})`;
}

/**
 * 🛑 ONE PER LINE AND QUOTED, FOR THE SAME REASON `asList` USES
 * `JSON.stringify`. `", "` separated the mounts and is legal inside a mount
 * key, so `["/work/a, b"]` and `["/work/a", "b"]` printed the same sentence
 * and an operator could not tell which grant they were approving. A newline
 * is legal in a path too, so the line break alone is not enough — the quotes
 * are what make each entry's end visible. Mount keys are unvalidated BY
 * DESIGN, see `mounts.ts`.
 *
 * ⚠️ `envVarNames` STAYS JOINED. `ENV_NAME` in `overrides.ts` is
 * `/^[A-Z][A-Z0-9_]*$/`, so a name cannot contain a comma or a space and the
 * one-line form is unambiguous there.
 */
function mountLines(mountPaths: readonly string[]): string[] {
  return [
    "  mounts:",
    ...mountPaths.map((path) => `    ${JSON.stringify(path)}`),
  ];
}

export function describePlan(plan: ContainerPlan): string {
  return [
    "This will run the agent inside a Docker container:",
    ...mountLines(plan.mountPaths),
    `  env vars (names only): ${plan.envVarNames.join(", ")}`,
    `  binary: ${plan.binary}`,
    `  network: ${plan.networkMode}`,
    `  image: ${plan.image}`,
    `  memory: ${capLine(plan.memory, plan.installMemory)}`,
    `  cpus: ${capLine(plan.cpus, plan.installCpus)}`,
  ].join("\n");
}
