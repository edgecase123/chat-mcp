import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 🛑 A SYNTAX ERROR IN `app.js` PASSED 564 GREEN TESTS AND BLANKED THE PAGE.
 *
 * 2026-11-24, on #397 slice 3b: an edit left a dangling `: []),` and the whole
 * module failed to parse. Every `*-wiring` test reads `app.js` as TEXT and none
 * executes it, so the suite could not see it. It was found by opening the page.
 *
 * 🛑 THIS IS NOT TYPE-CHECKING, AND lee's #177 RULING DOES NOT REACH IT.
 * `node --check` parses and stops. It cannot see a type, and — measured below
 * in this file's own history — it cannot see a free variable either. The
 * `web/assets` type debt stays exactly as unpaid as lee left it.
 *
 * 🛑 THE GATE ALREADY HAD ONE INSTRUMENT FOR THIS and it was defeated by hand:
 * `prettier --check` fails on unparseable input, but the author ran
 * `prettier --write … >/dev/null 2>&1` between edits and never read the exit
 * code. A test cannot be silenced that way.
 *
 * ⚠️ WHAT THIS DOES NOT CATCH, so nobody reads it as more than it is:
 *
 * | injected into `app.js`      | `node --check` |
 * | --------------------------- | -------------- |
 * | an unbalanced bracket       | EXIT 1         |
 * | a free variable (`key`)     | EXIT 0         |
 *
 * The second row is `TS2304`'s job and needs a ruling this does not.
 */

const ASSETS = join(import.meta.dirname, "..", "..", "web", "assets");

/** Every browser module actually on disk, so the count has a denominator. */
function assetModules(): string[] {
  return readdirSync(ASSETS)
    .filter((f) => f.endsWith(".js"))
    .sort();
}

test("🛑 every web/assets module PARSES, or the page is blank and the suite is green", () => {
  const modules = assetModules();

  // 🛑 THE DENOMINATOR. A glob that matched nothing would pass the loop below
  // without parsing a single file, which is the exact shape of a guard that
  // reports clean because it is pointed at an empty set.
  assert.ok(
    modules.length >= 3,
    `expected at least 3 browser modules, found ${modules.length}: ${modules.join(", ")}`,
  );

  const broken = modules.filter((file) => {
    try {
      execFileSync(process.execPath, ["--check", join(ASSETS, file)], {
        stdio: "pipe",
      });

      return false;
    } catch {
      return true;
    }
  });

  assert.deepEqual(broken, [], `these do not parse: ${broken.join(", ")}`);
});

/**
 * 🛑 THE INSTRUMENT'S OWN CONTROL, IN THE SUITE RATHER THAN IN A COMMENT.
 *
 * The test above passes if `node --check` silently stopped reporting errors —
 * a changed flag, a different `process.execPath`, a swallowed exit code. This
 * feeds it a file that CANNOT parse and asserts it says so.
 */
test("🔴 control — the same check REJECTS a module that does not parse", () => {
  const broken = join(import.meta.dirname, "fixtures", "unparseable.js.txt");

  assert.throws(
    () =>
      execFileSync(process.execPath, ["--check", broken], { stdio: "pipe" }),
    /Command failed|SyntaxError/,
    "node --check accepted a file with an unbalanced bracket",
  );
});
