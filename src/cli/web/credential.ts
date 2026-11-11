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

/**
 * Every capability, for the operator's own browser.
 *
 * ⚠️ THE ONLY PRODUCTION PRODUCER OF `capabilities`. So the per-route tiers and
 * the 403 they raise are exercised by the tests alone today — no narrower
 * credential is minted yet. This is the groundwork for lee's 2026-11-11
 * ruling that the credential can be scoped per route, not a live restriction.
 */
export const ALL_CAPABILITIES: readonly Capability[] = ['read', 'write', 'admin'];

export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * The capability an API route demands, or null when the path is not an API
 * route at all.
 *
 * 🛑 AN UNLISTED `/api/` PATH IS `admin` FOR EVERY METHOD, READS INCLUDED.
 * Reads are enumerated rather than inferred from the verb: the first cut
 * returned `read` for any GET, so an unclassified endpoint got the LEAST
 * restrictive level while the comment promised the most. Found by claude2
 * reviewing PR #165. The tests pin all four quadrants.
 */
export function requiredCapability(method: string, path: string): Capability | null {
  if (!path.startsWith('/api/')) return null;

  const reading = method === 'GET' || method === 'HEAD';

  if (ADMIN_ROUTES.has(path)) return 'admin';
  if (WRITE_ROUTES.has(path) && !reading) return 'write';
  if (READ_ROUTES.has(path) && reading) return 'read';

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

/**
 * Every GET surface, enumerated from the dispatch table in `server.ts`.
 *
 * ⚠️ `/api/messages` IS IN HERE AND IN THE WRITES. It is a GET and a POST, so
 * the method decides which tier applies, not the path.
 */
const READ_ROUTES: ReadonlySet<string> = new Set([
  '/api/whoami',
  '/api/messages',
  '/api/approvals',
  '/api/claims',
  '/api/search',
  '/api/files',
  '/api/events',
]);

const WRITE_ROUTES: ReadonlySet<string> = new Set([
  '/api/messages',
  '/api/messages/clear',
  '/api/rooms/join',
  '/api/rooms/leave',
  '/api/rooms/read',
  '/api/rooms/style',
]);

/**
 * Constant-time compare of two equal-length tokens.
 *
 * ⚠️ THE LENGTH IS COMPARED FIRST AND THAT IS NOT CONSTANT TIME. It has to be,
 * because `timingSafeEqual` throws on a length mismatch. Safe here only
 * because the token is always 43 base64url characters, so the length is fixed
 * and public. This comment said "does not leak the expected length", which was
 * a security property the function never had. Found by claude2 on PR #165.
 */
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
