import { test } from "node:test";
import assert from "node:assert/strict";
import { reportsContextOf } from "../../../src/cli/web/server.js";
import { childHandleFor } from "../../../src/supervise/grant.js";
import type { RegistrationConfig } from "../../../src/supervise/registrations.js";

/**
 * #371 — the join between `agents.json` and a gauge row.
 *
 * 🛑 THE PAYLOAD GUARD IN `gauge-payload-scope.test.ts` CANNOT REACH THIS.
 * That one asserts both payloads ship the field; it says nothing about what the
 * field holds. MEASURED: dropping `supervisorHandleFor` here — so every
 * supervised child looks itself up under the wrong key — passed 50 of 50.
 */

const CONFIG: RegistrationConfig = {
  agents: {
    c1docker: { vendor: "cursor", mode: "docker" },
    c1host: { vendor: "claude", mode: "host" },
    typo: { vendor: "cursr", mode: "docker" },
  },
};

/**
 * 🛑 THE WHOLE MECHANISM. `agents.json` is keyed by the SUPERVISOR's handle and
 * every gauge row is keyed by its CHILD's, which differ by a suffix. Without
 * the inverse a supervised agent — the only kind that has a vendor at all —
 * reads `null` and renders the blank this ticket exists to remove.
 */
test("🛑 a CHILD handle resolves through the supervisor's registration", () => {
  const child = childHandleFor("c1docker");

  assert.notEqual(
    child,
    "c1docker",
    "the suffix is gone, so this proves nothing",
  );
  assert.equal(reportsContextOf(CONFIG, child), false);
  assert.equal(reportsContextOf(CONFIG, childHandleFor("c1host")), true);
});

/** The supervisor's own handle still resolves, since the peer list holds both. */
test("a SUPERVISOR handle resolves directly", () => {
  assert.equal(reportsContextOf(CONFIG, "c1docker"), false);
  assert.equal(reportsContextOf(CONFIG, "c1host"), true);
});

/**
 * 🛑 `null`, NEVER `false`. An unregistered handle's vendor is unknown, and
 * "n/a" is a claim about a CLI nobody has identified.
 */
test("🛑 an unregistered handle is unknown, not unreported", () => {
  assert.equal(reportsContextOf(CONFIG, "lee"), null);
  assert.equal(reportsContextOf(CONFIG, childHandleFor("lee")), null);
  assert.equal(reportsContextOf({ agents: {} }, "c1docker"), null);
});

/**
 * ⚠️ `registerAgent` DOES NOT CHECK SPAWNABILITY, deliberately — `agents.json`
 * is the operator-edited half, so a typo is the workflow. It must read as
 * unknown rather than take the row down.
 */
test("🛑 a vendor typo in agents.json is unknown, and does NOT throw", () => {
  assert.equal(reportsContextOf(CONFIG, "typo"), null);
});

/**
 * ⚠️ A HANDLE A HUMAN CHOSE ENDING IN `-agent` LOOKS LIKE A CHILD to the
 * inverse, which `supervisorHandleFor`'s own header records. The fallback to
 * the handle itself is what keeps such a registration readable.
 */
test("a registered handle that itself ends in the child suffix still resolves", () => {
  const cfg: RegistrationConfig = {
    agents: { "weird-agent": { vendor: "cursor", mode: "docker" } },
  };

  assert.equal(reportsContextOf(cfg, "weird-agent"), false);
});
