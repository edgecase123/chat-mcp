import type { AgentChild, SpawnOptions } from '../child.js';
import { spawnClaude } from './claude.js';
import { redispatchPrompt as claudeRedispatch, type RedispatchInput } from './claude-redispatch.js';

/**
 * The driver registry: how a CLI name becomes a spawner.
 *
 * 🛑 THIS EXISTS SO ADDING A CLI IS ONE FILE AND ONE LINE. lee, 2026-10-31:
 * *"this should also work with cursor and that abstraction is probably
 * necessary in this logic"*.
 *
 * ⚠️ BEFORE THIS, `startSupervisor` IMPORTED `spawnClaude` BY NAME. Everything
 * else was already behind the seam, so that one line was the whole remaining
 * coupling — and it is the kind that reads as harmless right up to the point
 * somebody has to add a second CLI.
 *
 * A Cursor driver is `drivers/cursor.ts` implementing `AgentChild`, plus its
 * entry here. The queue, the gate, the socket, the allowlist and the
 * re-dispatch template are all untouched by it.
 */
export type DriverName = 'claude';

export type SpawnFn = (opts: SpawnOptions) => AgentChild;

/**
 * Everything a CLI needs to supply.
 *
 * 🛑 `redispatchPrompt` IS PART OF THE DRIVER, not a shared template. A seam
 * test caught it living above the driver: the wording names `--allowedTools`,
 * which is Claude Code's flag, and the 3-of-3 live result that justifies the
 * wording is evidence about that CLI only.
 */
export interface Driver {
  readonly spawn: SpawnFn;
  readonly redispatchPrompt: (input: RedispatchInput) => string;
}

const DRIVERS: Record<DriverName, Driver> = {
  claude: { spawn: spawnClaude, redispatchPrompt: claudeRedispatch },
};

/** Every driver this build knows. */
export const DRIVER_NAMES = Object.keys(DRIVERS) as DriverName[];

/**
 * The spawner for `name`.
 *
 * 🛑 THROWS, AND NAMES WHAT IS AVAILABLE. A silent fallback to Claude would
 * mean asking for Cursor and getting Claude, which looks like Cursor working.
 */
export function driverFor(name: string): Driver {
  const driver = DRIVERS[name as DriverName];

  if (!driver) {
    throw new Error(`unknown agent driver "${name}"; this build has: ${DRIVER_NAMES.join(', ')}`);
  }

  return driver;
}
