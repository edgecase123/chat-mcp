import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTestTotals, verdictFor } from "../../scripts/lib/gate-totals.mjs";

/**
 * 🛑 THIS FILE EXISTS BECAUSE A 15-HOUR HANG REPORTED ZERO FAILURES.
 *
 * pid 84590 ran `node --test` for 15h 22m. Its log showed typecheck EXIT 0 and
 * clean formatting, then nothing from the test step — no verdict, no totals.
 * A grep for `fail` or `not ok` over that log is indistinguishable from a
 * clean sweep, and that is how "11 tests green" got into a status file for a
 * number no run ever produced.
 *
 * The fixtures below are REAL `node --test` output, not hand-written. A
 * hand-written block is a guess at what the runner prints.
 */

const REPO = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Captured verbatim from `node --test --test-timeout=500` against a test that
 * sleeps 3s. 🛑 NOTE `fail 0` BESIDE `cancelled 1` — that is the whole point.
 */
const TIMED_OUT = `ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 0
ℹ cancelled 1
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 506.978917
`;
// Tail trimmed at the totals block: the runner's `✖ failing tests:` section
// names a file and line, and `stale-line-pointers` forbids that in a comment.
// It said `'test timed out after 500ms'`, which is the only thing it added.

/** The same runner, same file, a timeout it fits inside. */
const GREEN = `ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3005.1
`;

test("a timed-out run is RED, and `fail` is not what says so", () => {
  const totals = parseTestTotals(TIMED_OUT);

  assert.equal(totals.fail, 0, "the fixture must really report zero failures");
  assert.equal(totals.cancelled, 1);

  const v = verdictFor(totals);
  assert.equal(v.ok, false);
  assert.match(v.reason, /cancelled/);
});

test("the discriminator is real: a fail-only check calls that same run clean", () => {
  // Without this, the test above passes just as well against a parser that
  // ruled on something else. This is the control for the claim in the header.
  assert.equal(/^\D*\bfail\s+[1-9]/m.test(TIMED_OUT), false);
  assert.equal(verdictFor(parseTestTotals(TIMED_OUT)).ok, false);
});

test("a genuinely green run is GREEN", () => {
  const v = verdictFor(parseTestTotals(GREEN));
  assert.equal(v.ok, true);
  assert.match(v.reason, /1 of 1/);
});

test("🛑 output with NO totals block THROWS rather than reporting zeroes", () => {
  assert.throws(
    () =>
      parseTestTotals("typecheck EXIT 0\nprettier: all matched files use\n"),
    /no totals block/,
  );
});

test("a PARTIAL totals block throws and names what was missing", () => {
  const partial = GREEN.split("\n")
    .filter((l) => !l.includes("cancelled"))
    .join("\n");
  assert.throws(() => parseTestTotals(partial), /missing cancelled/);
});

test("totals that do not add up are RED even with zero failures", () => {
  const totals = {
    tests: 10,
    pass: 4,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  };
  const v = verdictFor(totals);
  assert.equal(v.ok, false);
  assert.match(v.reason, /do not add up/);
});

test("the glyph is not load-bearing — a stripped transcript parses the same", () => {
  // The same lines arrive with the `ℹ` escaped, entity-encoded or gone
  // depending on who piped them. A glyph-anchored match returns nothing and
  // reads as a clean parse.
  const stripped = TIMED_OUT.replace(/ℹ /g, "");
  assert.deepEqual(parseTestTotals(stripped), parseTestTotals(TIMED_OUT));
});

test("package.json carries BOTH halves of the fix", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  assert.match(
    pkg.scripts.gate ?? "",
    /scripts\/gate\.sh/,
    "there is no gate script",
  );
  assert.match(
    pkg.scripts.test ?? "",
    /--test-timeout=\d+/,
    "a bare `npm test` must not be able to hang forever",
  );
});

test("🛑 gate.sh hardcodes no worktree path — that was the defect it replaces", () => {
  // `snippets/gate.sh` was pinned to one worktree, so the agent in the other
  // one was told not to run it. Two agents, one script, one of them gateless.
  const src = readFileSync(join(REPO, "scripts", "gate.sh"), "utf8");
  assert.equal(/\/Users\/|\/home\/|dev\/chat-mcp/.test(src), false);
  assert.match(
    src,
    /BASH_SOURCE/,
    "the root must be derived from the script's own location",
  );
});

/** gate.sh in a throwaway git repo, so $REPO is the temp dir, not this one. */
function gateIn(dir: string, args: string[]): number {
  try {
    execFileSync("bash", [join(dir, "scripts", "gate.sh"), ...args], {
      stdio: "pipe",
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

test("gate.sh: help is 0, a bad argument is 2, a dirty tree is 3", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-mcp-gate-"));
  mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
  cpSync(join(REPO, "scripts", "gate.sh"), join(dir, "scripts", "gate.sh"));
  cpSync(
    join(REPO, "scripts", "lib", "gate-totals.mjs"),
    join(dir, "scripts", "lib", "gate-totals.mjs"),
  );
  execFileSync("git", ["init", "-q"], { cwd: dir });

  assert.equal(gateIn(dir, ["--help"]), 0, "help is not an error");
  assert.equal(gateIn(dir, ["--bogus"]), 2, "an unknown argument is bad usage");

  writeFileSync(join(dir, "uncommitted.txt"), "x");
  assert.equal(gateIn(dir, []), 3, "🛑 a dirty tree must REFUSE, not gate");
});
