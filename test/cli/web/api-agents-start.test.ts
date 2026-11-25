import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  listenWithRoute,
  type RouteServer,
} from "../../support/route-server.js";
import type { RouteContext } from "../../../src/cli/web/server.js";
import type { Capability } from "../../../src/cli/web/credential.js";

// 🛑 BEFORE any import that resolves a state path, and SHORT on purpose. The
// supervisor socket is `<stateDir>/sock/<handle>` and a unix socket path dies
// at 104 bytes, so the live-supervisor fixture below needs the room.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "cm-start-"));

const { migrate } = await import("../../../src/storage/db.js");
const { route } = await import("../../../src/cli/web/server.js");
const { COOKIE_NAME, ALL_CAPABILITIES, ADMIN_ROUTES } =
  await import("../../../src/cli/web/credential.js");
const { registerAgent } =
  await import("../../../src/supervise/registrations.js");
const { registerProject } = await import("../../../src/supervise/projects.js");
const { markConfirmed } = await import("../../../src/supervise/container.js");
const { buildConfirmPlan } =
  await import("../../../src/supervise/confirmPlan.js");
const { spawnFor, vendorsWithSpawn } =
  await import("../../../src/adapters/index.js");
const { missingVendorTokenMessage, setVendorToken } =
  await import("../../../src/supervise/auth.js");
const { WakeListener } = await import("../../../src/supervise/socket.js");
const { logPathFor } = await import("../../../src/util/paths.js");

/**
 * `POST /api/agents/start` — #423 unit A, the route behind the card's Start.
 *
 * 🛑 THE REFUSAL ORDER MIRRORS `startSupervisor`, AND THAT IS THE CONTRACT.
 * The spawn checks its preconditions in one order; a route that answered a
 * different one would name a blocker the spawn would not have hit first, so
 * the operator fixes the wrong thing and earns a second refusal.
 *
 * ```
 * src/supervise/index.ts:293  refuseIfSupervisorLive   already-running
 *                       :356  requireVendorToken       no-vendor-token
 *                       :364  confirmVerdict           plan-unconfirmed
 *                       :392  dirsFor                  no-project-dir
 * ```
 */

const TOKEN = "token-for-the-agents-start-tests";
const COOKIE = `${COOKIE_NAME}=${TOKEN}`;
const START_PATH = "/api/agents/start";

/** A vendor this build can really spawn, so the refusals are the real ones. */
const SPAWNABLE = vendorsWithSpawn()[0];
const VENDOR = spawnFor(SPAWNABLE);

/** Somewhere that exists, because `registerProject` refuses one that does not. */
const PROJECT_DIR = mkdtempSync(join(tmpdir(), "cm-start-proj-"));

interface Harness {
  readonly db: DatabaseSync;
  readonly listening: RouteServer;
  readonly origin: string;
}

async function harness(
  capabilities: readonly Capability[] = ALL_CAPABILITIES,
): Promise<Harness> {
  const db = new DatabaseSync(":memory:");
  migrate(db);

  const ctx: RouteContext = {
    handle: "operator",
    db,
    sseClients: new Set(),
    port: 0,
    token: TOKEN,
    capabilities,
  };
  const listening = await listenWithRoute(route, ctx);
  ctx.port = listening.port;

  return { db, listening, origin: listening.origin };
}

function close(h: Harness): void {
  h.listening.close();
  h.db.close();
}

async function postStart(h: Harness, body: unknown): Promise<Response> {
  return fetch(`${h.origin}${START_PATH}`, {
    method: "POST",
    headers: { Cookie: COOKIE, Origin: h.origin },
    body: JSON.stringify(body),
  });
}

interface Refusal {
  error: string;
  message: string;
}

/** Short, because the handle becomes part of a unix socket path. */
let seq = 0;
function uniqueHandle(prefix: string): string {
  seq += 1;
  return `${prefix}${seq}`;
}

/** A docker row that has cleared every precondition except the one under test. */
function readyHandle(prefix: string): string {
  const handle = uniqueHandle(prefix);
  registerAgent(handle, { vendor: SPAWNABLE, mode: "docker" });
  setVendorToken(VENDOR, "a-token-so-the-token-gate-passes");
  markConfirmed(handle, buildConfirmPlan(VENDOR, handle));
  registerProject(handle, PROJECT_DIR);

  return handle;
}

// ── the tier ──────────────────────────────────────────────────────────────

test("🛑 start is an ADMIN route, because it runs an agent on this machine", () => {
  assert.ok(
    ADMIN_ROUTES.has(START_PATH),
    "a read credential could otherwise start a contained agent",
  );
});

test("🛑 a read-only credential is refused, not merely un-offered", async (t) => {
  const h = await harness(["read"]);
  t.after(() => close(h));

  const handle = readyHandle("tier");
  const res = await postStart(h, { handle });

  assert.equal(res.status, 403, "hiding the button is not an access control");
});

// ── the route exists ──────────────────────────────────────────────────────

/**
 * 🛑 claude2's own finding on PR 458: every wiring test there is a source-text
 * scan of `app.js`, so all six were green while no route existed at all. This
 * is the assertion that could have caught it.
 */
test("🛑 the path is SERVED — a 404 here means the card's Start button lies", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const res = await postStart(h, { handle: uniqueHandle("served") });

  assert.notEqual(
    res.status,
    405,
    "POST is not accepted, so the request fell through to the static handler",
  );
  const body = (await res.json()) as Refusal;
  assert.notEqual(
    body.error,
    undefined,
    "the route answered without naming a refusal code",
  );
});

// ── the bad request ───────────────────────────────────────────────────────

test("a missing handle is a 400, never a start of the empty string", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  for (const body of [{}, { handle: "" }, { handle: 7 }]) {
    const res = await postStart(h, body);
    assert.equal(res.status, 400, `${JSON.stringify(body)} was not a 400`);
  }
});

// ── the refusals, in the order the spawn hits them ────────────────────────

test("an unregistered handle is a 404, because there is nothing to start", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const res = await postStart(h, { handle: uniqueHandle("ghost") });

  assert.equal(res.status, 404);
  assert.equal(((await res.json()) as Refusal).error, "not-registered");
});

/**
 * 🛑 DOCKER ONLY, on lee's ruling of 2026-11-25. A host start is one click to
 * an agent holding the operator's whole filesystem, with no plan to approve
 * and so no consent step anywhere in it.
 */
test("🛑 a host handle is refused, and the card hiding Start is not the guard", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const handle = uniqueHandle("host");
  registerAgent(handle, { vendor: SPAWNABLE, mode: "host" });

  const res = await postStart(h, { handle });

  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as Refusal).error, "not-docker");
});

test("🛑 a handle whose supervisor is already live refuses FIRST", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const handle = uniqueHandle("live");
  registerAgent(handle, { vendor: SPAWNABLE, mode: "docker" });
  // Everything else is left UNSATISFIED on purpose: no token, no confirmed
  // plan, no project dir. Any of those answered instead would prove the order
  // is wrong, and would send the operator to fix something that is not the
  // reason the spawn would refuse.
  const listener = new WakeListener(handle, async () => ({ ok: true }));
  await listener.bind();
  t.after(async () => void (await listener.close()));

  const res = await postStart(h, { handle });

  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as Refusal).error, "already-running");
});

test("🛑 a missing vendor token refuses BEFORE the unapproved plan", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const handle = uniqueHandle("notok");
  registerAgent(handle, { vendor: SPAWNABLE, mode: "docker" });
  setVendorToken(VENDOR, "");

  const res = await postStart(h, { handle });
  const body = (await res.json()) as Refusal;

  assert.equal(res.status, 409);
  assert.equal(
    body.error,
    "no-vendor-token",
    "plan-unconfirmed here would send the operator to approve a plan that cannot run",
  );
  // 🛑 THE VENDOR'S OWN MESSAGE, VERBATIM. It carries `authSetupHint`, which
  // is the remedy. A paraphrase would be a second copy of the rule.
  assert.equal(body.message, missingVendorTokenMessage(VENDOR));
});

test("🛑 an unapproved plan refuses BEFORE the missing project directory", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const handle = uniqueHandle("unconf");
  registerAgent(handle, { vendor: SPAWNABLE, mode: "docker" });
  setVendorToken(VENDOR, "a-token-so-the-token-gate-passes");

  const res = await postStart(h, { handle });
  const body = (await res.json()) as Refusal;

  assert.equal(res.status, 409);
  assert.equal(body.error, "plan-unconfirmed");
  assert.equal(body.message, "approve the container plan first");
});

test("a handle with no project directory is refused last of the four", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const handle = uniqueHandle("nodir");
  registerAgent(handle, { vendor: SPAWNABLE, mode: "docker" });
  setVendorToken(VENDOR, "a-token-so-the-token-gate-passes");
  markConfirmed(handle, buildConfirmPlan(VENDOR, handle));

  const res = await postStart(h, { handle });
  const body = (await res.json()) as Refusal;

  assert.equal(res.status, 409);
  assert.equal(body.error, "no-project-dir");
  assert.equal(body.message, `set a project directory for ${handle}`);
});

// ── the start itself ──────────────────────────────────────────────────────

/**
 * 🛑 THE LOG FILE IS WHAT PROVES THE DETACH, not a process id. A detached
 * child reparents to init and outlives this test, so the assertion is that the
 * route opened the handle's own log under `logDir()` before answering.
 */
test("🛑 a ready handle starts, and its log is the one `logPathFor` names", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const handle = readyHandle("go");

  const res = await postStart(h, { handle });
  const body = (await res.json()) as { handle: string; log: string };

  assert.equal(
    res.status,
    202,
    "the supervisor is not up yet when this returns",
  );
  assert.equal(body.handle, handle);
  assert.equal(body.log, logPathFor(handle));
  assert.equal(
    statSync(logPathFor(handle)).mode & 0o777,
    0o600,
    "the log carries the child's own output, so it is owner-only",
  );
});
