import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { migrate } from "../../../src/storage/db.js";
import * as dao from "../../../src/storage/dao.js";
import { route, type RouteContext } from "../../../src/cli/web/server.js";
import {
  ALL_CAPABILITIES,
  COOKIE_NAME,
  cookieValue,
  mintToken,
  ADMIN_ROUTES,
  CLASSIFIED_PATHS,
  READ_ROUTES,
  requiredCapability,
  tokenMatches,
  type Capability,
} from "../../../src/cli/web/credential.js";

/**
 * 🛑 THE BIND ADDRESS WAS THE ONLY THING AUTHORIZING THIS API, AND IT IS NOT AN
 * AUTHORIZATION DECISION. A container reaches the host's `127.0.0.1` through
 * `host.docker.internal`, which Docker Desktop proxies from the host side —
 * measured on #162 by approving a `Bash(rm -rf:*)` grant from inside one.
 *
 * So the refusals below assert the STATUS and, where the route destroys
 * something, that the target survived. A 401 that already answered the
 * approval is not a 401.
 */

const TOKEN = "token-for-credential-tests";

interface Harness {
  readonly db: DatabaseSync;
  readonly server: Server;
  readonly origin: string;
}

async function harness(
  capabilities: readonly Capability[] = ALL_CAPABILITIES,
): Promise<Harness> {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  for (const h of ["operator", "peer-a"]) {
    dao.upsertAgent(db, {
      handle: h,
      pid: 1,
      session_id: h,
      display_name: h,
      metadata: {},
    });
  }

  const ctx: RouteContext = {
    handle: "operator",
    db,
    sseClients: new Set(),
    port: 0,
    token: TOKEN,
    capabilities,
  };
  const server = createServer((req, res) => {
    void route(req, res, ctx);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  ctx.port = port;

  return { db, server, origin: `http://127.0.0.1:${port}` };
}

function close(h: Harness): void {
  h.server.closeAllConnections();
  h.server.close();
  h.db.close();
}

const COOKIE = `${COOKIE_NAME}=${TOKEN}`;

// ── The guard itself ─────────────────────────────────────────────────────

test("🛑 an api read with NO credential is refused", async (t) => {
  const h = await harness();
  t.after(() => close(h));
  const res = await fetch(`${h.origin}/api/whoami`);

  assert.equal(res.status, 401);
});

test("⚠️ control — the SAME read succeeds once the credential is presented", async (t) => {
  const h = await harness();
  t.after(() => close(h));
  const res = await fetch(`${h.origin}/api/whoami`, {
    headers: { Cookie: COOKIE },
  });

  assert.equal(res.status, 200);
});

test("🛑 an uncredentialed approval answer is refused AND the approval survives unanswered", async (t) => {
  const h = await harness();
  t.after(() => close(h));
  const id = dao.insertApproval(h.db, {
    agentHandle: "peer-a",
    supervisorHandle: "operator",
    requested: "Bash(rm -rf /)",
    grant: "Bash(rm -rf:*)",
    reason: "the #162 round trip",
  });

  const res = await fetch(`${h.origin}/api/approvals/answer`, {
    method: "POST",
    headers: { Origin: h.origin },
    body: JSON.stringify({ id, decision: "approve" }),
  });

  assert.equal(res.status, 401);
  // THE POINT. A refusal that already granted the permission is not a refusal.
  assert.equal(dao.getApproval(h.db, id)?.decision, null);
  assert.equal(dao.getApproval(h.db, id)?.answeredAt, null);
});

test("a wrong credential is refused, not just a missing one", async (t) => {
  const h = await harness();
  t.after(() => close(h));
  const res = await fetch(`${h.origin}/api/whoami`, {
    headers: { Cookie: `${COOKIE_NAME}=${mintToken()}` },
  });

  assert.equal(res.status, 401);
});

// ── The handshake ────────────────────────────────────────────────────────

test("the handshake trades the token for a cookie and redirects it out of the url", async (t) => {
  const h = await harness();
  t.after(() => close(h));
  const res = await fetch(`${h.origin}/?t=${TOKEN}`, { redirect: "manual" });

  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/");
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, new RegExp(`${COOKIE_NAME}=${TOKEN}`));
  // 🛑 BOTH FLAGS OR THE COOKIE IS READABLE BY PAGE SCRIPT AND RIDES
  // CROSS-SITE REQUESTS.
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
});

test("a handshake with the wrong token sets no cookie", async (t) => {
  const h = await harness();
  t.after(() => close(h));
  const res = await fetch(`${h.origin}/?t=${mintToken()}`, {
    redirect: "manual",
  });

  assert.equal(res.status, 401);
  assert.equal(res.headers.get("set-cookie"), null);
});

// ── Per-route scoping ────────────────────────────────────────────────────

test("🛑 a read-only credential cannot answer an approval, and the approval survives", async (t) => {
  const h = await harness(["read"]);
  t.after(() => close(h));
  const id = dao.insertApproval(h.db, {
    agentHandle: "peer-a",
    supervisorHandle: "operator",
    requested: "Bash(rm -rf /)",
    grant: "Bash(rm -rf:*)",
    reason: "scoping",
  });

  const res = await fetch(`${h.origin}/api/approvals/answer`, {
    method: "POST",
    headers: { Origin: h.origin, Cookie: COOKIE },
    body: JSON.stringify({ id, decision: "approve" }),
  });

  assert.equal(res.status, 403);
  assert.equal(dao.getApproval(h.db, id)?.decision, null);
});

test("🛑 a read-only credential cannot post a message either", async (t) => {
  const h = await harness(["read"]);
  t.after(() => close(h));
  const before = dao.totalUnreadFor(h.db, "peer-a");

  const res = await fetch(`${h.origin}/api/messages`, {
    method: "POST",
    headers: { Origin: h.origin, Cookie: COOKIE },
    body: JSON.stringify({ target: "peer-a", body: "should not land" }),
  });

  assert.equal(res.status, 403);
  assert.equal(
    dao.totalUnreadFor(h.db, "peer-a"),
    before,
    "a refused post still delivered",
  );
});

test("a read-only credential still reads", async (t) => {
  const h = await harness(["read"]);
  t.after(() => close(h));
  const res = await fetch(`${h.origin}/api/whoami`, {
    headers: { Cookie: COOKIE },
  });

  assert.equal(res.status, 200);
});

// ── The capability table ─────────────────────────────────────────────────

/**
 * 🛑 ALL FOUR QUADRANTS. The first cut of this test asserted only POST and
 * DELETE, and the code returned `read` for an unlisted GET — the exact
 * inversion of the docblock beside it. An absence-test that only probes the
 * verbs you already handled cannot fail. Found by claude2 on PR #165.
 */
test("🛑 an UNLISTED api route is admin for EVERY method, reads included", () => {
  for (const m of ["GET", "HEAD", "POST", "DELETE", "PUT", "PATCH"]) {
    assert.equal(
      requiredCapability(m, "/api/something-nobody-classified"),
      "admin",
      `${m} on an unclassified path must not be cheaper than admin`,
    );
  }
});

test("🛑 a GET on a path that only accepts writes is admin, not read", () => {
  assert.equal(requiredCapability("GET", "/api/rooms/read"), "admin");
  assert.equal(requiredCapability("GET", "/api/messages/clear"), "admin");
  assert.equal(requiredCapability("GET", "/api/rooms/join"), "admin");
});

test("every path in READ_ROUTES resolves to read", () => {
  for (const p of [
    "/api/whoami",
    "/api/messages",
    "/api/approvals",
    "/api/claims",
    "/api/search",
    "/api/files",
    "/api/events",
  ]) {
    assert.equal(requiredCapability("GET", p), "read", p);
  }
});

/**
 * 🛑 THIS READS THE DISPATCH TABLE. The test above restates a constant, which
 * is why it is now named for the constant: claude2 added one unclassified GET
 * route to `server.ts` on `c2c0249` and the whole suite stayed green.
 *
 * ⚠️ A RETURN VALUE CANNOT ANSWER THIS. The fallback and `ADMIN_ROUTES` both
 * say `admin`, so a forgotten route is indistinguishable from a deliberate
 * one. Membership in `CLASSIFIED_PATHS` is the test.
 *
 * The denominator is asserted, not implied — a regex that stops matching would
 * otherwise pass this with an empty list.
 */
/**
 * The GETs that are deliberately `admin` rather than `read`.
 *
 * 🛑 ENUMERATED, NOT INFERRED FROM THE VERB, which is the rule
 * `requiredCapability` already carries: "AN UNLISTED `/api/` PATH IS `admin`
 * FOR EVERY METHOD, READS INCLUDED." Every GET outside this list must still be
 * `read`, so locking a read surface by dropping it into `ADMIN_ROUTES` alone
 * is still a failure here.
 *
 * 🛑 A PATH JOINS THIS LIST WITH A REASON, NEVER TO MAKE THE TEST PASS.
 * `/api/agents/plan` names mount paths, env var names and the image, which
 * together are a map of what the container is handed — #132 slice 4b.
 */
const ADMIN_GETS: ReadonlySet<string> = new Set(["/api/agents/plan"]);

test("🛑 EVERY api path in the dispatch table is classified, and the count is stated", () => {
  const src = readFileSync(
    new URL("../../../src/cli/web/server.ts", import.meta.url),
    "utf8",
  );

  const dispatched = new Map<string, Set<string>>();

  for (const m of src.matchAll(
    /path === ['"](\/api\/[^'"]*)['"](?:\s*&&\s*req\.method === ['"]([A-Z]+)['"])?/g,
  )) {
    const path = m[1]!;
    // No method clause means the route answers ANY verb, so GET reaches it.
    const method = m[2] ?? "GET";
    (dispatched.get(path) ?? dispatched.set(path, new Set()).get(path)!).add(
      method,
    );
  }

  assert.ok(
    dispatched.size >= 15,
    `only ${dispatched.size} api paths matched; the regex has stopped reading the table`,
  );

  const unclassified = [...dispatched.keys()].filter(
    (p) => !CLASSIFIED_PATHS.has(p),
  );
  assert.deepEqual(
    unclassified,
    [],
    "these api routes exist but no tier names them, so they fell to the admin fallback",
  );

  // 🛑 A STALE ENTRY WOULD SILENTLY WEAKEN THE LOOP BELOW. A path that left the
  // dispatch table but stayed on this list excuses a tier nothing serves.
  for (const path of ADMIN_GETS) {
    assert.ok(
      dispatched.get(path)?.has("GET"),
      `${path} is listed as a deliberate admin GET but the table has no GET on it`,
    );
  }

  for (const [path, methods] of dispatched) {
    for (const method of methods) {
      const tier = requiredCapability(method, path);
      assert.notEqual(tier, null, `${method} ${path} must need a capability`);
      if (method === "GET" || method === "HEAD") {
        const deliberate = ADMIN_GETS.has(path);
        assert.equal(
          tier,
          deliberate ? "admin" : "read",
          deliberate
            ? `${method} ${path} is named as a deliberate admin GET`
            : `${method} ${path} is a read surface`,
        );
      }
    }
  }
});

test("the three destructive routes are admin, and the ordinary writes are not", () => {
  for (const p of ["/api/approvals/answer", "/api/kick", "/api/rooms/delete"]) {
    assert.equal(requiredCapability("POST", p), "admin", p);
  }
  for (const p of ["/api/messages", "/api/rooms/join", "/api/rooms/read"]) {
    assert.equal(requiredCapability("POST", p), "write", p);
  }
});

test("a non-api path needs nothing", () => {
  assert.equal(requiredCapability("GET", "/"), null);
  assert.equal(requiredCapability("GET", "/assets/app.js"), null);
  assert.equal(requiredCapability("POST", "/"), null);
});

// ── The primitives ───────────────────────────────────────────────────────

test("tokenMatches refuses null, a prefix, and a longer string", () => {
  assert.equal(tokenMatches("abcdef", "abcdef"), true);
  assert.equal(tokenMatches("abcdef", null), false);
  assert.equal(tokenMatches("abcdef", "abc"), false);
  assert.equal(tokenMatches("abcdef", "abcdefg"), false);
  assert.equal(tokenMatches("abcdef", ""), false);
});

test("cookieValue finds its name among others and does not match a suffix", () => {
  assert.equal(cookieValue("a=1; chat_mcp_api=xyz; b=2", COOKIE_NAME), "xyz");
  assert.equal(cookieValue("chat_mcp_api=xyz", COOKIE_NAME), "xyz");
  assert.equal(cookieValue("not_chat_mcp_api=xyz", COOKIE_NAME), null);
  assert.equal(cookieValue(undefined, COOKIE_NAME), null);
});

// ── The storage rule the credential depends on ───────────────────────────

/**
 * 🛑 THIS FILE IS READ BY EXTERNAL SCRIPTS AND MUST STAY PLAIN. The guard below
 * still holds; its ORIGINAL REASON no longer does, so do not re-derive the rule
 * from the old one.
 *
 * ⚠️ WHAT CHANGED. The reason used to be: the whole state dir is bind-mounted
 * read-write into every containerized agent, and a container runs as root —
 * measured on #162, a 0600 host file read straight out of the mount. **That is
 * no longer true.** Re-measured 2026-11-14 against the mount set `dockerRunPlan`
 * actually builds, which is `/work` plus one configured extra mount at
 * `/mnt/<key>` and nothing else:
 *
 *   ls /Users/leejenkins/.chat-mcp      ->  No such file or directory
 *   mount | grep chat-mcp               ->  (none)
 *   ls /host_mark                       ->  No such file or directory
 *   ls /work/..                         ->  the CONTAINER root, not the host
 *   find / -maxdepth 6 -name .chat-mcp  ->  (nothing)
 *
 * `assertProjectDirOutsideState` in `containment.ts` is what closed it: it
 * refuses any project dir or registered mount overlapping the state dir.
 *
 * 🛑 SO THE CREDENTIAL NOW *DOES* LIVE UNDER `stateDir()`, in a SEPARATE 0600
 * file. See `webHandshakeFile()` and `test/cli/web/handshake-file.test.ts`. The
 * reason THIS file stays tokenless is now about its READERS, not about
 * containers: `web-url` is the well-known plain url, and a container is still
 * told to reach the server through it.
 *
 * Asserted against the source because the swap is a ONE-WORD edit that no
 * behavioural test of the server would notice.
 */
test("🛑 the well-known url file is written WITHOUT the token", () => {
  const src = readFileSync(
    new URL("../../../src/cli/web/server.ts", import.meta.url),
    "utf8",
  );

  const writes = src
    .split("\n")
    .filter((l) => l.includes("writeFile(webUrlFile()"));

  assert.equal(
    writes.length,
    1,
    "one write to the well-known file; find them all before trusting this",
  );
  assert.doesNotMatch(
    writes[0]!,
    /handshakeUrl|token/,
    "the well-known file is readable from inside a container; it must carry the plain url",
  );
});

// ── #132 slice 3 — the agents registration surface ───────────────────────

/**
 * 🛑 THE ADMIN TIER IS METHOD-BLIND EVERYWHERE ELSE, AND `/api/agents` IS THE
 * ONE EXCEPTION. `requiredCapability` checks `ADMIN_ROUTES` before any method
 * test, so a path in ADMIN and READ would answer `admin` to a GET. Listing the
 * registered pairs is a read; writing one is not.
 */
test("🛑 GET /api/agents is read, and writing a registration is admin", () => {
  assert.equal(requiredCapability("GET", "/api/agents"), "read");
  assert.equal(requiredCapability("POST", "/api/agents"), "admin");
  assert.equal(requiredCapability("POST", "/api/agents/forget"), "admin");
});

/**
 * 🛑 THE EXCEPTION IS ENUMERATED, NOT EMERGENT. The clause that lets a GET
 * reach `read` on an ADMIN path is `!(reading && READ_ROUTES.has(path))`, so
 * READ_ROUTES can DOWNGRADE any admin route it names — and the docblock above
 * `requiredCapability` promises the opposite.
 *
 * ⚠️ THE PROTECTION IS THIS EMPTY INTERSECTION, NOT THE `admin` FALLBACK. For
 * an ADMIN path absent from READ the clause returns `admin` from the ADMIN
 * line itself and the fallback never runs. claude1 asserted the fallback;
 * claude2 corrected it on the plan review.
 *
 * So adding `/api/context-gate` to READ_ROUTES to let the UI display the gate
 * would silently drop it to `read`. That goes RED here instead.
 */
test("🛑 exactly ONE path is in both ADMIN_ROUTES and READ_ROUTES", () => {
  const overlap = [...ADMIN_ROUTES].filter((p) => READ_ROUTES.has(p)).sort();

  assert.deepEqual(
    overlap,
    ["/api/agents"],
    "a second admin route named by READ_ROUTES is downgraded to read on GET",
  );
});
