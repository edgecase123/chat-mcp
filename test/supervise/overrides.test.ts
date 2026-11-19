import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_OVERRIDE_KEYS,
  EXPLAINED_REFUSALS,
  RESERVED_ENV_NAMES,
  parseHandleOverride,
} from "../../src/supervise/overrides.js";

/**
 * #222 unit 1 — the KEY allowlist and its refusals. Values are not checked yet.
 *
 * 🛑 AN ALLOWLIST IS THE WHOLE POINT, AND A DENYLIST WOULD BE THE BUG. A per
 * handle override that accepted raw `docker run` arguments would make every
 * future container flag reachable from a config file, including the ones this
 * module exists to refuse.
 *
 * ⚠️ THIS UNIT REFUSES BY KEY ONLY. `env: {...}` is accepted here without any
 * check on the names or values inside it, and `readOnlyMounts` without any
 * containment check on its entries. Both are named on the ticket as unit 2.
 */

/** Every key a human may write. The denominator is literal, not derived. */
const ALLOWED = ["env", "readOnlyMounts", "image", "memory", "cpus"];

/**
 * The five refusals the ticket names, each with its own sentence.
 *
 * 🛑 A SHARED "unknown key" MESSAGE WOULD PASS EVERY TEST BELOW AND TELL THE
 * HUMAN NOTHING. These five are the escalations somebody reaches for on
 * purpose, so each one says why it is refused rather than that it is unknown.
 */
const EXPLAINED = ["privileged", "dockerSock", "network", "capAdd", "stateDir"];

test("the allowlist is exactly the five keys the ticket names", () => {
  assert.deepEqual([...ALLOWED_OVERRIDE_KEYS], ALLOWED);
  assert.equal(ALLOWED_OVERRIDE_KEYS.length, 5);
});

test("every allowed key is accepted on its own", () => {
  let accepted = 0;

  for (const key of ALLOWED) {
    const out = parseHandleOverride({ [key]: sampleFor(key) });

    assert.equal(Object.keys(out).length, 1, `${key} did not survive`);
    assert.ok(key in out, `${key} was dropped`);
    accepted += 1;
  }

  // 🛑 THE POSITIVE CONTROL. A parse that refused EVERYTHING would satisfy
  // every refusal test below and report green.
  assert.equal(accepted, ALLOWED.length);
  assert.equal(accepted, 5);
});

test("each of the five escalations is refused with its OWN sentence", () => {
  const sentences = new Set<string>();

  for (const key of EXPLAINED) {
    assert.throws(
      () => parseHandleOverride({ [key]: true }),
      (err: unknown) => {
        const message = (err as Error).message;

        assert.ok(
          message.includes(key),
          `the refusal for ${key} does not name it: ${message}`,
        );
        assert.ok(
          !/unknown key/i.test(message),
          `${key} fell through to the generic refusal: ${message}`,
        );
        sentences.add(message);

        return true;
      },
      `${key} was not refused at all`,
    );
  }

  // 🛑 DISTINCT, NOT MERELY PRESENT. One sentence naming all five would pass
  // the `includes` check above for every key.
  assert.equal(sentences.size, EXPLAINED.length);
  assert.equal(sentences.size, 5);
});

test("the explained refusals and the allowlist do not overlap", () => {
  for (const key of EXPLAINED) {
    assert.ok(
      !ALLOWED_OVERRIDE_KEYS.includes(key as never),
      `${key} is both allowed and refused`,
    );
  }

  assert.deepEqual(
    [...EXPLAINED_REFUSALS.keys()].sort(),
    [...EXPLAINED].sort(),
  );
});

test("a key that is neither allowed nor explained is still refused", () => {
  for (const key of ["pid", "ipc", "user", "entrypoint", "", "__proto__"]) {
    assert.throws(
      () => parseHandleOverride({ [key]: "x" }),
      /unknown key/i,
      `${JSON.stringify(key)} was accepted`,
    );
  }
});

test("an allowed key beside a refused one refuses the whole file", () => {
  assert.throws(
    () => parseHandleOverride({ image: "node:22", privileged: true }),
    /privileged/,
    "a partial parse let an escalation through beside a legal key",
  );
});

test("only a JSON object is an override", () => {
  for (const raw of [null, undefined, [], "x", 3, true]) {
    assert.throws(
      () => parseHandleOverride(raw),
      /must be a JSON object/i,
      `${JSON.stringify(raw) ?? "undefined"} was accepted`,
    );
  }
});

test("an empty override is legal and means no change", () => {
  assert.deepEqual(parseHandleOverride({}), {});
});

/** A shape each allowed key will accept once unit 2 checks values. */
function sampleFor(key: string): unknown {
  if (key === "env") return { EXAMPLE: "1" };
  if (key === "readOnlyMounts") return ["docs"];

  return "placeholder";
}

/* ------------------------------------------------------------------------ *
 * #222 unit 2 — the VALUES inside `env` and `readOnlyMounts`.
 *
 * Unit 1 refused by key. These two keys are the ones whose VALUES reach the
 * container, so a key-only allowlist leaves the escalation one level down:
 * `env` can name a credential the spawn already sets, and a mount entry can
 * point outside the project.
 * ------------------------------------------------------------------------ */

/** The three names the spawn already pushes as credentials. */
const RESERVED = ["CLAUDE_CODE_OAUTH_TOKEN", "GH_TOKEN", "CHAT_MCP_MCP_CONFIG"];

test("the reserved names are exactly what the spawn pushes as credentials", async () => {
  const { containerCredentialEnvVars } =
    await import("../../src/supervise/drivers/containerized.js");
  const { claudeSpawn } = await import("../../src/adapters/claude-spawn.js");

  // 🛑 NOT A SECOND HAND-KEPT LIST. Two literals that merely coincide is how
  // the credential scrub rotted before, per containerized.ts's own docblock.
  assert.deepEqual(
    [...RESERVED_ENV_NAMES].sort(),
    [...containerCredentialEnvVars(claudeSpawn)].sort(),
  );
  assert.deepEqual([...RESERVED_ENV_NAMES].sort(), [...RESERVED].sort());
  assert.equal(RESERVED_ENV_NAMES.length, 3);
});

test("env may not name a credential the spawn already sets", () => {
  let refused = 0;

  for (const name of RESERVED) {
    assert.throws(
      () => parseHandleOverride({ env: { [name]: "stolen" } }),
      new RegExp(name),
      `${name} was accepted as an override env name`,
    );
    refused += 1;
  }

  assert.equal(refused, 3);
});

test("env accepts an ordinary name and a string value", () => {
  const out = parseHandleOverride({ env: { PLAYWRIGHT_BROWSERS_PATH: "/ms" } });

  assert.deepEqual(out.env, { PLAYWRIGHT_BROWSERS_PATH: "/ms" });
});

test("env refuses a name that is not an env var, and a value that is not a string", () => {
  const bad: [string, unknown][] = [
    ["lowercase", { env: { path: "x" } }],
    ["leading digit", { env: { "1PATH": "x" } }],
    ["a dash", { env: { "MY-VAR": "x" } }],
    ["a space", { env: { "MY VAR": "x" } }],
    ["empty name", { env: { "": "x" } }],
    ["number value", { env: { OK: 1 } }],
    ["null value", { env: { OK: null } }],
    ["nested value", { env: { OK: { a: 1 } } }],
    ["env is an array", { env: ["OK=1"] }],
    ["env is a string", { env: "OK=1" }],
  ];

  for (const [why, raw] of bad) {
    assert.throws(() => parseHandleOverride(raw), /env/i, `accepted: ${why}`);
  }

  assert.equal(bad.length, 10);
});

test("a read-only mount must be a relative path inside the project", () => {
  const bad: [string, unknown][] = [
    ["absolute", ["/etc/shadow"]],
    ["parent escape", ["../secrets"]],
    ["parent mid-path", ["docs/../../secrets"]],
    ["a colon, docker's separator", ["docs:/mnt/x"]],
    ["empty string", [""]],
    ["only whitespace", ["   "]],
    ["not a string", [3]],
    ["a duplicate", ["docs", "docs"]],
    ["not an array", "docs"],
  ];

  for (const [why, mounts] of bad) {
    assert.throws(
      () => parseHandleOverride({ readOnlyMounts: mounts }),
      /read-only mount|readOnlyMounts/i,
      `accepted: ${why}`,
    );
  }

  assert.equal(bad.length, 9);
});

test("ordinary relative mounts are accepted, including an empty list", () => {
  assert.deepEqual(
    parseHandleOverride({ readOnlyMounts: [] }).readOnlyMounts,
    [],
  );
  assert.deepEqual(
    parseHandleOverride({ readOnlyMounts: ["docs", "web/assets"] })
      .readOnlyMounts,
    ["docs", "web/assets"],
  );
});
