import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync as realExecFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureStateDir, stateDir, writePrivateFileSync } from '../util/paths.js';

export const IMAGE_TAG = 'chat-mcp-agent:local';

export interface ContainerPlan {
  readonly mountPaths: readonly string[];
  readonly envVarNames: readonly string[];
  readonly binary: string;
  readonly networkMode: string;
}

interface ContainerState {
  builtHash: string | null;
  confirmed: Record<string, boolean>;
}

const EMPTY_STATE: ContainerState = { builtHash: null, confirmed: {} };

function containerStatePath(): string {
  return join(stateDir(), 'container.json');
}

function readContainerState(): ContainerState {
  const path = containerStatePath();

  if (!existsSync(path)) return EMPTY_STATE;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ContainerState>;

    return { builtHash: parsed.builtHash ?? null, confirmed: parsed.confirmed ?? {} };
  } catch {
    console.error(`container state at ${path} is not valid JSON — falling back to empty state`);
    return EMPTY_STATE;
  }
}

function writeContainerState(state: ContainerState): void {
  ensureStateDir();
  writePrivateFileSync(containerStatePath(), `${JSON.stringify(state, null, 2)}\n`);
}

export function dockerfilePath(): string {
  const fromDist = fileURLToPath(new URL('../../Dockerfile', import.meta.url));
  if (existsSync(fromDist)) return fromDist;

  const fromSource = fileURLToPath(new URL('../../../Dockerfile', import.meta.url));
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
export const BUILD_INPUT_PATHS = ['package.json', 'package-lock.json', 'dist'] as const;

/** The build context: `docker build` is handed `dirname(dockerfilePath())`. */
function contextPath(): string {
  return dirname(dockerfilePath());
}

function filesUnder(root: string): string[] {
  if (!statSync(root).isDirectory()) return [''];

  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((rel) => statSync(join(root, rel)).isFile())
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
  const hash = createHash('sha256');

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
      hash.update(`\0${input}/${rel}\0`);
      hash.update(readFileSync(rel ? join(root, rel) : root));
    }
  }

  return hash.digest('hex');
}

type Runner = (cmd: string, args: readonly string[]) => Buffer;

export function imageNeedsBuild(run: Runner = realExecFileSync): boolean {
  const state = readContainerState();

  if (state.builtHash !== buildInputsHash()) return true;

  try {
    run('docker', ['image', 'inspect', IMAGE_TAG]);
    return false;
  } catch {
    return true;
  }
}

export function buildImage(run: Runner = realExecFileSync): void {
  run('docker', ['build', '-t', IMAGE_TAG, '-f', dockerfilePath(), dirname(dockerfilePath())]);

  writeContainerState({ ...readContainerState(), builtHash: buildInputsHash() });
}

export function isConfirmed(handle: string): boolean {
  return readContainerState().confirmed[handle] === true;
}

export function markConfirmed(handle: string): void {
  const state = readContainerState();
  writeContainerState({ ...state, confirmed: { ...state.confirmed, [handle]: true } });
}

export function describePlan(plan: ContainerPlan): string {
  return [
    'This will run the agent inside a Docker container:',
    `  mounts: ${plan.mountPaths.join(', ')}`,
    `  env vars (names only): ${plan.envVarNames.join(', ')}`,
    `  binary: ${plan.binary}`,
    `  network: ${plan.networkMode}`,
  ].join('\n');
}
