import { test } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { classify, verdict } from "../../scripts/file-death-reporter.mjs";

const REPORTER = fileURLToPath(
  new URL("../../scripts/file-death-reporter.mjs", import.meta.url),
);
const DIES = fileURLToPath(
  new URL("../support/fixtures/dies-at-import.fixture.ts", import.meta.url),
);
const ORDINARY = fileURLToPath(
  new URL("../support/fixtures/ordinary-fail.fixture.ts", import.meta.url),
);

function failEvent(name: string, file: string, line: number, column: number) {
  return { type: "test:fail", data: { name, file, line, column, nesting: 0 } };
}

/**
 * Composes `classify` then `verdict`, so a case cannot pass on a shape
 * `classify` would never produce.
 *
 * 🛑 `alsoSeen` IS NOT OPTIONAL DETAIL — IT PICKS THE BRANCH. The reporter
 * learns the files that did NOT fail from their passing events; this helper is
 * handed failures only. A case that omits them makes every seen file a dead
 * one, which silently measures the broken-install branch.
 */
function verdictFor(
  events: ReturnType<typeof failEvent>[],
  alsoSeen: string[] = [],
): string | null {
  const filesSeen = new Set([...events.map((e) => e.data.file), ...alsoSeen]);
  return verdict({ ...classify(events), filesSeen });
}

/**
 * 🛑 `NODE_TEST_CONTEXT` MUST BE STRIPPED FROM THE CHILD. The runner sets it to
 * `child-v8`, a child inherits it, and Node then emits v8-serialized output and
 * IGNORES `--test-reporter` entirely. The child produces an empty stdout and the
 * reporter looks broken when it is not.
 */
function runWithReporter(file: string): string {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;

  try {
    execFileSync(
      process.execPath,
      ["--test", "--import", "tsx", `--test-reporter=${REPORTER}`, file],
      { encoding: "utf8", cwd: process.cwd(), env },
    );
  } catch (e) {
    return `${(e as { stdout?: string }).stdout ?? ""}`;
  }

  assert.fail(`${file} must make the run non-zero`);
}

/**
 * 🛑 THE DISCRIMINATOR IS `name === file`, NOT AN ERROR STRING.
 * `ERR_MODULE_NOT_FOUND` had ZERO hits in #427's third occurrence, so a
 * detector keyed on the message misses it.
 */
test("🔴 a failure whose name IS its file is a FILE DEATH", () => {
  const { fileDeaths, testFailures } = classify([
    failEvent("/r/test/a.test.ts", "/r/test/a.test.ts", 1, 1),
  ]);

  assert.deepEqual(
    fileDeaths.map((d) => d.file),
    ["/r/test/a.test.ts"],
  );
  assert.deepEqual(testFailures, []);
});

/**
 * 🛑 THE PRODUCTION SHAPE. `npm test` passes a GLOB, so Node reports `name` as
 * the RELATIVE path and `file` as the absolute one. A literal `name === file`
 * is false for every real occurrence, and only this case expresses that.
 */
test("🔴 a RELATIVE name against an ABSOLUTE file is still a file death", () => {
  const { fileDeaths } = classify([
    failEvent(
      "test/web/sidebar-planner.test.ts",
      `${process.cwd()}/test/web/sidebar-planner.test.ts`,
      1,
      1,
    ),
  ]);

  assert.equal(fileDeaths.length, 1, "a relative name must still match");
});

test("🔴 an ordinary assertion failure is NOT a file death", () => {
  const { fileDeaths, testFailures } = classify([
    failEvent("a child event PULSES", "/r/test/a.test.ts", 2, 877),
  ]);

  assert.deepEqual(fileDeaths, []);
  assert.deepEqual(
    testFailures.map((f) => f.name),
    ["a child event PULSES"],
  );
});

test("🔴 no file deaths yields NO verdict, so a normal red is unchanged", () => {
  const v = verdictFor([failEvent("a real test", "/r/test/a.test.ts", 2, 9)]);

  assert.equal(v, null);
});

test("🔴 one dead file names THAT FILE and the re-run that confirms it", () => {
  const dead = "/r/test/web/sidebar.test.ts";
  const v = verdictFor([
    failEvent(dead, dead, 1, 1),
    failEvent("a test that ran fine elsewhere", "/r/test/b.test.ts", 2, 9),
  ]);

  assert.ok(v, "expected a verdict");
  assert.match(v, /sidebar\.test\.ts/);
  assert.match(v, /#427/);
  assert.match(v, /NOT the change under test/);
});

/**
 * 🛑 THE BRANCH TURNS ON THE FILES THAT DID *NOT* FAIL, SO A CASE MUST NAME
 * THEM. The reporter learns them from passing events; this helper is handed
 * failures only. A case that forgets them silently measures the `npm ci`
 * branch instead of the per-file one. claude1 found this in review of PR 439.
 */
test("🔴 files that DIE beside one that PASSES is #427, not a broken install", () => {
  const dead = ["/r/test/a.test.ts", "/r/test/b.test.ts"];
  const v = verdictFor(
    dead.map((f) => failEvent(f, f, 1, 1)),
    ["/r/test/passes.test.ts"],
  );

  assert.ok(v, "expected a verdict");
  assert.match(v, /#427/);
  assert.doesNotMatch(
    v,
    /npm ci/,
    "2 dead of 3 seen is NOT a broken install — and with the passing file " +
      "omitted it would be 2 of 2, which is",
  );
});

/**
 * 🛑 EVERY FILE DEAD IS A BROKEN ENVIRONMENT, NOT #427. A fresh worktree with
 * no `node_modules` reports EVERY file as `✖`, and calling that #427 would
 * send the reader to the wrong diagnosis.
 */
test("🔴 EVERY file dead reads as a broken environment, not #427", () => {
  const files = ["/r/test/a.test.ts", "/r/test/b.test.ts"];
  const v = verdictFor(files.map((f) => failEvent(f, f, 1, 1)));

  assert.ok(v, "expected a verdict");
  assert.match(v, /npm ci/);
  assert.doesNotMatch(v, /#427/);
});

/**
 * 🛑 THIS REPORTER ADDS A DIAGNOSIS, IT DOES NOT REPLACE THE OUTPUT. Passed
 * alone it is the ONLY reporter, so the normal run output disappears. The
 * supported wiring is alongside `spec`, and this is the case that pins it.
 */
test("🔴 it composes with `spec`, which keeps the normal output", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;

  let out = "";
  try {
    execFileSync(
      process.execPath,
      [
        "--test",
        "--import",
        "tsx",
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        `--test-reporter=${REPORTER}`,
        "--test-reporter-destination=stdout",
        DIES,
      ],
      { encoding: "utf8", cwd: process.cwd(), env },
    );
    assert.fail("the dying fixture must make the run non-zero");
  } catch (e) {
    out = `${(e as { stdout?: string }).stdout ?? ""}`;
  }

  assert.match(out, /ℹ tests \d+/, "spec's summary must survive");
  assert.match(out, /#427/, "and the diagnosis must still land");
  assert.ok(
    out.indexOf("#427") > out.indexOf("ℹ tests"),
    "the diagnosis must come LAST, where a reader looks",
  );
});

/** End to end: the banner must reach real stdout, not just the pure function. */
test("🔴 the reporter prints the #427 banner for a file that dies at import", () => {
  const out = runWithReporter(DIES);

  assert.match(out, /#427/);
  assert.match(out, /dies-at-import\.fixture\.ts/);
});

/**
 * 🛑 THE GLOB PATH, WHICH IS THE ONE `npm test` USES. Every other end-to-end
 * case here passes ONE ABSOLUTE path, so `name` arrives absolute and a literal
 * string comparison would pass. A glob makes Node report a RELATIVE `name`
 * against an ABSOLUTE `file`, which is the shape that broke the first cut.
 *
 * It also proves the diagnosis is SELECTIVE: two files go in, one dies, and
 * only the dead one is named. claude1's review found this gap.
 */
test("🔴 under a GLOB it names the dead file and leaves the live one alone", () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;

  let out = "";
  try {
    execFileSync(
      process.execPath,
      [
        "--test",
        "--import",
        "tsx",
        `--test-reporter=${REPORTER}`,
        "test/support/fixtures/*.fixture.ts",
      ],
      { encoding: "utf8", cwd: process.cwd(), env },
    );
    assert.fail("the dying fixture must make the run non-zero");
  } catch (e) {
    out = `${(e as { stdout?: string }).stdout ?? ""}`;
  }

  assert.match(out, /#427/, "the glob path must still diagnose");
  assert.match(out, /dies-at-import\.fixture\.ts/);
  assert.doesNotMatch(
    out,
    /ordinary-fail\.fixture\.ts/,
    "the file that merely FAILED must not be named as dead",
  );
});

test("🔴 the reporter stays SILENT on an ordinary assertion failure", () => {
  const out = runWithReporter(ORDINARY);

  assert.equal(out, "", "an ordinary failure must produce NO diagnosis at all");
});
