import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";

import { listenWithRoute } from "./route-server.js";

/**
 * The shared web-route test harness — #426.
 *
 * 🛑 EVERY WEB-ROUTE HARNESS CALLED `void route(req, res, ctx)` WITH NO CATCH,
 * and the unmigrated ones still do. `route` is async, so a throw became an
 * unhandled rejection: the request went unanswered, the awaiting `fetch` never
 * resolved, and that file's server was never closed, so the RUN HUNG instead
 * of reporting.
 *
 * ⚠️ IT DID NOT KILL THE PROCESS. The failing test is still named and still
 * carries a stack, and later tests in the file still run.
 *
 * 🛑 THE HARNESS TAKES `route` AS AN ARGUMENT AND MUST KEEP DOING SO. Every
 * caller sets `CHAT_MCP_HOME` to a tmpdir and then `await import`s the server,
 * because a static import would resolve state paths against the operator's
 * real files. A harness that imported `route` itself would defeat that.
 */

type Ctx = { readonly label: string };

const boom = new Error("the route threw");

test("🔴 a route that THROWS answers 500 with the message, not a dead process", async () => {
  const h = await listenWithRoute<Ctx>(() => Promise.reject(boom), {
    label: "throws",
  });

  const res = await fetch(h.origin);

  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: "the route threw" });

  h.close();
});

test("🔴 a route that ANSWERS is left alone, so the catch is not a rewrite", async () => {
  const h = await listenWithRoute<Ctx>(
    (_req: IncomingMessage, res: ServerResponse, ctx: Ctx) => {
      res.statusCode = 201;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: ctx.label }));
      return Promise.resolve();
    },
    { label: "answers" },
  );

  const res = await fetch(h.origin);

  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { ok: "answers" });

  h.close();
});

/**
 * 🛑 THE PAIRED CONTROL FOR THE `headersSent` GUARD. Production checks it, so
 * a harness without the check would throw a SECOND time inside the catch and
 * hang the run again — the exact failure the harness exists to stop, moved
 * one frame along.
 */
test("🔴 a throw AFTER the response started does not write a second time", async () => {
  const h = await listenWithRoute<Ctx>(
    (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 200;
      res.end("already sent");
      return Promise.reject(boom);
    },
    { label: "late throw" },
  );

  const res = await fetch(h.origin);

  assert.equal(res.status, 200);
  assert.equal(await res.text(), "already sent");

  h.close();
});

/**
 * 🛑 A THROW IS NOT ALWAYS AN `Error`, AND A CAST IS NOT A CHECK. `(err as
 * Error).message` is `undefined` for a thrown string and THROWS for a thrown
 * null — a second throw, inside the catch, which is #426's own defect moved one
 * frame along. Production coerces with `err instanceof Error ? err.message :
 * String(err)` at `runWeb`'s request handler in `server.ts`, so these three cases pin the harness to it.
 *
 * ⚠️ `test/cli/web/api-agents-plan.test.ts` CARRIED THE CAST, and #426's body
 * named that file as the one to copy. This agent copied it. Raised by claude2
 * reviewing PR 442, reproduced against the production server.
 */
for (const [label, thrown, expected] of [
  ["an Error", boom, "the route threw"],
  ["a string", "bare string", "bare string"],
  ["null", null, "null"],
] as const) {
  test(`🔴 a route that throws ${label} still answers 500 with a MESSAGE`, async () => {
    const h = await listenWithRoute<Ctx>(() => Promise.reject(thrown), {
      label,
    });

    const res = await fetch(h.origin);

    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { error: expected });

    h.close();
  });
}

test("🔴 the harness reports the port it bound, so a ctx can be completed", async () => {
  const h = await listenWithRoute<Ctx>(
    (_req: IncomingMessage, res: ServerResponse) => {
      res.end("ok");
      return Promise.resolve();
    },
    { label: "port" },
  );

  assert.ok(h.port > 0, `expected a bound port, got ${h.port}`);
  assert.equal(h.origin, `http://127.0.0.1:${h.port}`);

  h.close();
});
