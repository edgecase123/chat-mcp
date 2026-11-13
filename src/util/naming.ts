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
