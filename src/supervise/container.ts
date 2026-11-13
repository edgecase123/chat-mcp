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
 * The build context the Dockerfile copies in. `docker build` is handed
 * `dirname(dockerfilePath())`, so `dist` is resolved against the same root.
 */
function distPath(): string {
  return join(dirname(dockerfilePath()), 'dist');
}

/**
 * 🛑 THE DOCKERFILE ALONE IS NOT WHAT THE IMAGE CONTAINS. It says
 * `COPY dist ./dist`, so the image is mostly BUILT CODE that the Dockerfile's
 * own bytes never change. Hashing only the Dockerfile reported an image built
 * before three merges as current, and the container then ran a `dist` with no
 * HTTP bus in it at all — `agents start` came up and answered nothing.
 *
 * 🛑 CONTENT, NOT MTIME. A rebuild that writes identical bytes must not force
 * a docker build, and a stale `dist` restored with a fresh mtime must not pass.
 */
export function buildInputsHash(root: string = distPath()): string {
  const hash = createHash('sha256');

  hash.update(readFileSync(dockerfilePath()));

  if (!existsSync(root)) {
    // A distinct value, so "no dist" can never collide with a built state.
    return hash.update('\0no-dist').digest('hex');
  }

  const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((rel) => statSync(join(root, rel)).isFile())
    .sort();

  for (const rel of files) {
    hash.update(`\0${rel}\0`);
    hash.update(readFileSync(join(root, rel)));
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
