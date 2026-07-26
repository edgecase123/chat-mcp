/**
 * Naming conventions for chat-mcp identifiers.
 *
 * Handles and room names live in the same DAO column (`messages.to_handle`),
 * so they must be distinguishable. Convention: room names always start with
 * `#`; handles never do.
 */

const HANDLE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
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

export function assertHandle(s: string): void {
  if (!isHandle(s)) {
    throw new Error(
      `Invalid handle "${s}". Handles must match [a-zA-Z0-9][a-zA-Z0-9_-]{0,63} (no # prefix).`,
    );
  }
}
