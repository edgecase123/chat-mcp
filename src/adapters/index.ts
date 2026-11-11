import { claudeCodeAdapter } from './claude-code.js';
import { claudeCodeContextAdapter } from './claude-code-context.js';
import type { Adapter, AdapterInstallOptions, AdapterResult } from './types.js';
import type { VendorSpawn } from '../supervise/vendor.js';

const REGISTRY: readonly Adapter[] = [claudeCodeAdapter, claudeCodeContextAdapter];

export function listAdapters(): readonly Adapter[] {
  return REGISTRY;
}

export function getAdapter(name: string): Adapter {
  const found = REGISTRY.find((a) => a.name === name);
  if (!found) {
    const known = REGISTRY.map((a) => a.name).join(', ');
    throw new Error(`Unknown framework "${name}". Available: ${known}`);
  }
  return found;
}

export async function runInstall(name: string, opts: AdapterInstallOptions): Promise<AdapterResult> {
  return getAdapter(name).install(opts);
}

export async function runUninstall(name: string, opts: AdapterInstallOptions): Promise<AdapterResult> {
  return getAdapter(name).uninstall(opts);
}

/** Every vendor this build can spawn. */
export function vendorsWithSpawn(): readonly string[] {
  return [...new Set(REGISTRY.filter((a) => a.spawn).map((a) => a.vendor))];
}

/**
 * The spawn contract for `vendor`.
 *
 * 🛑 THROWS, AND NAMES WHAT IS AVAILABLE: a silent fallback would make a
 * missing vendor look like a working one.
 */
export function spawnFor(vendor: string): VendorSpawn {
  const found = REGISTRY.find((a) => a.vendor === vendor && a.spawn)?.spawn;

  if (!found) {
    throw new Error(
      `vendor "${vendor}" cannot be spawned by this build; it has: ${vendorsWithSpawn().join(', ')}`,
    );
  }

  return found;
}
