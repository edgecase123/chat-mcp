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
}

interface ContainerState {
  builtHash: string | null;
  confirmed: Record<string, boolean>;
}

const EMPTY_STATE: ContainerState = { builtHash: null, confirmed: {} };

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

    return {
      builtHash: parsed.builtHash ?? null,
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

export function imageNeedsBuild(run: Runner = realExecFileSync): boolean {
  const state = readContainerState();

  if (state.builtHash !== buildInputsHash()) return true;

  try {
    run("docker", ["image", "inspect", IMAGE_TAG]);
    return false;
  } catch {
    return true;
  }
}

export function buildImage(run: Runner = realExecFileSync): void {
  run("docker", [
    "build",
    "-t",
    IMAGE_TAG,
    "-f",
    dockerfilePath(),
    dirname(dockerfilePath()),
  ]);

  writeContainerState({
    ...readContainerState(),
    builtHash: buildInputsHash(),
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
    needsBuild?: (run: Runner) => boolean;
    logLine?: (line: string) => void;
  } = {},
): void {
  const run = opts.run ?? realExecFileSync;
  const needsBuild = opts.needsBuild ?? imageNeedsBuild;
  const logLine = opts.logLine ?? ((line: string) => console.log(line));

  compile();

  if (!needsBuild(run)) return;

  logLine(
    "building the chat-mcp-agent image (sources, Dockerfile or image changed)...",
  );
  buildImage(run);
}

export function isConfirmed(handle: string): boolean {
  return readContainerState().confirmed[handle] === true;
}

export function markConfirmed(handle: string): void {
  const state = readContainerState();
  writeContainerState({
    ...state,
    confirmed: { ...state.confirmed, [handle]: true },
  });
}

export function describePlan(plan: ContainerPlan): string {
  return [
    "This will run the agent inside a Docker container:",
    `  mounts: ${plan.mountPaths.join(", ")}`,
    `  env vars (names only): ${plan.envVarNames.join(", ")}`,
    `  binary: ${plan.binary}`,
    `  network: ${plan.networkMode}`,
    `  image: ${plan.image}`,
  ].join("\n");
}
