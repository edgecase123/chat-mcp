import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentChild, SpawnOptions } from '../child.js';
import type { VendorSpawn } from '../vendor.js';
import { wireAgentChild } from './wiring.js';

/** Spawn a vendor's CLI as a bare host process. */
export function spawnOnHost(vendor: VendorSpawn, opts: SpawnOptions = {}): AgentChild {
  const child: ChildProcessWithoutNullStreams = spawn(
    opts.binary ?? vendor.binary,
    vendor.argsFor(opts, 'host'),
    { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;

  return wireAgentChild(child, vendor);
}
