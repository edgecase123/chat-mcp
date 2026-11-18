/**
 * The restart threshold a supervised agent's context fill is measured against.
 *
 * lee ruled the shape on 2026-11-09 — *"Global default with per-handle
 * override"*, default *"50"* — so resolution has three layers:
 *
 *   handle override  (agents.context_gate)
 *   global default   (settings.context_gate)
 *   built-in         (DEFAULT_CONTEXT_GATE)
 *
 * 🛑 EVERY LAYER IS VALIDATED ON READ, NOT ONLY ON WRITE. The setters are not
 * the only writers this value has: a hand-edited database, a restored backup
 * and a future migration all reach the same two places. A gate the setters
 * would have refused must not be honoured just because it is already stored.
 *
 * 🛑 A STORED 0 WOULD RESTART EVERY AGENT ON ITS FIRST TURN, and a stored 101
 * would never restart one. Both are worse outcomes than the default, so an
 * invalid layer is SKIPPED and the next one down answers.
 *
 * ⚠️ POLICY ONLY. The table writes live in `dao.ts`, where the
 * writer-identity guard can see them.
 */
import type { Db } from "./db.js";
import {
  getAgent,
  getSetting,
  setAgentContextGate,
  setSetting,
} from "./dao.js";

/** lee's ruling of 2026-11-09. */
export const DEFAULT_CONTEXT_GATE = 50;

/** The `settings` key holding the global default. */
export const CONTEXT_GATE_KEY = "context_gate";

/**
 * A percentage a restart may legally fire at.
 *
 * 1..100 rather than 0..100: a gate of 0 fires before the agent has done
 * anything, which is a restart loop and not a threshold.
 */
function isLegalGate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 100
  );
}

function assertLegalGate(value: number, where: string): void {
  if (!isLegalGate(value)) {
    throw new Error(
      `${where}: a context gate must be a whole percentage from 1 to 100, got ${value}`,
    );
  }
}

/**
 * The global default, or null when it is unset OR unreadable.
 *
 * ⚠️ UNREADABLE AND UNSET ARE THE SAME ANSWER ON PURPOSE. A caller cannot act
 * differently on a corrupt value than on a missing one — both mean "this layer
 * does not have a usable number" — and collapsing them keeps the fallback in
 * one place.
 */
export function getGlobalContextGate(db: Db): number | null {
  const raw = getSetting(db, CONTEXT_GATE_KEY);
  if (raw == null) return null;

  const parsed = Number(raw);
  return isLegalGate(parsed) ? parsed : null;
}

/** Set the global default every handle without an override follows. */
export function setGlobalContextGate(db: Db, gate: number): void {
  assertLegalGate(gate, "setGlobalContextGate");

  setSetting(db, CONTEXT_GATE_KEY, String(gate));
}

/**
 * Set or clear one handle's override.
 *
 * `null` clears it, returning the handle to the global default.
 */
export function setHandleContextGate(
  db: Db,
  handle: string,
  gate: number | null,
): void {
  if (gate !== null) assertLegalGate(gate, "setHandleContextGate");

  setAgentContextGate(db, handle, gate);
}

/**
 * The threshold `handle` is measured against right now.
 *
 * 🛑 NEVER THROWS, AND NEVER RETURNS AN ILLEGAL NUMBER. The supervisor calls
 * this on a hot path, so a handle with no `agents` row — one registering, or
 * one already pruned — resolves to the global rather than failing.
 */
export function resolveContextGate(db: Db, handle: string): number {
  const own = getAgent(db, handle)?.context_gate;
  if (isLegalGate(own)) return own;

  return getGlobalContextGate(db) ?? DEFAULT_CONTEXT_GATE;
}

/** Which of the three layers answered `resolveContextGate` for `handle`. */
export type ContextGateSource = "override" | "global" | "builtin";

/**
 * The layer `handle`'s gate came from.
 *
 * 🛑 THE OPERATOR CANNOT SEE THE DIFFERENCE FROM THE NUMBER ALONE. A handle
 * showing 50 may be overridden to 50, following a global 50, or on the
 * built-in — and clearing an override only does something in the first case.
 *
 * ⚠️ THE LAYER TESTS MUST MATCH `resolveContextGate`'s, CLAUSE FOR CLAUSE. An
 * override that is present but ILLEGAL is skipped there, so it must read as
 * `global` here and not as `override`.
 */
export function contextGateSource(db: Db, handle: string): ContextGateSource {
  if (isLegalGate(getAgent(db, handle)?.context_gate)) return "override";

  return getGlobalContextGate(db) === null ? "builtin" : "global";
}
