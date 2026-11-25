import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { RouteContext } from "../../../src/cli/web/server.js";
import {
  listenWithRoute,
  type RouteServer,
} from "../../support/route-server.js";

// 🛑 BEFORE any import that resolves a state path. `registrations.ts` reads
// `agents.json` out of the state dir, so an import above this line would pin
// the operator's real file.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "cm-live-stop-mode-"));

const { migrate } = await import("../../../src/storage/db.js");
const { route } = await import("../../../src/cli/web/server.js");
const { COOKIE_NAME, ALL_CAPABILITIES } =
  await import("../../../src/cli/web/credential.js");
const { registerAgent } =
  await import("../../../src/supervise/registrations.js");
const { WakeListener } = await import("../../../src/supervise/socket.js");

/**
 * #415 slice 2 — `/api/agents/live` serves the RESOLVED default stop mode.
 *
 * 🛑 THE BROWSER NEVER LEARNS `processPerTurn`. It reads a decision, so no
 * vendor map is hand-typed under `web/assets/` and nothing there can drift out
 * of step with the adapters.
 *
 * 🛑 EVERY TEST HERE USES A MIXED FLEET IN ONE RESPONSE. A fleet of one cannot
 * tell a per-handle resolver from a handler answering a constant: one
 * per-turn agent passes for a constant `now`, and one continuous agent passes
 * for a constant `graceful`. Only both in a single payload discriminate.
 */

const TOKEN = "token-for-the-live-stop-mode-tests";
const COOKIE = `${COOKIE_NAME}=${TOKEN}`;

interface Harness {
  readonly db: DatabaseSync;
  readonly listening: RouteServer;
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
    capabilities: ALL_CAPABILITIES,
  };
  // 🛑 `listenWithRoute` MIRRORS PRODUCTION'S CATCH — #426. A bare
  // `void route(req, res, ctx)` here made a throwing route HANG every test
  // awaiting a response, with no assertion and no stack.
  const listening = await listenWithRoute(route, ctx);
  ctx.port = listening.port;

  return { db, listening, origin: listening.origin };
}

function close(h: Harness): void {
  h.listening.close();
  h.db.close();
}

async function live(h: Harness): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${h.origin}/api/agents/live`, {
    headers: { Cookie: COOKIE },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;

  return body.agents as Record<string, unknown>[];
}

/** The resolved mode per handle, so an assertion names the handle it failed on. */
function modesByHandle(
  agents: Record<string, unknown>[],
): Record<string, unknown> {
  return Object.fromEntries(
    agents.map((a) => [a.handle as string, a.defaultStopMode]),
  );
}

test("🛑 a MIXED fleet gets a mode PER HANDLE, not one for the response", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  registerAgent("per-turn-agent", { vendor: "cursor", mode: "host" });
  registerAgent("continuous-agent", { vendor: "claude", mode: "host" });

  const a = await WakeListener.bind("per-turn-agent", () => ({ ok: true }));
  const b = await WakeListener.bind("continuous-agent", () => ({ ok: true }));
  t.after(async () => {
    await a.close();
    await b.close();
  });

  assert.deepEqual(modesByHandle(await live(h)), {
    "per-turn-agent": "now",
    "continuous-agent": "graceful",
  });
});

/**
 * ⚠️ AN UNKNOWN VENDOR KEEPS `graceful`, and so does a handle with no
 * registration at all. `agents.json` is operator-edited, so both are the
 * workflow rather than an anomaly.
 *
 * 🛑 THE PER-TURN ROW IS HERE AS THE POSITIVE CONTROL. Without it a handler
 * answering a flat `graceful` would satisfy this test.
 */
test("🛑 an unregistered or unknown-vendor handle stays graceful", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  registerAgent("known-per-turn", { vendor: "cursor", mode: "host" });
  registerAgent("made-up", { vendor: "not-a-real-vendor", mode: "host" });

  const a = await WakeListener.bind("known-per-turn", () => ({ ok: true }));
  const b = await WakeListener.bind("made-up", () => ({ ok: true }));
  const c = await WakeListener.bind("never-registered", () => ({ ok: true }));
  t.after(async () => {
    await a.close();
    await b.close();
    await c.close();
  });

  assert.deepEqual(modesByHandle(await live(h)), {
    "known-per-turn": "now",
    "made-up": "graceful",
    "never-registered": "graceful",
  });
});

/**
 * 🛑 IT SITS BESIDE `handle`, NOT UNDER `child`. The supervisor's vendor
 * decides it and `/api/agents/stop` accepts only the supervisor, so putting it
 * on the child would pair the decision with the wrong handle — and a
 * childless supervisor is still stoppable.
 */
test("🛑 a supervisor with NO child still carries a resolved mode", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  registerAgent("childless-per-turn", { vendor: "cursor", mode: "host" });
  registerAgent("childless-continuous", { vendor: "claude", mode: "host" });

  const a = await WakeListener.bind("childless-per-turn", () => ({ ok: true }));
  const b = await WakeListener.bind("childless-continuous", () => ({
    ok: true,
  }));
  t.after(async () => {
    await a.close();
    await b.close();
  });

  const agents = await live(h);

  for (const row of agents) {
    assert.equal(row.child, null, `${String(row.handle)} grew a child`);
  }
  assert.deepEqual(modesByHandle(agents), {
    "childless-per-turn": "now",
    "childless-continuous": "graceful",
  });
});
