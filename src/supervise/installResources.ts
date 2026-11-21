import { assertCpus, assertMemory } from "./overrides.js";
import type { ContainerOverride } from "./overrides.js";

/**
 * The install container's floor, under lee's ruling C on #222 OQ3: it
 * inherits the handle's caps, except a value below the floor is raised.
 *
 * ⚠️ THE VALUES ARE A JUDGEMENT, NOT A MEASUREMENT. `npm ci` is the heaviest
 * thing the container ever does, and an agent capped for its own steady state
 * would make the INSTALL the thing that dies — an OOM kill inside `npm ci`
 * surfaces as a half-written `node_modules` volume, not as a cap error.
 */
export const INSTALL_MEMORY_FLOOR = "1g";
export const INSTALL_CPUS_FLOOR = "1";

const UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  m: 1024 * 1024,
  g: 1024 * 1024 * 1024,
};

/**
 * Docker's own memory forms as a number, so two spellings of one size compare
 * equal. A bare number is bytes, which is what docker reads it as.
 */
export function memoryToBytes(value: string): number {
  const match = /^(\d+)([bkmg])?$/i.exec(value);

  if (match === null) return NaN;

  const unit = match[2]?.toLowerCase();

  return Number(match[1]) * (unit === undefined ? 1 : (UNITS[unit] ?? 1));
}

/**
 * The install container's effective `memory`, floored, or `null` when the
 * handle set none.
 *
 * 🛑 ONE SOURCE FOR THE FLOOR, BECAUSE TWO CONSUMERS READ IT. The install
 * argv and the consent banner must agree about what the install container
 * runs under. They diverged once already: the floor shipped on #346 and the
 * banner line on #349, an hour apart, and nothing compared them — so the
 * banner said `512m` while a container took `1g`.
 *
 * ⚠️ AN ABSENT KEY STAYS ABSENT, RATHER THAN BECOMING THE FLOOR. The floor
 * raises a cap somebody asked for; it does not impose one on an install that
 * was never capped.
 */
export function installMemoryFor(
  override: ContainerOverride | null | undefined,
): string | null {
  const value = override?.memory;

  if (value === undefined) return null;

  // 🛑 CHECKED HERE, BECAUSE THE STORE IS NOT THE ONLY ROUTE IN. An
  // unparseable value compares FALSE against the floor rather than below it,
  // so trusting it would skip the floor instead of raising to it — the
  // fails-open direction.
  const checked = assertMemory(value);

  return memoryToBytes(checked) < memoryToBytes(INSTALL_MEMORY_FLOOR)
    ? INSTALL_MEMORY_FLOOR
    : checked;
}

/** The install container's effective `cpus`, floored. See `installMemoryFor`. */
export function installCpusFor(
  override: ContainerOverride | null | undefined,
): string | null {
  const value = override?.cpus;

  if (value === undefined) return null;

  const checked = assertCpus(value);

  return Number(checked) < Number(INSTALL_CPUS_FLOOR)
    ? INSTALL_CPUS_FLOOR
    : checked;
}

/**
 * The install container's `--memory` / `--cpus` flags, floored.
 *
 * 🛑 THE CALLER MUST PUSH THESE BEFORE THE IMAGE OPERAND. `docker run` hands
 * everything after the image name to the container, so a flag pushed after it
 * reaches `sh` as an unknown argument and the container runs UNCAPPED with no
 * error for the operator to find.
 */
export function installResourceArgs(
  override: ContainerOverride | null | undefined,
): string[] {
  const args: string[] = [];
  const memory = installMemoryFor(override);
  const cpus = installCpusFor(override);

  if (memory !== null) args.push("--memory", memory);
  if (cpus !== null) args.push("--cpus", cpus);

  return args;
}
