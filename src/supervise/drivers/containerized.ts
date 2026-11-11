import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentChild, SpawnOptions } from '../child.js';
import type { VendorSpawn } from '../vendor.js';
import { wireAgentChild } from './wiring.js';
import { mountsFor, containerPathFor } from '../mounts.js';
import { readToken } from '../auth.js';
import { checkedMountPath } from '../containment.js';
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

  // 🛑 BOTH SIDES COME FROM ONE CHECKED VALUE. A host side built from the
  // realpath and a container side built from the raw declared string let a
  // symlink put one directory at two container paths, only one read-only.
  //
  // Order does not matter — measured both ways, the daemon sorts bind
  // destinations. ⚠️ Docker 24.0.7 / macOS, UNRUN ON LINUX.
  for (const entry of opts.readOnlyPaths ?? []) {
    const { host, inner } = checkedMountPath(projectDir, entry, 'read-only path');
    args.push('-v', `${host}:${CONTAINER_PROJECT_DIR}/${inner}:ro`);
  }

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

  const child: ChildProcessWithoutNullStreams = spawn(
    'docker',
    dockerArgsForVendor(vendor, opts),
    { stdio: ['pipe', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;

  const graceSeconds = opts.shutdownGraceSeconds ?? DEFAULT_SHUTDOWN_GRACE_SECONDS;

  return wireAgentChild(child, vendor, {
    stop: dockerStopFor(name, graceSeconds),
    teardown: dockerTeardownFor(name, graceSeconds),
  });
}
