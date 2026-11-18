/**
 * Naming conventions for chat-mcp identifiers.
 *
 * Handles and room names live in the same DAO column (`messages.to_handle`),
 * so they must be distinguishable. Convention: room names always start with
 * `#`; handles never do.
 *
 * 🛑 BOTH ARE LOWERCASE-ONLY, AND FOR A HANDLE THAT IS A SECURITY PROPERTY. A
 * handle becomes a filename in six places and macOS APFS is case-insensitive,
 * so `Alice` and `alice` shared one file and the token store answered one
 * agent with the other's identity. Pinned by `🛑 a handle carrying a CAPITAL
 * is refused`.
 */

const HANDLE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ROOM_RE = /^#[a-z0-9][a-z0-9_-]{0,63}$/;

export function isRoomName(s: string): boolean {
  return ROOM_RE.test(s);
}

export function isHandle(s: string): boolean {
  return HANDLE_RE.test(s);
}

export function assertRoomName(s: string): void {
  if (!isRoomName(s)) {
    throw new Error(
      `Invalid room name "${s}". Rooms must start with # and match [a-z0-9][a-z0-9_-]{0,63}.`,
    );
  }
}

/**
 * The refusal text, in one place.
 *
 * The shim entry point prints this without throwing, so that an operator who
 * mistypes a handle is told what is wrong instead of being shown a crash.
 * Separate copies of the sentence would drift.
 */
export function handleRefusal(s: string): string {
  return `Invalid handle "${s}". Handles must match [a-z0-9][a-z0-9_-]{0,63} (lowercase, no # prefix).`;
}

export function assertHandle(s: string): void {
  if (!isHandle(s)) {
    throw new Error(handleRefusal(s));
  }
}

/**
 * The shared clause for a room name handed to a peer-only send.
 *
 * `nextStep` differs per surface because the surfaces differ: the MCP shim has
 * a `room_send` tool, the one-shot CLI has no room-send verb at all. Only the
 * sentences common to both live here.
 *
 * 🛑 THE CALLER DECIDES ROOM-OR-PEER ON THE `#` PREFIX, NEVER ON
 * `isRoomName`. `isRoomName` decides VALID, and `#Ops` is invalid while being
 * unmistakably a room attempt. `handleMessagesClear` carries a comment about
 * that exact discrimination sending `#Ops` down the DM branch.
 *
 * ⚠️ `isRoomName` IS read below, and that is a different question. It refines
 * the ADVICE once the target is already known to be a room, because
 * `nextStep` tells the reader to use the name they typed and an invalid one
 * is refused again at the next hop. Raised by claude1 on PR 276: a refusal
 * whose advice needs two hops is the same defect this function exists to fix.
 */
export function roomTargetRefusal(
  target: string,
  nextStep: string,
  // The peer-only verb being refused. Defaulted so both send surfaces keep the
  // one sentence `room-target-refusal.test.ts` pins, while `/kick` — which is
  // not a send — can name itself instead of claiming to be one.
  operation = "send",
): string {
  const lower = target.toLowerCase();
  let note = "";
  if (!isRoomName(target)) {
    note = isRoomName(lower)
      ? ` "${target}" is not a valid room name, because rooms are lowercase — the one you want is "${lower}".`
      : ` "${target}" is not a valid room name: after the # it must match [a-z0-9][a-z0-9_-]{0,63}.`;
  }
  return `${target} is a room, and ${operation} is peer-only. ${nextStep}${note}`;
}

/**
 * The refusal for a handle nothing is registered under.
 *
 * 🛑 IT NAMES THE SIBLING IT FOUND, WHICH IS THE WHOLE OF #297. `supervise
 * <handle>` binds the socket as `<handle>` while the child registers as
 * `<handle>-agent`, so an operator who sends to the name they typed gets a
 * refusal that reads exactly like "that agent is not running". There was no
 * way to tell a naming slip from a failed spawn.
 *
 * 🛑 `sibling` IS THE CALLER'S LOOKUP, NOT A GUESS MADE HERE. Only the caller
 * holds the db, and deriving the name is `childHandleFor`'s job — its own
 * docblock says a second copy of the suffix is how the pair drifts.
 *
 * ⚠️ IT DOES NOT REDIRECT THE MESSAGE. The two names address two different
 * processes, so the refusal tells the operator which one they want and stops.
 * Resolving the bare handle to the child is a separate decision.
 *
 * `nextStep` differs per surface for the same reason `roomTargetRefusal`'s
 * does: the MCP shim has `list_agents`, the one-shot CLI has `chat-mcp list`.
 */
export function unknownPeerRefusal(
  target: string,
  sibling: string | null,
  nextStep: string,
): string {
  if (sibling !== null) {
    return (
      `Unknown peer: ${target}, but "${sibling}" IS registered. ` +
      `A supervised agent runs under its child handle, so send to "${sibling}" — ` +
      `"${target}" is the supervisor you started it with.`
    );
  }

  return `Unknown peer: ${target}. ${nextStep}`;
}
