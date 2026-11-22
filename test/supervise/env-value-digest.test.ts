import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-env-digest-"));

const {
  confirmVerdict,
  markConfirmed,
  diffPlans,
  describeChanges,
  describePlan,
  envValuesDigest,
} = await import("../../src/supervise/container.js");

import type { ContainerPlan } from "../../src/supervise/container.js";

/**
 * #356 — the consent gate stored env var NAMES only.
 *
 * 🛑 A VALUE THAT MOVED PRODUCED A BYTE-IDENTICAL PLAN, so the gate read it as
 * already confirmed and the container ran a value nobody had approved. The
 * operator approved a NAME and believed they had approved what it held.
 *
 * lee ruled it on 2026-11-21: *"Yes it should. Security first."*
 */

const SECRET = "hunter2-the-original-value";
const ROTATED = "hunter3-somebody-changed-it";

function plan(over: Partial<ContainerPlan> = {}): ContainerPlan {
  return {
    mountPaths: ["/work"],
    envVarNames: ["CLAUDE_CODE_OAUTH_TOKEN", "MY_VAR"],
    envValuesDigest: envValuesDigest({ MY_VAR: SECRET }),
    binary: "claude",
    networkMode: "bridge",
    image: "chat-mcp-agent:local",
    memory: null,
    cpus: null,
    installMemory: null,
    installCpus: null,
    ...over,
  };
}

/* ==========================================================================
 * The defect itself.
 * ======================================================================= */

/**
 * 🛑 THE HEADLINE CASE. Same name, same everything else, different value.
 */
test("a changed env VALUE re-prompts, though every name is identical", () => {
  markConfirmed("rotate", plan());

  const verdict = confirmVerdict(
    "rotate",
    plan({ envValuesDigest: envValuesDigest({ MY_VAR: ROTATED }) }),
  );

  assert.equal(verdict.kind, "changed");
});

/**
 * ⚠️ THE CO-PRIMARY CONTROL, and the test above cannot fail without it: a gate
 * that re-prompted on everything would satisfy it perfectly.
 */
test("⚠️ control — an unchanged value stays confirmed", () => {
  markConfirmed("same", plan());

  assert.deepEqual(confirmVerdict("same", plan()), { kind: "confirmed" });
});

/**
 * 🛑 A PLAN STORED BEFORE THIS FIELD EXISTED MUST RE-PROMPT, NOT PASS. An
 * absent field read as equal is the fails-OPEN direction, and 14 such plans
 * are on this laptop's disk today.
 */
test("🛑 a stored plan with no digest at all re-prompts", () => {
  const { envValuesDigest: _drop, ...legacy } = plan();

  writeFileSync(
    join(process.env.CHAT_MCP_HOME!, "container.json"),
    JSON.stringify({
      builtHash: null,
      builtHashes: {},
      confirmed: { older: legacy },
    }),
  );

  assert.equal(confirmVerdict("older", plan()).kind, "changed");
});

/* ==========================================================================
 * The digest must not become a disclosure surface.
 * ======================================================================= */

/**
 * 🛑 THE VALUE NEVER REACHES THE PLAN. The plan is written to disk and shown to
 * an operator, so a value in it is a value in both places.
 */
test("🛑 neither the stored plan nor the banner carries the value", () => {
  const p = plan();

  assert.doesNotMatch(JSON.stringify(p), /hunter2/);
  assert.doesNotMatch(describePlan(p), /hunter2/);
});

/**
 * 🛑 AND THE RE-PROMPT MUST NOT CARRY THE DIGEST EITHER. A truncated hash of a
 * low-entropy value is guessable offline, and the re-prompt is the one place
 * this field would otherwise be printed — `describePlan` never shows it, but
 * `describeChanges` prints every changed field's from and to.
 *
 * ⚠️ WHAT THE OPERATOR NEEDS IS THE CATEGORY, NOT THE BYTES. "a value moved" is
 * actionable; two hex strings are not.
 */
test("🛑 the re-prompt names the change without printing the digest", () => {
  const before = plan();
  const after = plan({
    envValuesDigest: envValuesDigest({ MY_VAR: ROTATED }),
  });

  const changes = diffPlans(before, after);
  const text = describeChanges(changes);

  assert.equal(changes.length, 1, `expected one change, got ${changes.length}`);
  assert.match(text, /env var values/i);
  assert.doesNotMatch(text, new RegExp(before.envValuesDigest));
  assert.doesNotMatch(text, new RegExp(after.envValuesDigest));
  assert.doesNotMatch(text, /hunter/);
});

/**
 * 🛑 `(not recorded)` MUST SURVIVE REDACTION, and my own comment claimed it
 * without a test. It is not derived from the secret, and it is the only part of
 * a legacy re-prompt an operator can act on — "this moved" and "this was never
 * stored" call for different responses.
 */
test("🛑 a never-recorded digest says so, rather than reading as redacted", () => {
  const { envValuesDigest: _drop, ...legacy } = plan();

  const changes = diffPlans(legacy, plan());
  const line = changes.find((c) => c.field === "env var values");

  assert.notEqual(line, undefined, "the absent field produced no change");
  assert.equal(line!.from, "(not recorded)");
  assert.equal(line!.to, "(not shown)");
});

/* ==========================================================================
 * The digest itself.
 * ======================================================================= */

/**
 * 🛑 KEY ORDER IS NOT A CHANGE. An override file rewritten with its keys in a
 * different order would otherwise re-prompt for nothing, and a gate that cries
 * wolf is a gate an operator learns to click through.
 */
test("🛑 the digest is independent of key order", () => {
  assert.equal(
    envValuesDigest({ A: "1", B: "2" }),
    envValuesDigest({ B: "2", A: "1" }),
  );
});

/**
 * ⚠️ THE CONTROL FOR THE TEST ABOVE. A digest that ignored its input entirely
 * would satisfy order-independence perfectly.
 */
test("⚠️ control — a different value IS a different digest", () => {
  assert.notEqual(envValuesDigest({ A: "1" }), envValuesDigest({ A: "2" }));
  assert.notEqual(envValuesDigest({ A: "1" }), envValuesDigest({ B: "1" }));
  assert.notEqual(envValuesDigest({}), envValuesDigest({ A: "1" }));
});

/**
 * 🛑 THE NAME IS HASHED WITH ITS VALUE, AND A RENAME IS WHAT PROVES IT. Moving
 * the same value to a different variable is a real change — a token that was
 * `GH_TOKEN` and is now `MY_VAR` reaches different code inside the container.
 *
 * ⚠️ I WROTE THE WRONG TEST FOR THIS FIRST. A SWAP (`{A:1,B:2}` ->
 * `{A:2,B:1}`) passes even when only the values are hashed, because sorting by
 * key still yields `["1","2"]` against `["2","1"]`. Measured with that exact
 * mutant. A RENAME is the case that collapses without the names.
 */
test("🛑 the same value under a different name is a change", () => {
  assert.notEqual(envValuesDigest({ A: "1" }), envValuesDigest({ B: "1" }));
});

/**
 * Two credentials swapped between their names. Weaker than the rename above —
 * it survives a values-only digest — but it is the shape an operator would
 * most expect to be caught, so it is pinned rather than assumed.
 */
test("swapping two values between their names is a change", () => {
  assert.notEqual(
    envValuesDigest({ A: "1", B: "2" }),
    envValuesDigest({ A: "2", B: "1" }),
  );
});

/**
 * ⚠️ NO OVERRIDE AT ALL IS THE COMMON CASE and must be a stable, recorded
 * value rather than an empty string that reads as "not recorded".
 */
test("an absent override env is a real digest, not an empty string", () => {
  const none = envValuesDigest(undefined);

  assert.equal(none, envValuesDigest({}));
  assert.notEqual(none, "");
  assert.match(none, /^[0-9a-f]{16,}$/);
});

/* ==========================================================================
 * The plan is built from the override, not from a second copy of it.
 * ======================================================================= */

/**
 * 🛑 `buildConfirmPlan` MUST DIGEST THE SAME OVERRIDE IT NAMES. Reading the
 * override twice is how the banner and the spawn come to describe different
 * files — the mistake `image` and `memory` already carry a comment about.
 */
test("🛑 buildConfirmPlan digests the override it resolved", async () => {
  const home = process.env.CHAT_MCP_HOME!;
  mkdirSync(join(home, "overrides"), { recursive: true });
  writeFileSync(
    join(home, "agents.json"),
    JSON.stringify({
      agents: { withenv: { vendor: "claude", mode: "docker" } },
    }),
  );

  const { buildConfirmPlan } =
    await import("../../src/supervise/confirmPlan.js");
  const { resolveOverrideFor } =
    await import("../../src/supervise/overrideStore.js");

  const vendor = {
    authEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
    containerBinary: "claude",
    image: "chat-mcp-agent:local",
    vendor: "claude",
  } as never;

  const built = buildConfirmPlan(vendor, "withenv");
  const override = resolveOverrideFor("withenv");

  assert.equal(built.envValuesDigest, envValuesDigest(override?.env));
});

/* ==========================================================================
 * The three findings my own security-scanner raised on this PR.
 * ======================================================================= */

/**
 * 🛑 THE DIGEST IS AN HMAC, NOT A BARE HASH, BECAUSE IT LEAVES THE HOST.
 * `GET /api/agents/plan` echoes the whole plan to the dashboard. The names
 * travel in the same object and the serialisation is public, so an unsalted
 * hash leaves only the VALUES to search — and a short enum or a PIN falls to an
 * offline sweep. Under a per-install key, what the browser receives is not
 * invertible.
 *
 * ⚠️ TESTED BY DELETING THE KEY, NOT BY RE-IMPORTING THE MODULE. A
 * template-literal dynamic import is ratcheted at ten in
 * `typecheck-config.test.ts`, and an eleventh failed the gate. Deleting the
 * file is also the sharper instrument: it proves the digest depends on THAT
 * file rather than on something else that happens to vary per install.
 */
test("🛑 the digest is keyed, so losing the key changes every digest", () => {
  const keyPath = join(process.env.CHAT_MCP_HOME!, "env-digest-key");

  const before = envValuesDigest({ MY_VAR: SECRET });

  assert.ok(existsSync(keyPath), "no key file was minted");
  assert.equal(
    statSync(keyPath).mode & 0o777,
    0o600,
    "the key is readable by somebody other than its owner",
  );

  rmSync(keyPath);
  const after = envValuesDigest({ MY_VAR: SECRET });

  assert.notEqual(after, before, "the digest does not depend on the key");
  assert.match(after, /^[0-9a-f]{64}$/);
});

/**
 * ⚠️ THE CONTROL FOR THE TEST ABOVE. A digest that returned random bytes per
 * CALL would satisfy "differs across installs" perfectly and break the gate
 * entirely, so the same input under the same key must still be stable.
 */
test("⚠️ control — the digest is stable within one install", () => {
  assert.equal(
    envValuesDigest({ MY_VAR: SECRET }),
    envValuesDigest({ MY_VAR: SECRET }),
  );
});

/**
 * 🛑 THE CALLER'S OVERRIDE WINS, SO THE GATE AND THE SPAWN READ THE FILE ONCE.
 * `startSupervisor` resolves the override, then `buildConfirmPlan` resolved it
 * AGAIN — and the value the container receives is the caller's read while the
 * verdict came from ours. A write landing between them spawns an unapproved
 * value under a `confirmed` verdict.
 *
 * ⚠️ `null` IS A CALLER THAT LOOKED AND FOUND NOTHING, and must NOT fall
 * through to a second read. Only `undefined` may.
 */
test("🛑 buildConfirmPlan digests the override it was GIVEN, not the file", async () => {
  const home = process.env.CHAT_MCP_HOME!;
  mkdirSync(join(home, "overrides"), { recursive: true });
  writeFileSync(
    join(home, "agents.json"),
    JSON.stringify({
      agents: { given: { vendor: "claude", mode: "docker" } },
    }),
  );
  writeFileSync(
    join(home, "overrides", "given.json"),
    JSON.stringify({ env: { ON_DISK: "from-the-file" } }),
  );

  const { buildConfirmPlan } =
    await import("../../src/supervise/confirmPlan.js");

  const vendor = {
    authEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
    containerBinary: "claude",
    image: "chat-mcp-agent:local",
    vendor: "claude",
  } as never;

  const handed = buildConfirmPlan(vendor, "given", {
    env: { PASSED_IN: "from-the-argument" },
  } as never);

  assert.equal(
    handed.envValuesDigest,
    envValuesDigest({ PASSED_IN: "from-the-argument" }),
    "the file was re-read instead of using the argument",
  );
  assert.ok(handed.envVarNames.includes("PASSED_IN"));
  assert.ok(
    !handed.envVarNames.includes("ON_DISK"),
    "the names came from the file too, so the two halves disagree",
  );

  // ⚠️ `null` MUST NOT RE-READ. A default that fired on null would turn "I
  // looked, there is none" into the second read this argument exists to stop.
  const none = buildConfirmPlan(vendor, "given", null);

  assert.equal(none.envValuesDigest, envValuesDigest(undefined));
  assert.ok(!none.envVarNames.includes("ON_DISK"));

  // The co-primary control: OMITTING it still reads the file, because three
  // callers have no override in hand and that is correct for them.
  const read = buildConfirmPlan(vendor, "given");

  assert.ok(read.envVarNames.includes("ON_DISK"));
});

/* ==========================================================================
 * A key file that is not 64 hex characters.
 * ======================================================================= */

/**
 * 🛑 `Buffer.from(x, "hex")` STOPS AT THE FIRST BAD PAIR AND RETURNS WHAT IT
 * GOT, so a partial key file decodes to fewer than 32 bytes and an unparseable
 * one decodes to ZERO. `createHmac` accepts a zero-length key without
 * complaint, and the digest is then a function of the input ALONE — exactly the
 * install-independent, offline-sweepable value the key exists to prevent.
 *
 * ⚠️ IT IS REACHABLE BECAUSE `writePrivateFileSync` IS NOT ATOMIC. A plain
 * `writeFileSync`, so an interrupted or full-disk first write leaves a partial
 * file that every later run then trusts.
 *
 * The remedy is to REGENERATE, not to throw: a one-byte corruption must not
 * brick every container spawn, and the docblock above already accepts that
 * losing the key re-prompts each handle once.
 */
test("🛑 a key file that is not 64 hex characters is regenerated", () => {
  const keyPath = join(process.env.CHAT_MCP_HOME!, "env-digest-key");

  const warnings: string[] = [];
  const realError = console.error;

  // ⚠️ RESTORED IN A `finally`, because a throw while the stub is installed
  // would otherwise swallow every later test's output in this file.
  console.error = (line: string) => void warnings.push(line);

  try {
    const digestUnder = (content: string): string => {
      warnings.length = 0;
      writeFileSync(keyPath, content);
      const digest = envValuesDigest({ MY_VAR: SECRET });

      assert.match(
        readFileSync(keyPath, "utf8").trim(),
        /^[0-9a-f]{64}$/,
        `the key file still holds ${JSON.stringify(content)}`,
      );

      // ⚠️ SILENTLY REGENERATING READS AS THE GATE MALFUNCTIONING. Every handle
      // re-prompts once afterwards, so the cause has to be stated.
      assert.equal(
        warnings.filter((w) => w.includes("env digest key")).length,
        1,
        `the regeneration was not announced for ${JSON.stringify(content)}`,
      );

      return digest;
    };

    // Empty, undecodable, odd-length, and one character short all decode to
    // fewer than 32 bytes, the first two to none at all.
    //
    // 🛑 THE LAST SHAPE IS THE ONE A LENGTH CHECK ALONE WOULD ACCEPT. 64 good
    // characters then junk decodes to a full 32 bytes, so the key would be
    // trusted while the file is plainly damaged.
    const digests = [
      "",
      "zz",
      "abc",
      "a".repeat(63),
      "0".repeat(64) + "zz",
    ].map(digestUnder);

    // 🛑 THE PROPERTY, NOT THE BYTES. Under a zero-byte key the digest depends
    // on the input alone, so two different corrupt files would yield the SAME
    // digest for the same input. Five distinct digests is five distinct keys.
    assert.equal(
      new Set(digests).size,
      digests.length,
      "two corrupt key files produced the same digest, so neither was keyed",
    );

    // ⚠️ THE CONTROL FOR THE WARNING, in this test because it needs this stub:
    // a valid key regenerates nothing and must therefore say nothing.
    warnings.length = 0;
    writeFileSync(keyPath, "ab".repeat(32));
    envValuesDigest({ MY_VAR: SECRET });

    assert.deepEqual(warnings, [], "a valid key file produced a warning");
  } finally {
    console.error = realError;
  }
});

/**
 * ⚠️ THE CONTROL, AND WITHOUT IT THE FIX ABOVE IS UNFALSIFIABLE: a key that
 * regenerated on EVERY read would satisfy every assertion above and re-prompt
 * every handle on every spawn.
 */
test("⚠️ control — a valid key file is left alone", () => {
  const keyPath = join(process.env.CHAT_MCP_HOME!, "env-digest-key");
  const valid = "ab".repeat(32);

  writeFileSync(keyPath, valid);

  const first = envValuesDigest({ MY_VAR: SECRET });

  assert.equal(readFileSync(keyPath, "utf8"), valid, "the key was rewritten");
  assert.equal(first, envValuesDigest({ MY_VAR: SECRET }));
});

/* ==========================================================================
 * The key path is a symlink.
 * ======================================================================= */

/**
 * 🛑 REGENERATING INTRODUCED THE FIRST WRITE OVER A FILE THAT IS ALREADY
 * THERE, and `writeFileSync` and `chmodSync` both follow a link. So a planted
 * `env-digest-key -> /somewhere/else` turns the regeneration into an arbitrary
 * file overwritten with hex and chmodded 0600, at the operator's privilege.
 *
 * ⚠️ MEASURED IN BOTH DIRECTIONS before it was fixed. Under the committed
 * regeneration the target read back as the new key; one commit earlier the
 * symlink was only ever READ, so nothing was clobbered.
 *
 * ⚠️ REFUSED, NOT REGENERATED, UNLIKE A MALFORMED FILE. Nothing in this
 * codebase writes a link here, so one is a deliberate act rather than damage.
 * `host-grant.ts` refuses the same shape for the same reason.
 */
test("🛑 a symlinked key path is refused rather than written through", () => {
  const keyPath = join(process.env.CHAT_MCP_HOME!, "env-digest-key");
  const victimDir = mkdtempSync(join(tmpdir(), "chat-mcp-env-digest-victim-"));
  const victim = join(victimDir, "victim");

  writeFileSync(victim, "PRECIOUS");
  rmSync(keyPath, { force: true });

  try {
    symlinkSync(victim, keyPath);

    assert.throws(
      () => envValuesDigest({ MY_VAR: SECRET }),
      /refusing to write the env digest key/,
    );
    assert.equal(
      readFileSync(victim, "utf8"),
      "PRECIOUS",
      "the link's target was overwritten with the new key",
    );

    // 🛑 A DANGLING LINK IS THE SAME WRITE AND MUST BE REFUSED TOO. `existsSync`
    // follows the link, so a dangling one reads as ABSENT and would reach the
    // mint path without ever meeting the shape check above.
    unlinkSync(keyPath);
    symlinkSync(join(victimDir, "not-there"), keyPath);

    assert.throws(
      () => envValuesDigest({ MY_VAR: SECRET }),
      /refusing to write the env digest key/,
    );
    assert.ok(
      !existsSync(join(victimDir, "not-there")),
      "the dangling link's target was created",
    );
  } finally {
    // ⚠️ `unlink`, NOT `rm`: `rmSync` with `force` silently leaves a DANGLING
    // link in place, and the next test then writes through it.
    if (lstatSync(keyPath, { throwIfNoEntry: false })) unlinkSync(keyPath);
    rmSync(victimDir, { recursive: true, force: true });
  }
});

/**
 * ⚠️ THE CONTROL: a REGULAR file at that path must still be regenerated. A
 * refusal that fired on everything would satisfy the test above and brick every
 * spawn on the damaged-file case this whole change exists to handle.
 */
test("⚠️ control — a regular damaged key file is still regenerated, not refused", () => {
  const keyPath = join(process.env.CHAT_MCP_HOME!, "env-digest-key");

  writeFileSync(keyPath, "zz");

  assert.match(envValuesDigest({ MY_VAR: SECRET }), /^[0-9a-f]{64}$/);
  assert.match(readFileSync(keyPath, "utf8").trim(), /^[0-9a-f]{64}$/);
});
