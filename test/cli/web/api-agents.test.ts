import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import type { RouteContext } from "../../../src/cli/web/server.js";

// 🛑 BEFORE any import that resolves a state path. `registrations.ts` reads
// `agents.json` out of the state dir, so an import above this line would pin
// the operator's real file.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "cm-api-agents-"));

const { migrate } = await import("../../../src/storage/db.js");
const dao = await import("../../../src/storage/dao.js");
const { route } = await import("../../../src/cli/web/server.js");
const { COOKIE_NAME } = await import("../../../src/cli/web/credential.js");
const { readRegistrations, registerAgent } =
  await import("../../../src/supervise/registrations.js");

/**
 * The stored (vendor, mode) pairs behind `/api/agents` — #132 slice 3.
 *
 * 🛑 THIS IS NOT `/api/agents/live`. `server.ts` says it on the liveness
 * handler: "THE SOCKET IS THE REGISTER, NOT THE `agents` TABLE". `/live`
 * answers who is connected now. This one answers what the operator
 * configured, and a handle can be in either without being in the other.
 */

const TOKEN = "token-for-the-agents-api-tests";
const COOKIE = `${COOKIE_NAME}=${TOKEN}`;

interface Harness {
  readonly db: DatabaseSync;
  readonly server: Server;
  readonly origin: string;
}

async function harness(): Promise<Harness> {
  const db = new DatabaseSync(":memory:");
  migrate(db);

  const ctx: RouteContext = {
    handle: "operator",
    db,
    sseClients: new Set(),
    port: 0,
    token: TOKEN,
    capabilities: ["read", "write", "admin"],
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

async function get(h: Harness): Promise<Record<string, unknown>> {
  const res = await fetch(`${h.origin}/api/agents`, {
    headers: { Cookie: COOKIE },
  });
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, unknown>;
}

async function post(
  h: Harness,
  path: string,
  body: unknown,
): Promise<Response> {
  return fetch(`${h.origin}${path}`, {
    method: "POST",
    headers: { Cookie: COOKIE, Origin: h.origin },
    body: JSON.stringify(body),
  });
}

test("🛑 GET returns the STORED pairs, and a live handle with no record is ABSENT", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  // Connected, never registered. This is the distinction /api/agents/live owns.
  dao.upsertAgent(h.db, {
    handle: "ephemeral",
    pid: 1,
    session_id: "ephemeral",
    display_name: "ephemeral",
    metadata: {},
  });
  registerAgent("registered-only", { vendor: "claude", mode: "host" });

  const body = await get(h);
  const agents = body.agents as Record<string, unknown>;

  assert.deepEqual(agents["registered-only"], {
    vendor: "claude",
    mode: "host",
  });
  assert.equal(
    "ephemeral" in agents,
    false,
    "a live socket is not a registration; that is what /api/agents/live is for",
  );
});

test("POST stores a pair and GET reads it back", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const res = await post(h, "/api/agents", {
    handle: "roundtrip",
    vendor: "cursor",
    mode: "docker",
  });

  assert.equal(res.status, 200);

  const agents = (await get(h)).agents as Record<string, unknown>;
  assert.deepEqual(agents.roundtrip, { vendor: "cursor", mode: "docker" });
});

/**
 * 🛑 REPLACED, NOT MERGED, AND THE STALE HALF WOULD BE `mode`.
 * `registerAgent`'s docblock refuses a merge for exactly this reason, so the API
 * over it must not reintroduce one. This is why the verb is POST and there is
 * no PATCH.
 */
test("🛑 a second POST REPLACES the pair rather than merging it", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  registerAgent("replaced", { vendor: "claude", mode: "docker" });

  const res = await post(h, "/api/agents", {
    handle: "replaced",
    vendor: "cursor",
    mode: "host",
  });

  assert.equal(res.status, 200);

  const agents = (await get(h)).agents as Record<string, unknown>;
  assert.deepEqual(
    agents.replaced,
    { vendor: "cursor", mode: "host" },
    "a merge would have left mode: docker, which decides whether it is contained",
  );
});

test("POST /api/agents/forget removes one pair and leaves its siblings", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  registerAgent("goes", { vendor: "claude", mode: "host" });
  registerAgent("stays", { vendor: "cursor", mode: "docker" });

  const res = await post(h, "/api/agents/forget", { handle: "goes" });

  assert.equal(res.status, 200);

  const agents = (await get(h)).agents as Record<string, unknown>;
  assert.equal("goes" in agents, false);
  assert.deepEqual(agents.stays, { vendor: "cursor", mode: "docker" });
});

/**
 * 🛑 A REFUSAL THAT ALREADY WROTE IS NOT A REFUSAL. `parseRecord` refuses an
 * unknown mode rather than reading it as `host`, and the status has to be a
 * clean 400 — a raw throw here is the 500 that `handleContextGateSet`'s
 * docblock already records paying for.
 */
test("🛑 an unknown mode is a 400 and the stored pair is UNCHANGED", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  registerAgent("survivor", { vendor: "claude", mode: "host" });

  const res = await post(h, "/api/agents", {
    handle: "survivor",
    vendor: "claude",
    mode: "Docker",
  });

  assert.equal(res.status, 400);
  assert.deepEqual(readRegistrations().agents.survivor, {
    vendor: "claude",
    mode: "host",
  });
});

test("🛑 forgetting a handle that has no record is not an error and creates nothing", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const res = await post(h, "/api/agents/forget", { handle: "never-existed" });

  assert.equal(res.status, 200);
});
