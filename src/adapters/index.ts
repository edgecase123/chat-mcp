import { claudeCodeAdapter } from './claude-code.js';
import { claudeCodeContextAdapter } from './claude-code-context.js';
import type { Adapter, AdapterInstallOptions, AdapterResult } from './types.js';

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
