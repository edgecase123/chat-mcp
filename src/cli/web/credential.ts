import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 🛑 THE TOKEN IS NEVER WRITTEN UNDER `stateDir()`. The whole state dir is
 * bind-mounted read-write into every containerized agent, and a container runs
 * as root, so a 0600 file there is readable by the thing the credential exists
 * to refuse. It is printed in the terminal banner and handed to the browser,
 * and `web-url` stays tokenless.
 */
export const COOKIE_NAME = 'chat_mcp_api';

/** The query parameter that carries the token on the browser's first load. */
export const HANDSHAKE_PARAM = 't';

export type Capability = 'read' | 'write' | 'admin';

/** Every capability, for the operator's own browser. */
export const ALL_CAPABILITIES: readonly Capability[] = ['read', 'write', 'admin'];

export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The capability an API route demands, or null when the path is not an API
 * route at all.
 *
 * 🛑 THE DEFAULT FOR AN UNLISTED `/api/` PATH IS `admin`, NOT `read`. A new
 * endpoint that nobody remembered to classify must start at the most
 * restrictive level rather than the least.
 */
export function requiredCapability(method: string, path: string): Capability | null {
  if (!path.startsWith('/api/')) return null;

  if (ADMIN_ROUTES.has(path)) return 'admin';
  if (method === 'GET' || method === 'HEAD') return 'read';
  if (WRITE_ROUTES.has(path)) return 'write';

  return 'admin';
}

/**
 * Answering an approval, removing an agent and deleting a room. Ranked above
 * the rest because answering an approval is the one that grants a supervisor a
 * permission the operator never clicked.
 */
const ADMIN_ROUTES: ReadonlySet<string> = new Set([
  '/api/approvals/answer',
  '/api/kick',
  '/api/rooms/delete',
]);

const WRITE_ROUTES: ReadonlySet<string> = new Set([
  '/api/messages',
  '/api/messages/clear',
  '/api/rooms/join',
  '/api/rooms/leave',
  '/api/rooms/read',
  '/api/rooms/style',
]);

/** Constant-time compare that does not leak the expected length. */
export function tokenMatches(expected: string, presented: string | null): boolean {
  if (presented === null) return false;

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');

  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

/**
 * Read one cookie out of a `Cookie` header.
 *
 * ⚠️ A value is NOT url-decoded. The token is base64url, which has nothing to
 * decode, and decoding here would accept `%2B` for a token containing `+`.
 */
export function cookieValue(header: string | undefined, name: string): string | null {
  if (!header) return null;

  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() !== name) continue;

    return pair.slice(eq + 1).trim();
  }

  return null;
}

/**
 * The `Set-Cookie` value handed back on a successful handshake.
 *
 * `HttpOnly` keeps it out of page script, `SameSite=Strict` keeps it off every
 * cross-site request, and the absent `Max-Age` makes it a session cookie so it
 * dies with the browser rather than outliving the server that minted it.
 */
export function sessionCookie(token: string): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}
