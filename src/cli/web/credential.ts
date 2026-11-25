import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * 🛑 THE TOKEN IS WRITTEN UNDER `stateDir()`, 0600, AND THAT IS DELIBERATE.
 * This said the opposite, on #162's finding that the whole state dir is
 * bind-mounted into every container. Re-measured 2026-11-14: it is not in the
 * container at all, and `assertProjectDirOutsideState` refuses any mount that
 * overlaps it. Commands and output in `test/cli/web/handshake-file.test.ts`.
 *
 * ⚠️ `web-url` STAYS TOKENLESS — it is the twin external readers expect.
 */
export const COOKIE_NAME = "chat_mcp_api";

/** The query parameter that carries the token on the browser's first load. */
export const HANDSHAKE_PARAM = "t";

export type Capability = "read" | "write" | "admin";

/**
 * Every capability, for the operator's own browser.
 *
 * ⚠️ THE ONLY PRODUCTION PRODUCER OF `capabilities`. So the per-route tiers and
 * the 403 they raise are exercised by the tests alone today — no narrower
 * credential is minted yet. This is the groundwork for lee's 2026-11-11
 * ruling that the credential can be scoped per route, not a live restriction.
 */
export const ALL_CAPABILITIES: readonly Capability[] = [
  "read",
  "write",
  "admin",
];

export function mintToken(): string {
  return randomBytes(32).toString("base64url");
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
 *
 * ⚠️ A PATH IN ADMIN **AND** READ IS `read` ON A GET, AND THAT IS THE ONE
 * EXCEPTION TO THE LINE ABOVE. `/api/agents` needs it: listing the registered
 * pairs is a read, writing one is not. The exception is written here rather
 * than arranged by reordering the three checks, so it cannot later be read as
 * a tidy-up and undone.
 *
 * 🛑 READ_ROUTES CAN THEREFORE DOWNGRADE ANY ADMIN ROUTE IT NAMES, and nothing
 * in this function stops a second one being added. A test pins the
 * intersection to exactly `/api/agents`.
 */
export function requiredCapability(
  method: string,
  path: string,
): Capability | null {
  if (!path.startsWith("/api/")) return null;

  const reading = method === "GET" || method === "HEAD";

  if (ADMIN_ROUTES.has(path) && !(reading && READ_ROUTES.has(path)))
    return "admin";
  if (WRITE_ROUTES.has(path) && !reading) return "write";
  if (READ_ROUTES.has(path) && reading) return "read";

  return "admin";
}

/**
 * Answering an approval, stopping a supervisor, removing an agent, deleting a
 * room, and setting a restart gate. Ranked above the rest because answering an
 * approval is the one that grants a supervisor a permission the operator never
 * clicked.
 *
 * 🛑 A GATE IS HERE AND NOT IN THE WRITES BECAUSE OF ITS CONSEQUENCE. A gate of
 * 1 restarts every agent on its next reading, which is `/api/agents/stop` in
 * slower motion. The supervisor holds a `write` credential and is the thing a
 * gate kills.
 */
export const ADMIN_ROUTES: ReadonlySet<string> = new Set([
  // 🛑 ALSO IN `READ_ROUTES`, SO A GET ON IT IS `read`. The pair decides
  // whether an agent is contained, so writing one is ranked with answering an
  // approval rather than with a pulse.
  "/api/agents",
  // 🛑 THE PLAN IS ADMIN-ONLY ON A GET TOO, so neither of these appears in
  // `READ_ROUTES`. It names mount paths, env var names and the image, which
  // together are a map of what the container is handed.
  "/api/agents/confirm",
  "/api/agents/forget",
  "/api/agents/plan",
  // 🛑 ADMIN, NOT write. It runs an agent CLI on this machine, which is a
  // larger grant than any message a `write` credential can send.
  "/api/agents/start",
  "/api/agents/stop",
  "/api/approvals/answer",
  "/api/context-gate",
  "/api/kick",
  "/api/rooms/delete",
]);

/**
 * Every GET surface, enumerated from the dispatch table in `server.ts`.
 *
 * ⚠️ `/api/messages` IS IN HERE AND IN THE WRITES. It is a GET and a POST, so
 * the method decides which tier applies, not the path.
 */
export const READ_ROUTES: ReadonlySet<string> = new Set([
  // ⚠️ NOT `/api/agents/live`. That one is the socket register — who is
  // connected now. This one is what the operator configured.
  "/api/agents",
  "/api/agents/live",
  "/api/whoami",
  "/api/messages",
  "/api/approvals",
  "/api/claims",
  "/api/search",
  "/api/files",
  "/api/events",
]);

const WRITE_ROUTES: ReadonlySet<string> = new Set([
  // 🛑 CLASSIFIED, BECAUSE THE FALLBACK WOULD MAKE A PULSE AN ADMIN ACTION.
  // An unrecognised /api/* path returns 'admin', which fails closed and is
  // therefore safe and wrong — the supervisor holds a write credential, so an
  // unclassified route silently 403s every pulse. #240.
  "/api/activity",
  "/api/messages",
  "/api/messages/clear",
  "/api/rooms/join",
  "/api/rooms/leave",
  "/api/rooms/read",
  "/api/rooms/style",
]);

/**
 * Every path any tier names, so a test can prove the dispatch table is fully
 * classified rather than restating one of the three sets.
 *
 * 🛑 THE FALLBACK AND `ADMIN_ROUTES` BOTH RETURN `admin`, so a return value
 * cannot tell a classified route from a forgotten one. Membership can.
 */
export const CLASSIFIED_PATHS: ReadonlySet<string> = new Set([
  ...ADMIN_ROUTES,
  ...READ_ROUTES,
  ...WRITE_ROUTES,
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
export function tokenMatches(
  expected: string,
  presented: string | null,
): boolean {
  if (presented === null) return false;

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(presented, "utf8");

  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

/**
 * Read one cookie out of a `Cookie` header.
 *
 * ⚠️ A value is NOT url-decoded. The token is base64url, which has nothing to
 * decode, and decoding here would accept `%2B` for a token containing `+`.
 */
export function cookieValue(
  header: string | undefined,
  name: string,
): string | null {
  if (!header) return null;

  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
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
