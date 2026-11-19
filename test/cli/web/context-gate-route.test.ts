import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { migrate } from "../../../src/storage/db.js";
import * as dao from "../../../src/storage/dao.js";
import { route, type RouteContext } from "../../../src/cli/web/server.js";
import {
  ALL_CAPABILITIES,
  COOKIE_NAME,
  type Capability,
} from "../../../src/cli/web/credential.js";
import {
  DEFAULT_CONTEXT_GATE,
  getGlobalContextGate,
  resolveContextGate,
  setGlobalContextGate,
  setHandleContextGate,
} from "../../../src/storage/context-gate.js";

/**
 * #135 unit 4 — the gate-SET surface, WEB UI ONLY per lee 2026-11-18.
 *
 * 🛑 THE REFUSALS HERE ASSERT THE STORED VALUE, NOT ONLY THE STATUS. A 400 that
 * already wrote the illegal gate is not a 400, and the status alone cannot tell
 * those apart. Every refusal below reads the gate back.
 *
 * 🛑 THIS ROUTE IS `admin`, NOT `write`. A gate of 1 restarts every agent on its
 * next reading, so its consequence is `/api/agents/stop`'s and not
 * `/api/rooms/style`'s. The tier is asserted here AND in
 * `api-credential.test.ts`'s classification guard.
 */

const TOKEN = "token-for-context-gate-tests";
const COOKIE = `${COOKIE_NAME}=${TOKEN}`;

interface Harness {
  readonly db: DatabaseSync;
  readonly server: Server;
  readonly origin: string;
}

async function harness(
  handles: readonly string[] = ["peer-a", "peer-b"],
  capabilities: readonly Capability[] = ALL_CAPABILITIES,
): Promise<Harness> {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  for (const h of ["operator", ...handles]) {
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
  // 🛑 THIS MIRRORS PRODUCTION'S CATCH-ALL ON PURPOSE. `chat-mcp web` wraps
  // `route` in a try that answers 500, and a bare `void route(...)` here does
  // not — so a throwing route produced NO RESPONSE and every test awaiting one
  // HUNG rather than failing. A harness that cannot tell "threw" from "hung"
  // is a guard that fails open. Found by claude2 on #135 unit 4.
  const server = createServer((req, res) => {
    void (async () => {
      try {
        await route(req, res, ctx);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: msg }));
        }
      }
    })();
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

async function setGate(
  origin: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${origin}/api/context-gate`, {
    method: "POST",
    headers: { cookie: COOKIE },
    body: JSON.stringify(body),
  });

  return {
    status: res.status,
    json: (await res.json()) as Record<string, unknown>,
  };
}

async function peersOf(origin: string): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${origin}/api/whoami`, {
    headers: { cookie: COOKIE },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { peers: Record<string, unknown>[] };

  return body.peers;
}

/**
 * The denominator is asserted, so a payload that stopped carrying the field
 * for every peer cannot pass as "none were missing".
 */
test("🛑 EVERY peer carries its resolved gate and the layer that answered", async () => {
  const h = await harness(["peer-a", "peer-b", "peer-c"]);
  try {
    const peers = await peersOf(h.origin);

    assert.equal(peers.length, 3, "the denominator moved — reread this test");

    const missing = peers.filter(
      (p) => typeof p.context_gate !== "number" || !p.context_gate_source,
    );
    assert.deepEqual(
      missing,
      [],
      `peers with no gate: ${missing.map((p) => p.handle).join(", ")}`,
    );
  } finally {
    close(h);
  }
});

test("the source names which of the three layers answered", async () => {
  const h = await harness(["own", "inherits"]);
  try {
    setGlobalContextGate(h.db, 70);
    setHandleContextGate(h.db, "own", 30);

    const byHandle = new Map(
      (await peersOf(h.origin)).map((p) => [p.handle as string, p]),
    );

    assert.equal(byHandle.get("own")?.context_gate, 30);
    assert.equal(byHandle.get("own")?.context_gate_source, "override");
    assert.equal(byHandle.get("inherits")?.context_gate, 70);
    assert.equal(byHandle.get("inherits")?.context_gate_source, "global");
  } finally {
    close(h);
  }
});

test("with no global set, a peer reports the BUILT-IN as its source", async () => {
  const h = await harness(["plain"]);
  try {
    const byHandle = new Map(
      (await peersOf(h.origin)).map((p) => [p.handle as string, p]),
    );

    assert.equal(byHandle.get("plain")?.context_gate, DEFAULT_CONTEXT_GATE);
    assert.equal(byHandle.get("plain")?.context_gate_source, "builtin");
  } finally {
    close(h);
  }
});

test("a POST with no handle sets the GLOBAL default", async () => {
  const h = await harness(["peer-a"]);
  try {
    const { status } = await setGate(h.origin, { gate: 80 });

    assert.equal(status, 200);
    assert.equal(getGlobalContextGate(h.db), 80);
    assert.equal(resolveContextGate(h.db, "peer-a"), 80);
  } finally {
    close(h);
  }
});

/**
 * 🛑 THE UNTOUCHED PEER IS THE CONTROL. A handler that wrote the global instead
 * of the override would move both, and asserting only the target cannot see it.
 */
test("a POST with a handle moves ONLY that handle", async () => {
  const h = await harness(["target", "bystander"]);
  try {
    setGlobalContextGate(h.db, 50);

    const { status } = await setGate(h.origin, { handle: "target", gate: 90 });

    assert.equal(status, 200);
    assert.equal(resolveContextGate(h.db, "target"), 90);
    assert.equal(resolveContextGate(h.db, "bystander"), 50);
    assert.equal(getGlobalContextGate(h.db), 50, "the global was rewritten");
  } finally {
    close(h);
  }
});

test("gate null with a handle CLEARS the override back to the global", async () => {
  const h = await harness(["target"]);
  try {
    setGlobalContextGate(h.db, 60);
    setHandleContextGate(h.db, "target", 20);

    const { status } = await setGate(h.origin, {
      handle: "target",
      gate: null,
    });

    assert.equal(status, 200);
    assert.equal(resolveContextGate(h.db, "target"), 60);
  } finally {
    close(h);
  }
});

/**
 * 🛑 THERE IS NO LAYER BELOW THE BUILT-IN TO FALL BACK TO, so clearing the
 * global is not an operation. Accepting it would have to either delete the
 * setting — leaving the built-in as a value the operator cannot see they are
 * now on — or silently do nothing.
 */
test("gate null with NO handle is refused, because the built-in cannot be cleared", async () => {
  const h = await harness(["peer-a"]);
  try {
    setGlobalContextGate(h.db, 60);

    const { status } = await setGate(h.origin, { gate: null });

    assert.equal(status, 400);
    assert.equal(getGlobalContextGate(h.db), 60, "the global was cleared");
  } finally {
    close(h);
  }
});

test("an unknown handle is refused and writes nothing", async () => {
  const h = await harness(["peer-a"]);
  try {
    const { status } = await setGate(h.origin, { handle: "ghost", gate: 40 });

    assert.equal(status, 404);
    assert.equal(getGlobalContextGate(h.db), null, "the global was written");
  } finally {
    close(h);
  }
});

/**
 * Each of these is a DIFFERENT way to be illegal, and `isLegalGate` rejects on
 * a different clause for each: the range floor, the range ceiling, integerness,
 * and the type.
 *
 * ⚠️ `null` IS NOT IN THIS LIST, AND IT WAS. With a handle it is the legal
 * clear, so asserting a 400 for it asserted the opposite of the behaviour two
 * tests above. The two cases null DOES have are covered there and in the
 * no-handle refusal.
 */
for (const bad of [0, 101, 50.5, "70", true] as const) {
  test(`gate ${JSON.stringify(bad)} is refused and does NOT reach storage`, async () => {
    const h = await harness(["peer-a"]);
    try {
      setGlobalContextGate(h.db, 55);

      const { status } = await setGate(h.origin, {
        handle: "peer-a",
        gate: bad,
      });

      assert.equal(status, 400, `${JSON.stringify(bad)} was accepted`);
      assert.equal(
        resolveContextGate(h.db, "peer-a"),
        55,
        `${JSON.stringify(bad)} reached storage`,
      );
    } finally {
      close(h);
    }
  });
}

/**
 * 🛑 A `write` CREDENTIAL MUST NOT REACH THIS. The supervisor holds one, and a
 * gate is the control that kills and respawns it.
 */
test("a write-only credential is refused, and the gate survives", async () => {
  const h = await harness(["peer-a"], ["read", "write"]);
  try {
    setGlobalContextGate(h.db, 55);

    const { status } = await setGate(h.origin, { gate: 90 });

    assert.equal(status, 403);
    assert.equal(getGlobalContextGate(h.db), 55, "a write credential wrote it");
  } finally {
    close(h);
  }
});

/**
 * The positive control for the test above. Without it, a handler that refused
 * EVERY caller would pass the 403 assertion and look correct.
 */
test("an admin credential IS accepted, so the 403 above is about the tier", async () => {
  const h = await harness(["peer-a"], ["read", "write", "admin"]);
  try {
    const { status } = await setGate(h.origin, { gate: 90 });

    assert.equal(status, 200);
    assert.equal(getGlobalContextGate(h.db), 90);
  } finally {
    close(h);
  }
});

/**
 * 🛑 THE RAMP IS DERIVED FROM THE GATE, so a SET that did not move the ramp
 * would leave the gauge colouring against the old ticks — the exact "looked
 * calm" failure unit 3b exists to end.
 */
test("setting a gate moves that peer's colour ramp in the same payload", async () => {
  const h = await harness(["peer-a"]);
  try {
    const before = (await peersOf(h.origin)).find((p) => p.handle === "peer-a");

    await setGate(h.origin, { handle: "peer-a", gate: 100 });

    const after = (await peersOf(h.origin)).find((p) => p.handle === "peer-a");

    assert.notDeepEqual(
      after?.context_ramp,
      before?.context_ramp,
      "the ramp did not follow the gate",
    );
    assert.deepEqual(after?.context_ramp, [50, 75, 85]);
  } finally {
    close(h);
  }
});

/**
 * 🟡 B from claude2's review. A non-string handle reached SQLite and came back
 * as a raw driver message with a 500, where every illegal GATE gets a 400.
 *
 * 🛑 THE STATUS IS NOT THE WHOLE ASSERTION. A 500 is also "refused", so the
 * body is checked for the driver's wording — that is what made this a finding
 * rather than a cosmetic difference.
 */
for (const badHandle of [true, 42, { a: 1 }, ["x"]] as const) {
  test(`handle ${JSON.stringify(badHandle)} is a clean 400, not a driver error`, async () => {
    const h = await harness(["peer-a"]);
    try {
      const { status, json } = await setGate(h.origin, {
        handle: badHandle,
        gate: 50,
      });

      assert.equal(status, 400, `${JSON.stringify(badHandle)} was not a 400`);
      assert.doesNotMatch(
        String(json.error),
        /SQLite|bound to|parameter/i,
        "a raw driver message reached the operator",
      );
      assert.equal(getGlobalContextGate(h.db), null, "it wrote anyway");
    } finally {
      close(h);
    }
  });
}

/**
 * 🔵 E from claude2's review. `effective` resolved against the OPERATOR's own
 * handle on a global set, so an operator with an override read their own
 * number back as the effect of a change to everyone else's.
 */
test("a GLOBAL set does not report an `effective` number at all", async () => {
  const h = await harness(["peer-a"]);
  try {
    setHandleContextGate(h.db, "operator", 90);

    const { status, json } = await setGate(h.origin, { gate: 30 });

    assert.equal(status, 200);
    assert.equal(json.gate, 30);
    assert.equal(
      json.effective,
      undefined,
      "a global set reported one effective number, and there is no such thing",
    );
  } finally {
    close(h);
  }
});

test("a HANDLE set reports that handle's effective number", async () => {
  const h = await harness(["peer-a"]);
  try {
    const { json } = await setGate(h.origin, { handle: "peer-a", gate: 44 });

    assert.equal(json.scope, "peer-a");
    assert.equal(json.effective, 44);
  } finally {
    close(h);
  }
});

/**
 * 🛑 THE NON-VACUITY CONTROL FOR THE HARNESS FIX ABOVE. Without it the
 * try/catch is a change nothing in this file can prove.
 *
 * ⚠️ A FIRST VERSION OF THIS CONTROL USED `?around_id=%ZZ` AND WAS VACUOUS. It
 * passed with the bare `void route(...)` too, because `parseAroundId` refuses a
 * malformed id cleanly and nothing throws. `readJsonBody` does a bare
 * `JSON.parse`, so a malformed BODY is the input that actually rejects.
 */
test("a route that THROWS answers 500 here, as it does in production", async () => {
  const h = await harness(["peer-a"]);
  try {
    const res = await fetch(`${h.origin}/api/context-gate`, {
      method: "POST",
      headers: { cookie: COOKIE },
      body: "{not json",
    });

    assert.equal(res.status, 500, "a throwing route did not answer 500");
  } finally {
    close(h);
  }
});
