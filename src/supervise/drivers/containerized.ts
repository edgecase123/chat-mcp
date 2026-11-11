import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentChild, SpawnOptions } from '../child.js';
import type { VendorSpawn } from '../vendor.js';
import { wireAgentChild } from './wiring.js';
import { mountsFor, containerPathFor } from '../mounts.js';
import { readToken } from '../auth.js';
import { stateDir } from '../../util/paths.js';

export const CONTAINER_PROJECT_DIR = '/work';

export { containerPathFor };

/** Where the bus's state dir lands inside the container, for this vendor. */
export function containerStateDir(vendor: VendorSpawn): string {
  return `${vendor.containerHome}/.chat-mcp`;
}

export function dockerArgsForVendor(vendor: VendorSpawn, opts: SpawnOptions): string[] {
  const token = readToken();
  if (!token) {
    throw new Error(
      'no Claude OAuth token on file; run `claude setup-token` on the host, then ' +
        '`chat-mcp auth set-token <token>`',
    );
  }

  if (!opts.supervisorHandle) {
    throw new Error('a containerized spawn needs opts.supervisorHandle to find its mounts');
  }

  const projectDir = opts.cwd;
  if (!projectDir) {
    throw new Error('a containerized spawn needs a resolved cwd');
  }

  const args = [
    'run',
    '-i',
    '--rm',
    '-e',
    `${vendor.authEnvVar}=${token}`,
    '-v',
    `${projectDir}:${CONTAINER_PROJECT_DIR}`,
    '-v',
    `${stateDir()}:${containerStateDir(vendor)}`,
  ];

  for (const [key, hostDir] of Object.entries(mountsFor(opts.supervisorHandle))) {
    args.push('-v', `${hostDir}:${containerPathFor(key)}`);
  }

  args.push('-w', CONTAINER_PROJECT_DIR, vendor.image);
  args.push(vendor.binary, ...vendor.argsFor(opts, 'docker'));

  if (opts.grant) {
    args.push('--mcp-config', vendor.mcpConfigFor(opts.grant, 'docker'), '--strict-mcp-config');
  }

  return args;
}

/**
 * Spawn a vendor's CLI inside `docker run`.
 *
 * 🛑 ONE `docker run` PROCESS, DRIVEN OVER STDIN AND STDOUT. No `docker exec`,
 * ever — decision 8 of the #129 spec. Removal on kill is proved by
 * `container-removal.test.ts`, not just asserted here.
 */
export function spawnContainerized(vendor: VendorSpawn, opts: SpawnOptions = {}): AgentChild {
  const child: ChildProcessWithoutNullStreams = spawn(
    'docker',
    dockerArgsForVendor(vendor, opts),
    { stdio: ['pipe', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;

  return wireAgentChild(child, vendor);
}
