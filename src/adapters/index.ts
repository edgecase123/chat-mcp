import { claudeCodeAdapter } from "./claude-code.js";
import { claudeCodeContextAdapter } from "./claude-code-context.js";
import { cursorAdapter } from "./cursor.js";
import type { Adapter, AdapterInstallOptions, AdapterResult } from "./types.js";
import type { VendorSpawn } from "../supervise/vendor.js";

const REGISTRY: readonly Adapter[] = [
  claudeCodeAdapter,
  claudeCodeContextAdapter,
  cursorAdapter,
];

export function listAdapters(): readonly Adapter[] {
  return REGISTRY;
}

export function getAdapter(name: string): Adapter {
  const found = REGISTRY.find((a) => a.name === name);
  if (!found) {
    const known = REGISTRY.map((a) => a.name).join(", ");
    throw new Error(`Unknown framework "${name}". Available: ${known}`);
  }
  return found;
}

export async function runInstall(
  name: string,
  opts: AdapterInstallOptions,
): Promise<AdapterResult> {
  return getAdapter(name).install(opts);
}

export async function runUninstall(
  name: string,
  opts: AdapterInstallOptions,
): Promise<AdapterResult> {
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
      `vendor "${vendor}" cannot be spawned by this build; it has: ${vendorsWithSpawn().join(", ")}`,
    );
  }

  return found;
}

/**
 * Whether `vendor` reports a context window, or `null` when this build has no
 * spawn contract for it (#371).
 *
 * 🛑 THREE ANSWERS, AND `null` IS NOT `false`. "This CLI reports no context
 * window" is a fact an operator can act on; "I do not know what this is" is
 * not, and rendering the second as the first puts a confident label on the one
 * case we cannot see.
 *
 * 🛑 NON-THROWING, UNLIKE `spawnFor`, AND THAT IS THE WHOLE POINT OF A SECOND
 * FUNCTION. `vendor` reaches here from `agents.json`, which the operator edits
 * by hand and which `registerAgent` deliberately does NOT check for
 * spawnability — `handleRegistrations` records that `spawnFor` is what throws,
 * at start time. A display label asking the same question must not be able to
 * take a whole list's response down with it. Raised by claude1 on #371, as the
 * same shape as the `.DS_Store` 500 on PR 296.
 */
export function reportsContextFor(vendor: string): boolean | null {
  return (
    REGISTRY.find((a) => a.vendor === vendor && a.spawn)?.spawn
      ?.reportsContext ?? null
  );
}

/**
 * Which stop mode `vendor` gets when the caller names none (#415).
 *
 * 🛑 `now` FOR A VENDOR THAT RUNS ONE PROCESS PER TURN. lee made `graceful`
 * the default on 2026-10-31 because a turn cut mid-stream spends its tokens
 * for nothing. With no turn live that reasoning inverts — graceful queues a
 * shutdown notice, which SPAWNS a turn and bills it, so it becomes the only
 * mode that spends anything. Ruled 2026-11-24.
 *
 * 🛑 THIS BRANCHES ON A STATIC ADAPTER FLAG, NEVER ON TURN STATE. A
 * server-reported in-flight field was declined on #415, and nothing here needs
 * one: `processPerTurn` says a turn CAN be absent, which is all a default has
 * to know.
 *
 * 🛑 NON-THROWING, LIKE `reportsContextFor` AND UNLIKE `spawnFor`. `vendor`
 * reaches here from operator-edited `agents.json`, so an unknown one is the
 * workflow rather than an anomaly.
 *
 * ⚠️ AN UNKNOWN VENDOR KEEPS `graceful`, WHICH IS TODAY'S BEHAVIOUR. Rejected:
 * answering `now` there. Neither mode is right when the process lifetime is
 * unknown, and preserving the shipped answer is the smaller claim.
 */
export function defaultStopModeFor(vendor: string): "graceful" | "now" {
  return REGISTRY.find((a) => a.vendor === vendor && a.spawn)?.spawn
    ?.processPerTurn
    ? "now"
    : "graceful";
}
