import { test } from "node:test";
import assert from "node:assert/strict";
import {
  listenWithRoute,
  type RouteServer,
} from "../../support/route-server.js";
import { DatabaseSync } from "node:sqlite";
import type { ServerResponse } from "node:http";

import { migrate } from "../../../src/storage/db.js";
import * as dao from "../../../src/storage/dao.js";
import { route, type RouteContext } from "../../../src/cli/web/server.js";
import {
  ALL_CAPABILITIES,
  requiredCapability,
} from "../../../src/cli/web/credential.js";

/**
 * #240, the web-server half. The supervisor POSTs `/api/activity` and every
 * open browser must be told, so a dot can pulse while an agent works.
 *
 * Driven through a real http server, matching `server-routes.test.ts`, because
 * the Host and Origin guards sit in the request path and a mock req/res is
 * free to not have them.
 */

const TEST_TOKEN = "test-token-for-activity-tests";
const COOKIE = `chat_mcp_api=${TEST_TOKEN}`;

interface Harness {
  readonly db: DatabaseSync;
  readonly listening: RouteServer;
  readonly origin: string;
  readonly sseClients: Set<ServerResponse>;
  /** Every frame written to the fake browser, in order. */
  readonly frames: string[];
}

async function harness(): Promise<Harness> {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  dao.upsertAgent(db, {
    handle: "operator",
    pid: 1,
    session_id: "operator",
    display_name: "operator",
    metadata: {},
  });

  const frames: string[] = [];
  const sseClients = new Set<ServerResponse>();

  // A stand-in for a connected browser. `route` only ever writes to these.
  sseClients.add({
    write: (chunk: string) => frames.push(chunk),
  } as unknown as ServerResponse);

  const ctx: RouteContext = {
    handle: "operator",
    db,
    sseClients,
    port: 0,
    token: TEST_TOKEN,
    capabilities: ALL_CAPABILITIES,
  };
  const listening = await listenWithRoute(route, ctx);
  ctx.port = listening.port;

  return { db, listening, origin: listening.origin, sseClients, frames };
}

function close(h: Harness): void {
  // close() alone leaves keep-alive sockets open and the runner never exits.
  h.listening.close();
  h.db.close();
}

function post(
  h: Harness,
  body: unknown,
  cookie: string | null = COOKIE,
): Promise<Response> {
  return fetch(`${h.origin}/api/activity`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie === null ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
}

test("🛑 a tick becomes an SSE frame every open browser receives", async () => {
  const h = await harness();

  try {
    const res = await post(h, { handle: "claude2", phase: "tick" });

    assert.equal(res.status, 200);
    assert.equal(h.frames.length, 1, "the browser was told nothing");
    assert.match(
      h.frames[0]!,
      /^event: activity\n/,
      `frame was: ${h.frames[0]}`,
    );

    // 🛑 THE HANDLE IS IN THE PAYLOAD, unlike `event: wake`, which carries only
    // a timestamp and makes the client re-fetch. A pulse has nowhere to
    // re-fetch FROM — there is no endpoint that reports who is working — so
    // the frame has to carry the handle itself.
    const data = JSON.parse(/data: (.*)\n/.exec(h.frames[0]!)![1]!);
    assert.equal(data.handle, "claude2");
    assert.equal(data.phase, "tick");
  } finally {
    close(h);
  }
});

test('🛑 an end becomes a frame too, because silence cannot mean "finished"', async () => {
  const h = await harness();

  try {
    await post(h, { handle: "claude2", phase: "end" });

    assert.equal(h.frames.length, 1);
    const data = JSON.parse(/data: (.*)\n/.exec(h.frames[0]!)![1]!);

    // The web server cannot tell "turn ended" from "no events yet", so the
    // supervisor says so and this relays it. lee's decision 3 on #240.
    assert.equal(data.phase, "end");
  } finally {
    close(h);
  }
});

/**
 * 🛑 THE GUARD THAT MATTERS MOST, AND IT PROTECTS A DELIBERATE DESIGN CHOICE.
 * `server.ts` arms a 60-second idle shutdown at boot and exits once no browser
 * holds an SSE stream, so that `chat-mcp web` is not a persistent daemon. That
 * exit was rejected as a bug once and kept on purpose.
 *
 * A supervisor posting every 250ms while an agent works would hold the server
 * up FOREVER if `/api/activity` counted as activity for that timer. The timer
 * keys on `sseClients` membership alone, so this asserts the route never
 * touches that set.
 */
test("🛑 an activity POST does NOT keep the web server alive", async () => {
  const h = await harness();

  try {
    const before = h.sseClients.size;

    let armed = 0;
    let disarmed = 0;
    const realAdd = h.sseClients.add.bind(h.sseClients);
    const realDelete = h.sseClients.delete.bind(h.sseClients);
    h.sseClients.add = (c: ServerResponse) => {
      disarmed++;
      return realAdd(c);
    };
    h.sseClients.delete = (c: ServerResponse) => {
      armed++;
      return realDelete(c);
    };

    for (let i = 0; i < 5; i++)
      await post(h, { handle: "claude2", phase: "tick" });

    assert.equal(
      h.sseClients.size,
      before,
      "the route changed the SSE client set",
    );
    assert.equal(
      disarmed,
      0,
      "the route added an SSE client, which DISARMS the idle shutdown",
    );
    assert.equal(armed, 0, "the route removed an SSE client");
    assert.equal(
      h.frames.length,
      5,
      "the posts did not reach the browser at all",
    );
  } finally {
    close(h);
  }
});

test("🛑 an unauthenticated POST is refused and tells no browser anything", async () => {
  const h = await harness();

  try {
    const res = await post(h, { handle: "claude2", phase: "tick" }, null);

    assert.equal(res.status, 401);
    // A refusal that still fanned out would let any local process pulse any
    // agent's dot.
    assert.deepEqual(h.frames, []);
  } finally {
    close(h);
  }
});

test("🛑 the route is CLASSIFIED as write, not caught by the admin fallback", () => {
  // `requiredCapability` returns 'admin' for any unrecognised /api/* path, so
  // an unclassified route is reachable only by an admin credential and fails
  // closed. That is safe and wrong: a pulse is not an admin action.
  assert.equal(requiredCapability("POST", "/api/activity"), "write");

  // ⚠️ AND A GET MUST NOT BE A READ SURFACE. There is nothing to read here, and
  // the Origin guard cannot protect a GET that mutates.
  assert.equal(requiredCapability("GET", "/api/activity"), "admin");
});

test("⚠️ a malformed body is refused rather than fanned out", async () => {
  const h = await harness();

  try {
    const missing = await post(h, { phase: "tick" });
    assert.equal(missing.status, 400, "a handle-less pulse was accepted");

    const wrong = await post(h, {
      handle: "claude2",
      phase: "thinking-really-hard",
    });
    assert.equal(wrong.status, 400, "an unknown phase was accepted");

    // 🛑 NOTHING REACHED THE BROWSER. A client that trusted the phase string
    // would switch on a value this server never promised.
    assert.deepEqual(h.frames, []);
  } finally {
    close(h);
  }
});

/**
 * ⚠️ A WRITE TO A HUNG BROWSER MUST NOT TAKE THE ROUTE DOWN. The other fan-out
 * sites in `server.ts` each wrap `res.write` in try/catch for this, and a
 * pulse fires far more often than any of them.
 */
test("⚠️ one dead browser does not stop the others being told", async () => {
  const h = await harness();

  try {
    h.sseClients.add({
      write: () => {
        throw new Error("client hung up mid-write");
      },
    } as unknown as ServerResponse);

    const res = await post(h, { handle: "claude2", phase: "tick" });

    assert.equal(res.status, 200, "a dead client turned the pulse into a 500");
    assert.equal(h.frames.length, 1, "the live client was skipped");
  } finally {
    close(h);
  }
});
