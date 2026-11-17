import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
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
      { handle: "refuser", ok: false, error: "mid-turn, try --now" },
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
