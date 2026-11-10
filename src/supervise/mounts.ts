import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ensureStateDir, stateDir, writePrivateFileSync } from '../util/paths.js';

/**
 * Extra read-write mounts a containerized agent gets, beyond its project
 * clone (which `dirsFor` already covers). Keyed per handle, per a free-form
 * slug the AGENT's own convention gives meaning to — chat-mcp never
 * hardcodes which keys exist. See #129.
 */
export interface MountConfig {
  readonly agents: Record<string, Record<string, string>>;
}

const EMPTY: MountConfig = { agents: {} };

export function mountsPath(): string {
  return join(stateDir(), 'mounts.json');
}

/** A malformed file reads as empty rather than throwing, same as `projects.ts`. */
export function readMounts(): MountConfig {
  const path = mountsPath();

  if (!existsSync(path)) return EMPTY;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<MountConfig>;

    return { agents: parsed.agents ?? {} };
  } catch {
    return EMPTY;
  }
}

/**
 * Register `key` -> `dir` for `handle`. The path must exist and is resolved,
 * same reasoning as `registerProject`: a registration for a directory that
 * is not there would be refused later in a way that reads as a permissions
 * problem rather than a typo.
 */
export function registerMount(
  handle: string,
  key: string,
  dir: string,
): Record<string, string> {
  const abs = resolve(dir);

  if (!existsSync(abs)) {
    throw new Error(
      `cannot mount "${dir}" under key "${key}": no such directory (resolved to ${abs})`,
    );
  }

  const config = readMounts();
  const existing = config.agents[handle] ?? {};
  const agents = { ...config.agents, [handle]: { ...existing, [key]: abs } };

  ensureStateDir();
  writePrivateFileSync(mountsPath(), `${JSON.stringify({ agents }, null, 2)}\n`);

  return agents[handle] as Record<string, string>;
}

/** This handle's extra mounts, or none. */
export function mountsFor(handle: string): Record<string, string> {
  return readMounts().agents[handle] ?? {};
}

/** Where a mount's key lands inside the container. Shared by the driver and the CLI's printed plan. */
export function containerPathFor(key: string): string {
  return `/mnt/${key}`;
}
