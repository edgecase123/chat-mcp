import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync as realExecFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ensureStateDir,
  stateDir,
  writePrivateFileSync,
} from "../util/paths.js";

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

function writeContainerState(state: ContainerState): void {
  ensureStateDir();
  writePrivateFileSync(
    containerStatePath(),
    `${JSON.stringify(state, null, 2)}\n`,
  );
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

  const state = readContainerState();

  writeContainerState({
    ...state,
    builtHashes: { ...state.builtHashes, [image]: buildInputsHash() },
  });
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

interface PlanField {
  readonly label: string;
  readonly keys: readonly (keyof ContainerPlan)[];
  readonly read: (plan: Partial<ContainerPlan>) => string;
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

    if (from !== to) changes.push({ field: field.label, from, to });
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
  const state = readContainerState();
  writeContainerState({
    ...state,
    confirmed: { ...state.confirmed, [handle]: plan },
  });
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
