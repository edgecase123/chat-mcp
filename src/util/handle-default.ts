import { userInfo } from "node:os";

import { isHandle } from "./naming.js";

/**
 * Where a handle comes from when the operator named none.
 *
 * 🛑 THE OLD DEFAULT WAS THE LITERAL `"user"`, AND IT WAS SHARED. Two
 * operators who both omitted `--handle` were the same peer, so a message
 * addressed to either one's real name reached nobody and the second process
 * to start was refused outright by `refuseLiveRival`.
 */

/** The last resort, for a host whose login name yields no legal handle. */
export const FALLBACK_HANDLE = "user";

/**
 * 🛑 64, NOT 22. #314 proposed 22 on the premise that the socket path leaves
 * only that much room. The measured state dir is `~/.chat-mcp/sock/` at 33
 * bytes against macOS's ~104, so a 64-byte handle fits with room to spare.
 * 64 is `HANDLE_RE`'s own ceiling, which is the limit that actually refuses.
 */
const MAX_HANDLE_LENGTH = 64;

/**
 * Turn an OS login name into a legal handle, or `null` if nothing survives.
 *
 * 🛑 ONLY THE LOGIN NAME IS SANITISED. A handle the operator typed — by flag
 * or by `$CHAT_MCP_HANDLE` — is passed through untouched so an illegal one is
 * refused loudly downstream. Mangling a name someone chose hides their typo;
 * mangling one the OS chose is the whole point.
 */
export function handleFromLoginName(login: string): string | null {
  const candidate = login
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, MAX_HANDLE_LENGTH);

  return isHandle(candidate) ? candidate : null;
}

interface HandleSources {
  /** `--handle`, or undefined when the flag carries no default. */
  flag?: string | undefined;
  /** `$CHAT_MCP_HANDLE`, read by the caller so tests need no env mutation. */
  env?: string | undefined;
  /** Injected for tests. Defaults to the real OS login name. */
  readLogin?: () => string;
}

/** `--handle`, then `$CHAT_MCP_HANDLE`, then the OS login name. */
export function resolveDefaultHandle(sources: HandleSources = {}): string {
  if (sources.flag) return sources.flag;
  if (sources.env) return sources.env;

  return loginHandle(sources.readLogin ?? (() => userInfo().username));
}

/**
 * ⚠️ `userInfo()` THROWS when the host has no login name available, which Node
 * documents. A crash there would be a worse outcome than the shared default
 * this module exists to remove, so the throw falls back.
 */
function loginHandle(readLogin: () => string): string {
  let login: string;
  try {
    login = readLogin();
  } catch {
    return FALLBACK_HANDLE;
  }

  return handleFromLoginName(login) ?? FALLBACK_HANDLE;
}
