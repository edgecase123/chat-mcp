import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { migrate } from "../../src/storage/db.js";
import * as dao from "../../src/storage/dao.js";
import { route, type RouteContext } from "../../src/cli/web/server.js";
import { ALL_CAPABILITIES } from "../../src/cli/web/credential.js";
import {
  setGlobalContextGate,
  setHandleContextGate,
} from "../../src/storage/context-gate.js";
import { gaugeDisplay } from "../../web/assets/logic.js";

/**
 * 🛑 THIS IS THE GUARD THAT KEEPS `gaugeDisplay`'s QUIET FALLBACK UNREACHABLE.
 *
 * A peer with no `context_ramp` renders its number and no colour, because
 * without a gate there is no tick to compare and inventing one would put a
 * second home for lee's default in the browser. That fallback is only safe
 * while the payload ALWAYS carries a ramp — otherwise it is a guard that fails
 * open, and the agent filling toward a restart is the one that looks calm.
 *
 * So the assertion here is on the DENOMINATOR: every peer, not one.
 */

const TEST_TOKEN = "test-token-for-route-tests";
const COOKIE = `chat_mcp_api=${TEST_TOKEN}`;

async function harness(
  handles: string[],
): Promise<{ db: DatabaseSync; server: Server; origin: string }> {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  for (const h of ["me", ...handles]) {
    dao.upsertAgent(db, {
      handle: h,
      pid: 1,
      session_id: h,
      display_name: h,
      metadata: {},
    });
  }
  const ctx: RouteContext = {
    handle: "me",
    db,
    sseClients: new Set(),
    port: 0,
    token: TEST_TOKEN,
    capabilities: ALL_CAPABILITIES,
  };
  const server = createServer((req, res) => {
    void route(req, res, ctx);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  ctx.port = port;

  return { db, server, origin: `http://127.0.0.1:${port}` };
}

function close(h: { db: DatabaseSync; server: Server }): void {
  h.server.closeAllConnections();
  h.server.close();
  h.db.close();
}

async function peersOf(origin: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${origin}/api/whoami`, {
    headers: { cookie: COOKIE },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { peers: Record<string, unknown>[] };

  return body.peers;
}

test("🛑 EVERY peer carries a ramp, so the browser never has to guess a gate", async () => {
  const h = await harness(["a", "b", "c"]);
  try {
    const peers = await peersOf(h.origin);

    assert.equal(peers.length, 3, "the denominator moved — reread this test");

    const missing = peers.filter((p) => !Array.isArray(p.context_ramp));
    assert.deepEqual(
      missing,
      [],
      `peers with no ramp: ${missing.map((p) => p.handle).join(", ")}`,
    );
  } finally {
    close(h);
  }
});

test("🛑 the ramp follows the handle's OWN gate, not one global number", async () => {
  const h = await harness(["low", "high"]);
  try {
    setGlobalContextGate(h.db, 50);
    setHandleContextGate(h.db, "high", 80);

    const byHandle = new Map(
      (await peersOf(h.origin)).map((p) => [p.handle, p.context_ramp]),
    );

    assert.deepEqual(byHandle.get("low"), [25, 37.5, 42.5]);
    assert.deepEqual(byHandle.get("high"), [40, 60, 68]);
  } finally {
    close(h);
  }
});

/**
 * 🛑 THE FLOOR IS 0 HERE AND IS NOT IN THE SUPERVISOR. A floor skips bands a
 * child spawned past, so its restart warnings do not all fire on turn 0. A
 * colour fires nothing, so a skipped tick would only make the gauge jump a
 * shade. Three ticks, always.
 */
test("🛑 all three ticks ship, even for a gate whose band 1 sits under a spawn fill", async () => {
  const h = await harness(["tiny"]);
  try {
    setHandleContextGate(h.db, "tiny", 20);

    const [peer] = await peersOf(h.origin);

    assert.deepEqual(peer!.context_ramp, [10, 15, 17]);
  } finally {
    close(h);
  }
});

/**
 * 🛑 THE END-TO-END LEG, BECAUSE TWO CORRECT HALVES CAN STILL DISAGREE. The
 * server could ship a shape the browser does not read, and both unit suites
 * would stay green. This feeds the real payload to the real renderer.
 */
test("🛑 the real payload colours the real renderer", async () => {
  const h = await harness(["filling"]);
  try {
    setHandleContextGate(h.db, "filling", 50);
    dao.setAgentContext(h.db, "filling", 44, 100);

    const [peer] = await peersOf(h.origin);
    const g = gaugeDisplay(peer!);

    assert.equal(g.band, "ramp3", "44% against a gate of 50 is the last band");
    assert.equal(g.percent, 44);
  } finally {
    close(h);
  }
});

test("⚠️ control — the same renderer says `ok` when the ramp is stripped", async () => {
  // Proves the test above is reading the payload's ramp and not a default.
  const h = await harness(["filling"]);
  try {
    setHandleContextGate(h.db, "filling", 50);
    dao.setAgentContext(h.db, "filling", 44, 100);

    const [peer] = await peersOf(h.origin);
    const { context_ramp: _dropped, ...withoutRamp } = peer!;

    assert.equal(gaugeDisplay(withoutRamp).band, "ok");
  } finally {
    close(h);
  }
});
