import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-override-dirs-"),
);

const { overridePathFor, overridesDir, profilePathFor, profilesDir, stateDir } =
  await import("../../src/util/paths.js");
const { assertProjectDirOutsideState, realContains } =
  await import("../../src/supervise/containment.js");

/**
 * 🛑 BOTH DIRECTORIES ARE CHILDREN OF `stateDir()`, AND THAT IS WHAT MAKES THEM
 * COVERED.
 *
 * `assertProjectDirOutsideState` checks `stateDir()` and `manifestDir()` only.
 * The docs page read that as a gap and asked for a third `assertDisjoint` call
 * per directory. Measured: the `stateDir()` branch fires first for all four
 * spellings below, so a new branch would be unreachable and a test for it could
 * only pass vacuously.
 *
 * So the property pinned here is the CONTAINMENT, not a new guard. Relocate
 * either directory out from under `stateDir()` — the way `manifestDir()` is a
 * sibling — and this goes red, which is the signal that the explicit call is
 * now owed.
 */
test("🛑 the profiles and overrides dirs are INSIDE the state dir, which is what the containment guard already covers", () => {
  for (const [name, dir] of [
    ["profilesDir", profilesDir()],
    ["overridesDir", overridesDir()],
  ] as const) {
    // ⚠️ BOTH SIDES MUST EXIST, AND THIS UNIT SHIPS NO WRITER. `realContains`
    // realpaths the base but leaves a MISSING target unresolved, and on macOS
    // `tmpdir()` is a symlink — so a contained directory that is merely absent
    // compares as OUTSIDE. Measured: without this line the assert below fails
    // while the property it names is true. Same trap as `manifest-dir.test.ts`.
    mkdirSync(dir, { recursive: true });

    assert.equal(
      realContains(stateDir(), dir),
      true,
      `${name}() is no longer under stateDir(), so assertProjectDirOutsideState ` +
        "no longer reaches it and owes an explicit assertDisjoint call",
    );
  }
});

/**
 * The refusal itself, in both directions, because containment alone is an
 * argument rather than a measurement.
 */
test("🛑 a project dir that overlaps either directory is REFUSED", () => {
  for (const dir of [
    profilesDir(),
    overridesDir(),
    stateDir(),
    join(stateDir(), ".."),
  ]) {
    assert.throws(
      () => assertProjectDirOutsideState(dir),
      /state directory/,
      `${dir} was accepted as a project dir, so an agent can edit its own capabilities`,
    );
  }
});

/**
 * 🛑 THE PAIRED CONTROL. Every refusal above passes for a guard that refuses
 * everything, so the accepting half ships beside it.
 */
test("an unrelated project dir is still accepted", () => {
  const unrelated = mkdtempSync(join(tmpdir(), "chat-mcp-unrelated-"));

  assert.doesNotThrow(() => assertProjectDirOutsideState(unrelated));
});

/** 🛑 The name becomes a filename, so it is validated. */
test("🛑 a traversing profile name is refused rather than reaching another file", () => {
  for (const bad of ["../escape", "a/b", "Alice", "with.dot", "-leading", ""]) {
    assert.throws(
      () => profilePathFor(bad),
      /profile name/,
      `profilePathFor accepted ${JSON.stringify(bad)}`,
    );
  }
});

/**
 * 🛑 A PROFILE NAME IS NOT A HANDLE, AND THE TWO PATTERNS DISAGREE ON PURPOSE.
 * A handle allows the underscore, a profile name does not. Validating a profile
 * name with `assertHandle` would accept `a_b` and put it on disk under a name
 * `checkProfileName` refuses inside the file.
 */
test("🛑 an underscore is a legal handle and NOT a legal profile name", () => {
  assert.doesNotThrow(() => overridePathFor("a_b"));
  assert.throws(() => profilePathFor("a_b"), /profile name/);
});

/** The accepting half for both builders. */
test("both path builders put a legal name in the path", () => {
  assert.match(profilePathFor("gate-runner"), /gate-runner\.json$/);
  assert.match(overridePathFor("claude1"), /claude1\.json$/);
});

/**
 * ⚠️ THEY MUST FOLLOW `CHAT_MCP_HOME`, or a test writes to the operator's real
 * tree. A path derived from `homedir()` would bypass `stateDir()`'s test-runner
 * refusal.
 */
test("🛑 both dirs follow CHAT_MCP_HOME, so a test cannot reach the real ones", () => {
  const home = process.env.CHAT_MCP_HOME as string;

  assert.ok(profilesDir().startsWith(home), `${profilesDir()} escaped ${home}`);
  assert.ok(
    overridesDir().startsWith(home),
    `${overridesDir()} escaped ${home}`,
  );
});
