import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import type { RouteContext } from "../../../src/cli/web/server.js";
import type { Capability } from "../../../src/cli/web/credential.js";

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "cm-whoami-caps-"));

const { migrate } = await import("../../../src/storage/db.js");
const dao = await import("../../../src/storage/dao.js");
const { route } = await import("../../../src/cli/web/server.js");
const { COOKIE_NAME, ALL_CAPABILITIES } =
  await import("../../../src/cli/web/credential.js");

/**
 * `/api/whoami` carries the CALLER's own capabilities — #132 slice 4a.
 *
 * 🛑 THE BROWSER HAD NO WAY TO KNOW ITS OWN TIER. The registration card has
 * to say what it is withholding, and the alternative was inferring the tier
 * from a missing `mode` key on `/api/agents` — which an empty agent list
 * makes indistinguishable from a non-admin caller.
 *
 * 🛑 THE READ-ONLY CASE IS THE ONE THAT MATTERS. Returning
 * `ALL_CAPABILITIES` passes the admin test and tells the card every caller is
 * an admin, which is the fails-open direction.
 */

const TOKEN = "token-for-the-whoami-capability-tests";
const COOKIE = `${COOKIE_NAME}=${TOKEN}`;

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
  dao.upsertAgent(db, {
    handle: "operator",
    pid: 1,
    session_id: "operator",
    display_name: "operator",
    metadata: {},
  });

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

async function whoami(h: Harness): Promise<Record<string, unknown>> {
  const res = await fetch(`${h.origin}/api/whoami`, {
    headers: { cookie: COOKIE },
  });
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, unknown>;
}

test("whoami tells an admin caller it holds admin", async () => {
  const h = await harness(["read", "write", "admin"]);
  try {
    const body = await whoami(h);
    assert.deepEqual(body.capabilities, ["read", "write", "admin"]);
  } finally {
    close(h);
  }
});

test("whoami reports a read-only caller's capabilities, not every capability", async () => {
  const h = await harness(["read"]);
  try {
    const body = await whoami(h);

    assert.deepEqual(body.capabilities, ["read"]);
    assert.ok(
      !(body.capabilities as string[]).includes("admin"),
      "a read-only caller must not be told it holds admin",
    );
  } finally {
    close(h);
  }
});
