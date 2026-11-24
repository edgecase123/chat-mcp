import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 🛑 A SYNTAX ERROR IN `app.js` BLANKED THE PAGE AND 564 TESTS STAYED GREEN.
 *
 * 2026-11-24, on #397 slice 3b: an edit left a dangling `: []),` and the module
 * failed to parse. Every `*-wiring` test reads `app.js` as TEXT and none
 * executes it, so the suite could not see it. It was found by opening the page.
 *
 * 🛑 THE COPY TO `.mjs` IS THE WHOLE INSTRUMENT, AND THE REASON IS NOT THE
 * EXTENSION — IT IS `package.json`.
 *
 * `node --check` decides whether a `.js` file is a module from the nearest
 * `package.json` `type` field. This repo sets `"type": "module"`, so a plain
 * `node --check web/assets/app.js` DOES report a syntax error today. Move the
 * same bytes outside the package and it reports nothing:
 *
 *   identical content, one unclosed brace appended
 *     inside this repo   (type: module)      rc=1   caught
 *     outside any package                    rc=0   SILENT, 0 bytes of output
 *
 * ⚠️ SO THE GUARD WOULD WORK ON `.js` TODAY AND IS ONE FIELD AWAY FROM GOING
 * BLIND. Dropping `"type": "module"` from `package.json` — which a bundler
 * migration does without thinking about this file — turns every assertion here
 * green and meaningless. The `.mjs` copy states the semantics instead of
 * inheriting them.
 *
 * ⚠️ TWO AGENTS POSTED CONTRADICTORY PER-FILE TABLES BEFORE FINDING THAT.
 * Both were measuring honestly; neither had varied the directory. There is no
 * per-file table in this docblock on purpose.
 *
 * 🛑 ONE OF THOSE TABLES WAS ALSO CORRUPTED BY THE SHELL, and it will do it
 * again:
 *
 *   false; echo "$(grep -c x file) -> EXIT=$?"     prints EXIT=0
 *
 * A command substitution EARLIER IN THE SAME LINE runs first and clobbers
 * `$?`. Read an exit code on a line of its own.
 *
 * 🛑 THIS IS NOT TYPE-CHECKING, AND lee's #177 RULING DOES NOT REACH IT. A
 * parse check cannot see a type, and the control below proves it cannot see a
 * free variable either. The `web/assets` type debt stays exactly as lee left it.
 *
 * 🛑 THE GATE ALREADY HAD AN INSTRUMENT FOR THIS and it was defeated by hand:
 * `prettier --check` fails on unparseable input, but the author ran
 * `prettier --write … >/dev/null 2>&1` between edits and never read the exit
 * code. A test cannot be silenced that way.
 */

const ASSETS = join(import.meta.dirname, "..", "..", "web", "assets");

/** Every browser module on disk, so the count has a denominator. */
function assetModules(): string[] {
  return readdirSync(ASSETS)
    .filter((f) => f.endsWith(".js"))
    .sort();
}

/**
 * Parse one file under MODULE semantics, whatever its extension.
 *
 * 🛑 THE COPY TO `.mjs` IS NOT TIDINESS. It is the difference between a check
 * that reports and one that returns 0 for everything — see the table above.
 */
function parses(path: string): boolean {
  const dir = mkdtempSync(join(tmpdir(), "parse-check-"));
  const copy = join(dir, "module.mjs");

  try {
    copyFileSync(path, copy);
    execFileSync(process.execPath, ["--check", copy], { stdio: "pipe" });

    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("🛑 every web/assets module PARSES, or the page is blank and the suite is green", () => {
  const modules = assetModules();

  // 🛑 THE DENOMINATOR. A glob that matched nothing would pass the filter below
  // without parsing a single file.
  assert.ok(
    modules.length >= 3,
    `expected at least 3 browser modules, found ${modules.length}: ${modules.join(", ")}`,
  );

  const broken = modules.filter((file) => !parses(join(ASSETS, file)));

  assert.deepEqual(broken, [], `these do not parse: ${broken.join(", ")}`);
});

/**
 * 🛑 THE INSTRUMENT'S CONTROL, AND THE FIRST ONE WAS VACUOUS.
 *
 * It fed a fixture carrying BOTH an `export` and a bracket error, and asserted
 * it was rejected. Measured afterwards: the same fixture with the bracket error
 * REMOVED is rejected too, under the `.js` path, purely for the `export`. It
 * proved nothing about brackets.
 *
 * These two assert the discrimination directly: same module semantics, one file
 * with the real defect's shape and one without.
 */
test("🔴 control — the check REJECTS the real defect's shape and ACCEPTS it fixed", () => {
  const dir = join(import.meta.dirname, "fixtures");

  assert.equal(
    parses(join(dir, "unparseable.js.txt")),
    false,
    "the check accepted an unbalanced bracket",
  );
  assert.equal(
    parses(join(dir, "parseable.js.txt")),
    true,
    "the check rejected a file that is fine, so a pass means nothing",
  );
});

/**
 * ⚠️ THE DOCUMENTED BOUNDARY, ASSERTED RATHER THAN PROMISED. A free variable
 * is `TS2304`'s job and needs a ruling this check does not. Without this, the
 * file reads as covering a class it cannot see.
 */
test("⚠️ a free variable PARSES — this guard is not a typechecker", () => {
  assert.equal(
    parses(join(import.meta.dirname, "fixtures", "free-variable.js.txt")),
    true,
  );
});
