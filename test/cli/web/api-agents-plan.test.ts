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

// 🛑 BEFORE any import that resolves a state path. `registrations.ts` reads
// `agents.json` and `container.ts` rewrites `container.json`, both out of the
// state dir — an import above this line would pin the operator's real files
// and this suite would record approvals against them.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "cm-agents-plan-"));

const { migrate } = await import("../../../src/storage/db.js");
const { route } = await import("../../../src/cli/web/server.js");
const { COOKIE_NAME, ALL_CAPABILITIES, ADMIN_ROUTES, READ_ROUTES } =
  await import("../../../src/cli/web/credential.js");
const { registerAgent } =
  await import("../../../src/supervise/registrations.js");
const { confirmVerdict, describePlan } =
  await import("../../../src/supervise/container.js");
const { buildConfirmPlan } =
  await import("../../../src/supervise/confirmPlan.js");
const { spawnFor, vendorsWithSpawn } =
  await import("../../../src/adapters/index.js");

/**
 * `GET /api/agents/plan` and `POST /api/agents/confirm` — #132 slice 4b.
 *
 * 🛑 THE PLAN LIVES ON ITS OWN ROUTE AND NOT ON `GET /api/agents`. Building a
 * plan needs `spawnFor`, which THROWS for a vendor this build cannot spawn,
 * and the store accepts any non-empty vendor string. On the list route one bad
 * row would 500 the whole card. "one bad row does not take the list down" is
 * the test that pins it.
 *
 * 🛑 NEITHER ROUTE IS `read`. The plan names mount paths, env var names and
 * the image, which together are a map of what the container is handed.
 */

const TOKEN = "token-for-the-agents-plan-tests";
const COOKIE = `${COOKIE_NAME}=${TOKEN}`;

const PLAN_PATH = "/api/agents/plan";
const CONFIRM_PATH = "/api/agents/confirm";

/** A vendor this build can really spawn, so the plan is the real one. */
const SPAWNABLE = vendorsWithSpawn()[0];

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

function planUrl(h: Harness, handle: string): string {
  return `${h.origin}${PLAN_PATH}?handle=${encodeURIComponent(handle)}`;
}

async function getPlan(h: Harness, handle: string): Promise<Response> {
  return fetch(planUrl(h, handle), { headers: { Cookie: COOKIE } });
}

async function postConfirm(h: Harness, body: unknown): Promise<Response> {
  return fetch(`${h.origin}${CONFIRM_PATH}`, {
    method: "POST",
    headers: { Cookie: COOKIE, Origin: h.origin },
    body: JSON.stringify(body),
  });
}

interface PlanBody {
  handle: string;
  verdict: string;
  plan: Record<string, unknown>;
  planText: string;
  changes: { field: string; from: string; to: string }[];
  changeText: string;
}

/** A handle nobody else in this file uses, so the state file cannot collide. */
let seq = 0;
function uniqueHandle(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

// ── GET /api/agents/plan ─────────────────────────────────────────────────

test("the plan route describes what the container gets, and reads UNSEEN first", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const handle = uniqueHandle("contained");
  registerAgent(handle, { vendor: SPAWNABLE, mode: "docker" });

  const res = await getPlan(h, handle);
  assert.equal(res.status, 200);

  const body = (await res.json()) as PlanBody;

  assert.equal(body.handle, handle);
  assert.equal(
    body.verdict,
    "unseen",
    "a handle nobody has approved must not read as confirmed",
  );
  assert.deepEqual(body.changes, [], "there is no prior plan to differ from");

  // 🛑 THE SAME PLAN THE SPAWN PATH WOULD BUILD, not a second copy of the
  // fields. A route that assembled its own would let the card show one image
  // and the container start on another.
  assert.deepEqual(
    body.plan,
    JSON.parse(JSON.stringify(buildConfirmPlan(spawnFor(SPAWNABLE), handle))),
  );
});

test("🛑 the operator-facing text is the TERMINAL banner, not a browser copy", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const handle = uniqueHandle("same-words");
  registerAgent(handle, { vendor: SPAWNABLE, mode: "docker" });

  const body = (await (await getPlan(h, handle)).json()) as PlanBody;

  // 🛑 `web/assets/logic.js` CANNOT IMPORT FROM `src/`, so without this the
  // card would need its own formatter — and `describePlan` carries rules a
  // reader depends on. This is what stops the two drifting.
  assert.equal(
    body.planText,
    describePlan(buildConfirmPlan(spawnFor(SPAWNABLE), handle)),
  );

  // Not purely structural: the text has to actually carry the image, which is
  // the field an override can replace under an operator.
  assert.match(body.planText, new RegExp(String(body.plan.image)));
  assert.equal(body.changeText, "", "an unseen plan has nothing to diff");
});

test("🛑 one unspawnable row 409s the PLAN route and does NOT take the list down", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const handle = uniqueHandle("typo-vendor");
  // The store takes any non-empty vendor string; `spawnFor` is what throws.
  registerAgent(handle, { vendor: "not-a-vendor", mode: "docker" });

  const res = await getPlan(h, handle);
  assert.equal(res.status, 409);
  assert.match(
    ((await res.json()) as { error: string }).error,
    /not-a-vendor/,
    "the refusal has to name the vendor the operator typed",
  );

  // 🛑 THE NON-VACUITY CONTROL FOR THE WHOLE ROUTE SPLIT. If the list route
  // also 500'd here, the 409 above would be describing a card that cannot
  // render at all.
  const list = await fetch(`${h.origin}/api/agents`, {
    headers: { Cookie: COOKIE },
  });
  assert.equal(list.status, 200, "one bad row must not 500 the card's list");
  const agents = ((await list.json()) as { agents: Record<string, unknown> })
    .agents;
  assert.ok(handle in agents, "the bad row still has to be listed");
});

test("an unregistered handle is a 404, never a plan built from a default", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const handle = uniqueHandle("never-registered");
  const res = await getPlan(h, handle);
  assert.equal(res.status, 404);

  // 🛑 THE BODY IS WHAT MAKES THIS TEST ABLE TO FAIL. An unrouted `/api/`
  // GET falls through to the static handler, which also answers 404 — so the
  // status alone greened before either route existed.
  const body = (await res.json()) as { error?: string };
  assert.match(
    body.error ?? "",
    new RegExp(handle),
    "the 404 has to come from the plan route and name the handle",
  );
});

test("🛑 a HOST handle has no container plan, and is refused rather than shown one", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const handle = uniqueHandle("loose");
  registerAgent(handle, { vendor: SPAWNABLE, mode: "host" });

  const res = await getPlan(h, handle);
  assert.equal(res.status, 409);
  assert.match(
    ((await res.json()) as { error: string }).error,
    /host/,
    "the refusal has to say the handle is not contained",
  );
});

test("🛑 an INHERITED key is a missing handle, not a record with no mode", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  // `agents` is a plain object, so `agents["__proto__"]` is truthy without
  // anything being registered. Read with `in` it would reach the mode check
  // and answer 409 "runs on the host" about a handle that does not exist.
  const res = await getPlan(h, "__proto__");
  assert.equal(res.status, 404);
  assert.match(((await res.json()) as { error: string }).error, /__proto__/);
});

test("a missing handle parameter is a 400, not a plan for the empty string", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const res = await fetch(`${h.origin}${PLAN_PATH}`, {
    headers: { Cookie: COOKIE },
  });
  assert.equal(res.status, 400);
});

// ── POST /api/agents/confirm ─────────────────────────────────────────────

test("confirming the plan the operator SAW records it, and the verdict flips", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const handle = uniqueHandle("approve-me");
  registerAgent(handle, { vendor: SPAWNABLE, mode: "docker" });

  const shown = ((await (await getPlan(h, handle)).json()) as PlanBody).plan;

  const res = await postConfirm(h, { handle, plan: shown });
  assert.equal(res.status, 200);

  // The CLI's own gate is what has to be satisfied, so it is what is asserted.
  assert.equal(
    confirmVerdict(handle, buildConfirmPlan(spawnFor(SPAWNABLE), handle)).kind,
    "confirmed",
  );

  const after = (await (await getPlan(h, handle)).json()) as PlanBody;
  assert.equal(after.verdict, "confirmed");
});

test("🛑 a STALE plan is a 409 naming the field, and confirms NOTHING", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const handle = uniqueHandle("moved-under-me");
  registerAgent(handle, { vendor: SPAWNABLE, mode: "docker" });

  const shown = ((await (await getPlan(h, handle)).json()) as PlanBody).plan;

  // What a plan that changed between the GET and the click looks like.
  const stale = { ...shown, image: "some-other-image:local" };

  const res = await postConfirm(h, { handle, plan: stale });
  assert.equal(res.status, 409);

  const body = (await res.json()) as {
    error: string;
    changes: unknown[];
    changeText: string;
  };
  assert.match(
    body.changeText,
    /image: some-other-image:local -> /,
    "the 409 carries the same one-line-per-change text the terminal re-prompt prints",
  );
  assert.deepEqual(
    body.changes,
    [
      {
        field: "image",
        from: "some-other-image:local",
        to: shown.image,
      },
    ],
    "the 409 has to name the field, because the operator cannot diff two banners by eye",
  );

  // 🛑 THE LOAD-BEARING HALF. A 409 that still wrote the approval would be
  // worse than no check at all.
  assert.equal(
    confirmVerdict(handle, buildConfirmPlan(spawnFor(SPAWNABLE), handle)).kind,
    "unseen",
    "a refused confirm must not record an approval",
  );
});

test("a confirm with no plan is a 400, never a bare handle approving a fresh build", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const handle = uniqueHandle("bare-post");
  registerAgent(handle, { vendor: SPAWNABLE, mode: "docker" });

  const res = await postConfirm(h, { handle });
  assert.equal(
    res.status,
    400,
    "a bare POST would approve a plan the operator never read",
  );

  assert.equal(
    confirmVerdict(handle, buildConfirmPlan(spawnFor(SPAWNABLE), handle)).kind,
    "unseen",
  );
});

test("confirming an unregistered handle is a 404", async (t) => {
  const h = await harness();
  t.after(() => close(h));

  const res = await postConfirm(h, {
    handle: uniqueHandle("ghost"),
    plan: { image: "x" },
  });
  assert.equal(res.status, 404);
});

// ── tiers ────────────────────────────────────────────────────────────────

test("🛑 both routes are admin, because the plan maps what the container is handed", async (t) => {
  const h = await harness(["read"]);
  t.after(() => close(h));

  const handle = uniqueHandle("tier-check");
  registerAgent(handle, { vendor: SPAWNABLE, mode: "docker" });

  assert.equal((await getPlan(h, handle)).status, 403);
  assert.equal((await postConfirm(h, { handle, plan: {} })).status, 403);
});

/**
 * ⚠️ THE 403 ABOVE CANNOT TELL A CLASSIFIED ROUTE FROM A FORGOTTEN ONE.
 * `requiredCapability` returns `admin` for any unlisted `/api/` path, so that
 * test greens on a route nobody added to the set. `credential.ts` says it in
 * as many words: "a return value cannot tell a classified route from a
 * forgotten one. Membership can." This is the half that can.
 */

test("🛑 both paths are CLASSIFIED admin and in neither read set", () => {
  for (const path of [PLAN_PATH, CONFIRM_PATH]) {
    assert.ok(
      ADMIN_ROUTES.has(path),
      `${path} is absent from ADMIN_ROUTES, so the tier-intersection test cannot see it`,
    );
    assert.ok(
      !READ_ROUTES.has(path),
      `${path} in READ_ROUTES would downgrade a GET on it to read`,
    );
  }
});
