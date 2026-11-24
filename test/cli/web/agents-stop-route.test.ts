import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteContext } from "../../../src/cli/web/server.js";

// Before any import that resolves a state path — binding in the real socket
// directory unlinks whatever looks stale and stops a running agent.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-stop-"));

const { migrate } = await import("../../../src/storage/db.js");
const dao = await import("../../../src/storage/dao.js");
const { route } = await import("../../../src/cli/web/server.js");
const { ALL_CAPABILITIES, requiredCapability, CLASSIFIED_PATHS } =
  await import("../../../src/cli/web/credential.js");
const { WakeListener } = await import("../../../src/supervise/socket.js");
const { socketPathFor, ensureSocketDir } =
  await import("../../../src/util/paths.js");
const { setGlobalContextGate, setHandleContextGate } =
  await import("../../../src/storage/context-gate.js");
const { registrationsPath } =
  await import("../../../src/supervise/registrations.js");

const TEST_TOKEN = "test-token-for-stop-routes";
const COOKIE = `chat_mcp_api=${TEST_TOKEN}`;

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

function close(h: Harness): void {
  h.server.closeAllConnections();
  h.server.close();
  h.db.close();
}

const get = async (h: Harness, path: string): Promise<any> =>
  await (
    await fetch(`${h.origin}${path}`, { headers: { Cookie: COOKIE } })
  ).json();

const post = async (
  h: Harness,
  path: string,
  body: unknown,
): Promise<{ status: number; json: any }> => {
  const res = await fetch(`${h.origin}${path}`, {
    method: "POST",
    headers: { Cookie: COOKIE },
    body: JSON.stringify(body),
  });

  return { status: res.status, json: await res.json() };
};

test("both new routes are CLASSIFIED, and stop is admin while the list is a read", () => {
  // 🛑 An unlisted /api/ path falls back to `admin`, so a return value alone
  // cannot tell a classified route from a forgotten one. Membership can.
  assert.equal(CLASSIFIED_PATHS.has("/api/agents/live"), true);
  assert.equal(CLASSIFIED_PATHS.has("/api/agents/stop"), true);
  assert.equal(requiredCapability("GET", "/api/agents/live"), "read");
  assert.equal(requiredCapability("POST", "/api/agents/stop"), "admin");
});

test("with nothing running, the live list is empty rather than an error", async () => {
  const h = await harness();

  try {
    assert.deepEqual(await get(h, "/api/agents/live"), { agents: [] });
  } finally {
    close(h);
  }
});

test("a live supervisor is listed with its supervised child's context gauge", async () => {
  const h = await harness();
  dao.upsertAgent(h.db, {
    handle: "gopher-agent",
    pid: process.pid,
    session_id: "s",
    display_name: "gopher-agent",
    metadata: {},
  });
  dao.setAgentContext(h.db, "gopher-agent", 42_000, 100_000);
  const l = await WakeListener.bind("gopher", () => ({ ok: true }));

  try {
    const body = await get(h, "/api/agents/live");

    assert.equal(body.agents.length, 1);
    assert.equal(body.agents[0].handle, "gopher");
    assert.equal(typeof body.agents[0].boundAt, "number");
    // Peer-shaped on purpose: the page's own gaugeDisplay() reads these, so
    // the 15-minute freshness window keeps ONE home.
    assert.equal(body.agents[0].child.handle, "gopher-agent");
    assert.equal(body.agents[0].child.context_used, 42_000);
    assert.equal(body.agents[0].child.context_total, 100_000);
    assert.equal(body.agents[0].child.fresh, true);
  } finally {
    await l.close();
    close(h);
  }
});

test("a supervisor with no registered child is listed with a null child", async () => {
  const h = await harness();
  const l = await WakeListener.bind("childless", () => ({ ok: true }));

  try {
    const body = await get(h, "/api/agents/live");

    assert.equal(body.agents[0].handle, "childless");
    assert.equal(body.agents[0].child, null);
  } finally {
    await l.close();
    close(h);
  }
});

test("a graceful stop reaches the supervisor as a stop control, not a chat wake", async () => {
  const h = await harness();
  const seen: any[] = [];
  const l = await WakeListener.bind("stoppable", (e) => {
    seen.push(e);

    return { ok: true, graceSeconds: 45 };
  });

  try {
    const { status, json } = await post(h, "/api/agents/stop", {
      handle: "stoppable",
    });

    assert.equal(status, 200);
    assert.deepEqual(json.results, [
      { handle: "stoppable", ok: true, graceSeconds: 45 },
    ]);
    assert.deepEqual(seen[0].control, { kind: "stop", mode: "graceful" });
  } finally {
    await l.close();
    close(h);
  }
});

test("mode `now` is forwarded verbatim, because graceful is the default", async () => {
  const h = await harness();
  const seen: any[] = [];
  const l = await WakeListener.bind("urgent", (e) => {
    seen.push(e);

    return { ok: true };
  });

  try {
    await post(h, "/api/agents/stop", { handle: "urgent", mode: "now" });

    assert.deepEqual(seen[0].control, { kind: "stop", mode: "now" });
  } finally {
    await l.close();
    close(h);
  }
});

test("an unknown mode is REFUSED rather than silently treated as graceful", async () => {
  const h = await harness();
  const seen: any[] = [];
  const l = await WakeListener.bind("picky", (e) => {
    seen.push(e);

    return { ok: true };
  });

  try {
    const { status } = await post(h, "/api/agents/stop", {
      handle: "picky",
      mode: "immediately",
    });

    assert.equal(status, 400);
    // 🛑 The refusal must happen BEFORE the control is sent. A 400 after a
    // graceful stop already left is a 400 that stopped the agent anyway.
    assert.deepEqual(seen, []);
  } finally {
    await l.close();
    close(h);
  }
});

test("a REFUSED control is reported as a failure, not as a stop that worked", async () => {
  const h = await harness();
  // 🛑 `{ ok: false }` is a truthy object. The CLI shipped this bug once:
  // a refused control read as accepted and the operator waited out a no-op.
  const l = await WakeListener.bind("refuser", () => ({
    ok: false,
    error: "mid-turn, try --now",
  }));

  try {
    const { json } = await post(h, "/api/agents/stop", { handle: "refuser" });

    assert.deepEqual(json.results, [
      {
        handle: "refuser",
        ok: false,
        // The card branches on this, not on the prose beside it.
        reason: "refused",
        error: "mid-turn, try --now",
      },
    ]);
  } finally {
    await l.close();
    close(h);
  }
});

test("stopping a handle nothing is listening for says so, by handle", async () => {
  const h = await harness();

  try {
    const { status, json } = await post(h, "/api/agents/stop", {
      handle: "ghost",
    });

    assert.equal(status, 200);
    assert.equal(json.results[0].handle, "ghost");
    assert.equal(json.results[0].ok, false);
    assert.equal(json.results[0].reason, "unreachable");
    assert.match(json.results[0].error, /no supervisor/i);
  } finally {
    close(h);
  }
});

test("`all` stops every live supervisor and names each one in the result", async () => {
  const h = await harness();
  const hit: string[] = [];
  const a = await WakeListener.bind("one", (e) => {
    hit.push(e.to);

    return { ok: true };
  });
  const b = await WakeListener.bind("two", (e) => {
    hit.push(e.to);

    return { ok: true };
  });
  // Debris from a crashed supervisor must not appear as a stopped agent.
  ensureSocketDir();
  writeFileSync(socketPathFor("crashed"), "");

  try {
    const { json } = await post(h, "/api/agents/stop", {
      all: true,
      mode: "now",
    });

    assert.deepEqual(
      json.results.map((r: { handle: string }) => r.handle).sort(),
      ["one", "two"],
    );
    assert.deepEqual(hit.sort(), ["one", "two"]);
  } finally {
    await a.close();
    await b.close();
    close(h);
  }
});

test("`all` with nothing running reports an empty sweep rather than success", async () => {
  const h = await harness();

  try {
    const { status, json } = await post(h, "/api/agents/stop", { all: true });

    assert.equal(status, 200);
    // 🛑 SAYS it stopped nothing. A silent empty sweep gives the operator no
    // way to tell a failed stop from an agent that was never running.
    assert.deepEqual(json.results, []);
    assert.equal(json.stopped, 0);
  } finally {
    close(h);
  }
});

test("a body naming neither a handle nor `all` is refused", async () => {
  const h = await harness();

  try {
    const { status } = await post(h, "/api/agents/stop", {});

    assert.equal(status, 400);
  } finally {
    close(h);
  }
});

test("a handle that is not a valid handle is refused, not left to throw", async () => {
  const h = await harness();

  try {
    // 🛑 `socketPathFor` THROWS on a traversal attempt rather than returning,
    // and an uncaught throw inside a route leaves the request hanging with no
    // status at all. The refusal has to happen in the handler.
    for (const handle of ["../../etc/passwd", "Claude2", "", "has space"]) {
      const { status, json } = await post(h, "/api/agents/stop", { handle });

      assert.equal(status, 400, `"${handle}" was not refused`);
      assert.equal(typeof json.error, "string");
    }
  } finally {
    close(h);
  }
});

/**
 * #135 slice 4c — the gate CONTROL lives on the agent row, and the agent row
 * reads this route.
 *
 * 🛑 `/api/whoami` SHIPS THE GATE AND THIS ROUTE DID NOT. Slice 4a flattened
 * `context_gate` onto whoami's PEERS only, so the number the control edits was
 * absent from the one payload the Agents panel actually renders. Without this
 * the control would have had to resolve the three-layer rule in the browser,
 * which is a second home for it.
 *
 * ⚠️ `context_gate_source` IS ASSERTED, NOT JUST `context_gate`. A control that
 * cannot tell an inherited default from an override would offer `[Clear]` on a
 * row that has nothing to clear.
 */
test("a live supervisor's child row carries the gate and the layer it came from", async () => {
  const h = await harness();
  dao.upsertAgent(h.db, {
    handle: "gated-agent",
    pid: process.pid,
    session_id: "s",
    display_name: "gated-agent",
    metadata: {},
  });
  setGlobalContextGate(h.db, 60);
  const l = await WakeListener.bind("gated", () => ({ ok: true }));

  try {
    const body = await get(h, "/api/agents/live");

    assert.equal(body.agents[0].child.context_gate, 60);
    assert.equal(body.agents[0].child.context_gate_source, "global");
  } finally {
    await l.close();
    close(h);
  }
});

/**
 * 🛑 THE DISCRIMINATING CASE. A route that hardcoded the global, or resolved
 * the OPERATOR's gate instead of the child's, passes the test above and fails
 * this one.
 */
test("a per-handle override on the child beats the global, and says so", async () => {
  const h = await harness();
  dao.upsertAgent(h.db, {
    handle: "override-agent",
    pid: process.pid,
    session_id: "s",
    display_name: "override-agent",
    metadata: {},
  });
  setGlobalContextGate(h.db, 60);
  setHandleContextGate(h.db, "override-agent", 25);
  const l = await WakeListener.bind("override", () => ({ ok: true }));

  try {
    const body = await get(h, "/api/agents/live");

    assert.equal(body.agents[0].child.context_gate, 25);
    assert.equal(body.agents[0].child.context_gate_source, "override");
  } finally {
    await l.close();
    close(h);
  }
});

/**
 * #415 — an omitted `mode` is resolved from the agent's VENDOR, not from a
 * constant. `graceful` on a per-turn vendor with no turn live queues a
 * shutdown notice, which spawns a turn and bills it.
 *
 * 🛑 `agents.json` IS WRITTEN AND REMOVED PER TEST. Every other test in this
 * file reaches the route with no registration at all, and that is the state
 * they assert against.
 */
function withRegistrations(agents: Record<string, unknown>): () => void {
  writeFileSync(registrationsPath(), JSON.stringify({ agents }));

  return () => rmSync(registrationsPath(), { force: true });
}

test("an omitted mode on a PER-TURN vendor reaches the supervisor as now", async () => {
  const h = await harness();
  const seen: any[] = [];
  const l = await WakeListener.bind("perturn", (e) => {
    seen.push(e);

    return { ok: true };
  });
  const undo = withRegistrations({
    perturn: { vendor: "cursor", mode: "host" },
  });

  try {
    await post(h, "/api/agents/stop", { handle: "perturn" });

    assert.deepEqual(seen[0].control, { kind: "stop", mode: "now" });
  } finally {
    undo();
    await l.close();
    close(h);
  }
});

/**
 * 🛑 THE DISCRIMINATOR. Without this row a handler that answered a constant
 * `now` would pass the test above, and the change would be a different bug
 * rather than a fix.
 */
test("an omitted mode on a CONTINUOUS vendor still reaches as graceful", async () => {
  const h = await harness();
  const seen: any[] = [];
  const l = await WakeListener.bind("continuous", (e) => {
    seen.push(e);

    return { ok: true };
  });
  const undo = withRegistrations({
    continuous: { vendor: "claude", mode: "host" },
  });

  try {
    await post(h, "/api/agents/stop", { handle: "continuous" });

    assert.deepEqual(seen[0].control, { kind: "stop", mode: "graceful" });
  } finally {
    undo();
    await l.close();
    close(h);
  }
});

/**
 * 🛑 THE SWEEP KEEPS `graceful`, EVEN OVER A PER-TURN AGENT. `Stop all`
 * crosses a fleet whose vendors may differ, so no single per-vendor default is
 * correct for it. Decided on #415 rather than overlooked, and pinned here so a
 * later per-handle resolution inside the sweep reds this row instead of
 * shipping quietly.
 */
test("🛑 an omitted mode on the SWEEP stays graceful, per-turn or not", async () => {
  const h = await harness();
  const seen: any[] = [];
  const l = await WakeListener.bind("sweepable", (e) => {
    seen.push(e);

    return { ok: true };
  });
  const undo = withRegistrations({
    sweepable: { vendor: "cursor", mode: "host" },
  });

  try {
    await post(h, "/api/agents/stop", { all: true });

    assert.equal(seen.length, 1, "the control: the sweep reached one agent");
    assert.deepEqual(seen[0].control, { kind: "stop", mode: "graceful" });
  } finally {
    undo();
    await l.close();
    close(h);
  }
});
