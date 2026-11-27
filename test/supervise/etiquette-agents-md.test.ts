import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ETIQUETTE_RULES,
  etiquetteBody,
} from "../../src/supervise/etiquette.js";

/* ==========================================================================
 * 🛑 THE DRIFT GUARD, AND IT IS THE POINT OF THE WHOLE FEATURE. `AGENTS.md`
 * already held the tag rule and the claim rule, both agents had it on disk all
 * day, and between them they made 58 untagged room posts — 1 compliant of 59,
 * counted off `chat.db`. Delivery was the gap, so the sandbox now gets its own
 * copy.
 *
 * 🛑 TWO COPIES OF A RULE DRIFT, AND THE DRIFTED ONE IS THE ONE IN THE SANDBOX
 * where nobody reads it. Every rule therefore carries an `anchor` that must
 * appear verbatim in `AGENTS.md`, and this file is what makes a reworded
 * heading a RED TEST rather than a silent divergence.
 * ========================================================================== */

const AGENTS_MD = readFileSync(join(process.cwd(), "AGENTS.md"), "utf8");

test("🛑 every etiquette rule is anchored in AGENTS.md, so the two copies cannot drift", () => {
  const missing = ETIQUETTE_RULES.filter(
    ({ anchor }) => !AGENTS_MD.includes(anchor),
  ).map(({ anchor }) => anchor);

  assert.deepEqual(
    missing,
    [],
    `anchors absent from AGENTS.md: ${missing.join(" | ")}`,
  );
});

/**
 * ⚠️ PRINTS ITS OWN DENOMINATOR. A list that lost every entry would satisfy the
 * test above vacuously — `filter` over nothing is empty — so the count is
 * asserted beside it.
 */
test("🛑 the rule list is non-empty, because an empty one passes the anchor check vacuously", () => {
  assert.ok(
    ETIQUETTE_RULES.length >= 3,
    `only ${ETIQUETTE_RULES.length} etiquette rules`,
  );
});

/**
 * 🛑 EVERY RULE OWES A REASON. An agent handed a bare instruction re-derives
 * its own justification, and the one it invents is the one it will trade away
 * under pressure.
 */
test("every rule carries both an instruction and the cost of breaking it", () => {
  for (const { rule, why, anchor } of ETIQUETTE_RULES) {
    assert.ok(rule.length > 20, `rule too short to be actionable: ${rule}`);
    assert.ok(why.length > 20, `no stated cost for: ${rule}`);
    assert.ok(anchor.length > 10, `anchor too weak to pin anything: ${anchor}`);
  }
});

/**
 * 🛑 THE RENDERED FILE MUST CARRY EVERY RULE'S OWN TEXT. A body built from a
 * stale constant, or a template that silently dropped the loop, is green on
 * every assertion above — they all read the ARRAY, never the output.
 */
test("🔴 the rendered body contains every rule's own words, not just the headings", () => {
  const body = etiquetteBody();

  for (const { rule, why } of ETIQUETTE_RULES) {
    assert.ok(body.includes(rule), `body omits the rule: ${rule}`);
    assert.ok(body.includes(why), `body omits the cost: ${why}`);
  }
});

/**
 * ⚠️ lee's MINIMUM WAS TWO THINGS, NOT ONE: *"connect to chat as we've done and
 * an etiquette file or blurb"*. A file with perfect etiquette and no way to
 * reach the bus satisfies half the ask and reads as complete.
 */
test("🛑 the body also tells the agent how to READ the bus, which was half of the ask", () => {
  const body = etiquetteBody();

  for (const tool of ["inbox", "room_inbox", "room_join", "claim", "whoami"]) {
    assert.ok(body.includes(tool), `the connect section never names ${tool}`);
  }
});

/**
 * 🛑 THE ACCESSIBILITY RULES MUST NOT LEAK IN HERE. `chat-mcp` is a PUBLIC
 * repo and `leagues` is private, and lee's comms rules stay local in both. The
 * word lee chose — "etiquette" — is what makes this file publishable, so a
 * later edit that pulls his diagnosis in is the regression this pins.
 */
test("🚨 the body names no diagnosis and no accessibility detail, because this repo is PUBLIC", () => {
  const body = etiquetteBody().toLowerCase();

  for (const leak of ["asd", "autis", "working memory", "accessibility"]) {
    assert.ok(!body.includes(leak), `the body leaks "${leak}"`);
  }
});
