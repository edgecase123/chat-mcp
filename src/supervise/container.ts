import { existsSync, readFileSync } from 'node:fs';
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

function dockerfileHash(): string {
  return createHash('sha256').update(readFileSync(dockerfilePath())).digest('hex');
}

type Runner = (cmd: string, args: readonly string[]) => Buffer;

export function imageNeedsBuild(run: Runner = realExecFileSync): boolean {
  const state = readContainerState();

  if (state.builtHash !== dockerfileHash()) return true;

  try {
    run('docker', ['image', 'inspect', IMAGE_TAG]);
    return false;
  } catch {
    return true;
  }
}

export function buildImage(run: Runner = realExecFileSync): void {
  run('docker', ['build', '-t', IMAGE_TAG, '-f', dockerfilePath(), dirname(dockerfilePath())]);

  writeContainerState({ ...readContainerState(), builtHash: dockerfileHash() });
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
