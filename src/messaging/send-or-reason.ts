import { MessageNotPersistedError } from '../storage/dao.js';

export type SendOutcome<T> = { sent: T } | { reason: string };

/**
 * Run a send and turn a non-persisting one into a reason the caller can print.
 *
 * 🛑 FOR INTERACTIVE SURFACES ONLY — the TUI and the REPL, which must stay up
 * and report in-band. A oneshot command and an MCP tool let the throw OUT
 * instead: a non-zero exit and a tool error are already loud, and catching it
 * everywhere would restore the silence #138 exists to remove.
 *
 * Takes a thunk because the two surfaces send through different functions,
 * `insertMessage` for a DM and `sendToRoom` for a room.
 */
export function sendOrReason<T>(send: () => T): SendOutcome<T> {
  try {
    return { sent: send() };
  } catch (e) {
    if (e instanceof MessageNotPersistedError) return { reason: e.message };
    throw e;
  }
}
