import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentChild, SpawnOptions } from '../child.js';
import type { VendorSpawn } from '../vendor.js';
import { wireAgentChild } from './wiring.js';
import { mountsFor, containerPathFor } from '../mounts.js';
import { readToken } from '../auth.js';
import {
  ensureMcpConfigDir,
  mcpConfigPathFor,
  stateDir,
  writePrivateFileSync,
} from '../../util/paths.js';

export const CONTAINER_PROJECT_DIR = '/work';
const CONTAINER_CHAT_MCP_ENTRY = '/opt/chat-mcp/dist/index.js';

/**
 * Seconds between `docker stop`'s SIGTERM and SIGKILL. Not a measured figure
 * — lee's chosen default (#149), raised from docker's own 10s default so a
 * session has time to externalize before being cut off. Per-handle
 * overridable via `SpawnOptions.shutdownGraceSeconds`.
 */
export const DEFAULT_SHUTDOWN_GRACE_SECONDS = 60;

export { containerPathFor };

/** Where the bus's state dir lands inside the container, for this vendor. */
export function containerStateDir(vendor: VendorSpawn): string {
  return `${vendor.containerHome}/.chat-mcp`;
}

/**
 * Overwrite this handle's MCP config with CONTAINER-side command/args.
 *
 * Every vendor's container image bundles chat-mcp at the same fixed path, so
 * this is generic plumbing, not vendor-specific — the vendor only decides
 * WHETHER its CLI is pointed at this file for a given mode (`mcpConfigFor`).
 *
 * The file itself is written to the HOST path (`mcpConfigPathFor`), which
 * lives under `stateDir()` and is therefore already bind-mounted into the
 * container — so the content just needs to point at paths that exist
 * INSIDE the container, not at this host process's own node binary.
 */
export function writeContainerMcpConfig(childHandle: string, vendor: VendorSpawn): string {
  ensureMcpConfigDir();
  const hostPath = mcpConfigPathFor(childHandle);
  const config = {
    mcpServers: {
      chat: { command: 'node', args: [CONTAINER_CHAT_MCP_ENTRY, '--handle', childHandle] },
    },
  };
  writePrivateFileSync(hostPath, `${JSON.stringify(config, null, 2)}\n`);

  return `${containerStateDir(vendor)}/mcp/${childHandle}.json`;
}

/**
 * The name `docker run --name` is given, so `kill()` has something to
 * address a `docker stop` to. One supervisor handle runs one container at a
 * time, so the handle alone is a stable, collision-free name.
 */
export function containerNameFor(supervisorHandle: string): string {
  return `chat-mcp-${supervisorHandle}`;
}

/** The one place that validates the field both `dockerArgsForVendor` and `spawnContainerized` need. */
function requireSupervisorHandle(opts: SpawnOptions): string {
  if (!opts.supervisorHandle) {
    throw new Error('a containerized spawn needs opts.supervisorHandle to find its mounts');
  }

  return opts.supervisorHandle;
}

export function dockerArgsForVendor(vendor: VendorSpawn, opts: SpawnOptions): string[] {
  const token = readToken();
  if (!token) {
    throw new Error(
      'no Claude OAuth token on file; run `claude setup-token` on the host, then ' +
        '`chat-mcp auth set-token <token>`',
    );
  }

  const supervisorHandle = requireSupervisorHandle(opts);
  const projectDir = opts.cwd;
  if (!projectDir) {
    throw new Error('a containerized spawn needs a resolved cwd');
  }

  const args = [
    'run',
    '-i',
    '--rm',
    '--name',
    containerNameFor(supervisorHandle),
    '-e',
    `${vendor.authEnvVar}=${token}`,
    '-v',
    `${projectDir}:${CONTAINER_PROJECT_DIR}`,
    '-v',
    `${stateDir()}:${containerStateDir(vendor)}`,
  ];

  for (const [key, hostDir] of Object.entries(mountsFor(supervisorHandle))) {
    args.push('-v', `${hostDir}:${containerPathFor(key)}`);
  }

  args.push('-w', CONTAINER_PROJECT_DIR, vendor.image);
  args.push(opts.binary ?? vendor.binary, ...vendor.argsFor(opts, 'docker'));

  if (opts.grant) {
    args.push('--mcp-config', vendor.mcpConfigFor(opts.grant, 'docker'), '--strict-mcp-config');
  }

  return args;
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
    try {
      execFileSync('docker', ['stop', '-t', String(graceSeconds), name], { stdio: 'ignore' });
    } catch {
      // Already stopped or removed — the expected case on a repeat kill().
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
  const child: ChildProcessWithoutNullStreams = spawn(
    'docker',
    dockerArgsForVendor(vendor, opts),
    { stdio: ['pipe', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;

  const name = containerNameFor(requireSupervisorHandle(opts));
  const graceSeconds = opts.shutdownGraceSeconds ?? DEFAULT_SHUTDOWN_GRACE_SECONDS;

  return wireAgentChild(child, vendor, { stop: dockerStopFor(name, graceSeconds) });
}
