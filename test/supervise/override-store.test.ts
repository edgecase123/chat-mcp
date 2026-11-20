import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-override-store-"),
);

const { overridePathFor, overridesDir, profilePathFor, profilesDir } =
  await import("../../src/util/paths.js");
const { readHandleOverride, readProfile, resolveOverrideFor } =
  await import("../../src/supervise/overrideStore.js");

function writeProfile(name: string, body: string): void {
  mkdirSync(profilesDir(), { recursive: true });
  writeFileSync(profilePathFor(name), body);
}

function writeHandle(handle: string, body: string): void {
  mkdirSync(overridesDir(), { recursive: true });
  writeFileSync(overridePathFor(handle), body);
}

/**
 * 🛑 A MISSING HANDLE FILE IS THE NORMAL CASE. Every agent that wants the
 * default container has no file, so a throw here would refuse every ordinary
 * spawn.
 */
test("a handle with no override file resolves to null, and does NOT throw", () => {
  assert.equal(readHandleOverride("nofile"), null);
  assert.equal(resolveOverrideFor("nofile"), null);
});

/**
 * 🛑 MALFORMED THROWS, UNLIKE `projects.ts` AND `mounts.ts`.
 *
 * Those two read empty on purpose, because an empty registration is reported
 * loudly by `dirsFor`. Here an empty read means "no capabilities" and is
 * indistinguishable from the normal case above — so a stray comma would
 * silently start an agent without the grant its operator wrote down.
 */
test("🛑 a malformed override file THROWS rather than reading as no capabilities", () => {
  writeHandle("broken", "{ not json");

  assert.throws(() => readHandleOverride("broken"), /broken/);
});

test("🛑 the refusal names the FILE, so a reader knows which one to fix", () => {
  writeHandle("badpath", "{ not json");

  assert.throws(() => readHandleOverride("badpath"), {
    message: new RegExp(overridePathFor("badpath").replace(/\W/g, "\\$&")),
  });
});

/** The value checks are `overrides.ts`'s, and the reader must not bypass them. */
test("🛑 a disallowed key in a handle file is refused by the reader", () => {
  writeHandle("escalate", '{"privileged": true}');

  assert.throws(() => readHandleOverride("escalate"), /privileged/);
});

test("🛑 a profile file that names a profile is refused, so there is no chaining", () => {
  writeProfile("chained", '{"profile": "other"}');

  assert.throws(() => readProfile("chained"), /may not set a profile name/);
});

/**
 * 🛑 THIS IS THE OBLIGATION THE DOCS PAGE LABELLED NOT BUILT.
 *
 * A silent fall back to the default container shows an operator a capability
 * the agent did not get. The refusal carries all three facts a human needs:
 * which handle asked, which name it asked for, and where the reader looked.
 */
test("🛑 an unresolvable profile name is a LOUD refusal naming the handle, the name and the path", () => {
  writeHandle("pointer", '{"profile": "absent-profile"}');

  assert.throws(
    () => resolveOverrideFor("pointer"),
    (err: unknown) => {
      const message = (err as Error).message;

      assert.match(message, /pointer/, "the refusal does not name the handle");
      assert.match(
        message,
        /absent-profile/,
        "the refusal does not name the profile",
      );
      assert.match(
        message,
        new RegExp(profilePathFor("absent-profile").replace(/\W/g, "\\$&")),
        "the refusal does not name the path it looked for",
      );

      return true;
    },
  );
});

test("a handle file with no pointer resolves to its own keys", () => {
  writeHandle("standalone", '{"memory": "512m"}');

  assert.deepEqual(resolveOverrideFor("standalone"), { memory: "512m" });
});

/**
 * 🛑 THE POINTER IS NOT A CONTAINER KEY, so it must not survive into the
 * resolved value. A `profile` reaching `dockerRunPlan` is a key docker was
 * never told about, and the five-key surface is the whole design.
 */
test("🛑 the resolved override carries NO `profile` key", () => {
  writeProfile("base", '{"memory": "1g"}');
  writeHandle("strips", '{"profile": "base", "cpus": "2"}');

  const resolved = resolveOverrideFor("strips");

  assert.equal("profile" in (resolved as object), false);
  assert.deepEqual(resolved, { memory: "1g", cpus: "2" });
});

/**
 * 🛑 ADD-ONLY, THROUGH THE READER. lee's ruling of 2026-11-19. The merge itself
 * is pinned in `overrides.test.ts`; this asserts the reader actually calls it
 * in the profile-then-handle order rather than the other way round.
 */
test("🛑 a handle file CANNOT drop a name its profile contributed", () => {
  writeProfile("shared", '{"env": {"FROM_PROFILE": "1"}, "memory": "1g"}');
  writeHandle("adds", '{"profile": "shared", "env": {"FROM_HANDLE": "2"}}');

  assert.deepEqual(resolveOverrideFor("adds"), {
    env: { FROM_PROFILE: "1", FROM_HANDLE: "2" },
    memory: "1g",
  });
});

/**
 * 🛑 THE DIRECTION OF THE MERGE, AS ITS OWN TEST. Both layers setting one name
 * is the only case that can tell the two orderings apart, and the transposed
 * call type-checked on PR 333.
 */
test("🛑 the HANDLE wins a collision, not the profile", () => {
  writeProfile("loser", '{"memory": "1g", "env": {"N": "profile"}}');
  writeHandle(
    "winner",
    '{"profile": "loser", "memory": "4g", "env": {"N": "handle"}}',
  );

  assert.deepEqual(resolveOverrideFor("winner"), {
    memory: "4g",
    env: { N: "handle" },
  });
});

/** `readProfile` on its own refuses a name with no file, naming the path. */
test("readProfile refuses a name with no file and says where it looked", () => {
  assert.throws(
    () => readProfile("ghost"),
    new RegExp(profilePathFor("ghost").replace(/\W/g, "\\$&")),
  );
});

/**
 * 🛑 `resolveOverrideFor` GOES THROUGH `readProfile`, AND THIS IS WHAT HOLDS
 * THAT.
 *
 * It re-implemented exists-then-parse instead of calling it, so the exported
 * reader was the one with tests and the copy a spawn reaches was the one
 * without. A hardening added to `readProfile` later — a size cap, a mode check,
 * a symlink check — would have silently missed the resolve path. Found by
 * claude2 on PR 334.
 *
 * ⚠️ IT COMPARES THE MESSAGES BYTE FOR BYTE. The two copies differed in exactly
 * ONE argument, which is a difference no "both throw" assertion can see.
 */
test("🛑 the resolve path and readProfile produce ONE refusal, not two copies of one", () => {
  writeHandle("viaresolve", '{"profile": "still-absent"}');

  // ⚠️ `assert.throws` RETURNS UNDEFINED, so the error has to be caught here.
  const refusalFrom = (run: () => unknown): string => {
    try {
      run();
    } catch (err) {
      return (err as Error).message;
    }

    throw new Error("expected a refusal and got none");
  };

  assert.equal(
    refusalFrom(() => resolveOverrideFor("viaresolve")),
    refusalFrom(() => readProfile("still-absent", "viaresolve")),
  );
});

/**
 * 🛑 THE NAME IS VALIDATED BEFORE IT IS A PATH. A traversing pointer inside a
 * handle file must be refused as a NAME, not resolved and then found missing —
 * the second reading is how `../../etc/passwd` becomes a path the reader opens.
 */
test("🛑 a traversing profile pointer is refused as a name, not as a missing file", () => {
  writeHandle("traverse", '{"profile": "../escape"}');

  assert.throws(() => resolveOverrideFor("traverse"), /profile name/);
});
