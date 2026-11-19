import { test } from "node:test";
import assert from "node:assert/strict";
import type { AllowedOverrideKey } from "../../src/supervise/overrides.js";
import {
  ALLOWED_HANDLE_KEYS,
  ALLOWED_OVERRIDE_KEYS,
  EXPLAINED_REFUSALS,
  RESERVED_ENV_NAMES,
  SCALAR_KEYS,
  UNION_KEYS,
  mergeOverrides,
  parseHandleOverride,
  parseProfile,
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

/**
 * A legal value for each allowed key.
 *
 * 🛑 ONE PLACEHOLDER STRING USED TO SERVE ALL THREE OF `image`, `memory` and
 * `cpus`, and that is exactly what made the smuggling above invisible — the
 * fixture could not tell a checked value from an unchecked one.
 */
function sampleFor(key: string): unknown {
  if (key === "env") return { EXAMPLE: "1" };
  if (key === "readOnlyMounts") return ["docs"];
  if (key === "image") return "node:22-slim";
  if (key === "memory") return "512m";

  return "2";
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

/* ------------------------------------------------------------------------ *
 * #222 unit 2b — `image`, `memory` and `cpus` VALUES.
 *
 * 🛑 AN ALLOWED KEY WAS STILL AN ESCALATION. These three passed through as
 * `unknown`, so `{ image: ["--privileged", "node:22"] }` was accepted and a
 * consumer spreading it into argv would inject the flag the allowlist exists
 * to refuse. Found by claude2 reviewing PR 331 at `ac8bf3b`.
 * ------------------------------------------------------------------------ */

test("an allowed key may not smuggle a docker flag through its VALUE", () => {
  const smuggled: [string, unknown][] = [
    ["image as an array", { image: ["--privileged", "node:22"] }],
    ["memory as an array", { memory: ["--privileged"] }],
    ["cpus as an object", { cpus: { toString: 1 } }],
    ["image is a flag", { image: "-v /:/host" }],
    ["image has a space", { image: "node:22 --privileged" }],
    ["image is empty", { image: "" }],
    ["memory is a flag", { memory: "--privileged" }],
    ["cpus is a flag", { cpus: "--privileged" }],
    ["image is a number", { image: 22 }],
    ["memory is a number", { memory: 512 }],
    ["cpus is a number", { cpus: 2 }],
    ["image is null", { image: null }],
  ];

  for (const [why, raw] of smuggled) {
    assert.throws(
      () => parseHandleOverride(raw),
      /image|memory|cpus/i,
      `accepted: ${why}`,
    );
  }

  assert.equal(smuggled.length, 12);
});

test("ordinary image, memory and cpus values are still accepted", () => {
  const good: [string, Record<string, unknown>][] = [
    ["a plain tag", { image: "node:22-slim" }],
    ["a namespaced repo", { image: "mcr.microsoft.com/playwright:v1.49.0" }],
    ["a digest", { image: `node@sha256:${"a".repeat(64)}` }],
    ["bytes", { memory: "512m" }],
    ["gigabytes", { memory: "2G" }],
    ["bare digits", { memory: "1073741824" }],
    ["whole cpus", { cpus: "2" }],
    ["fractional cpus", { cpus: "1.5" }],
  ];

  for (const [why, raw] of good) {
    const out = parseHandleOverride(raw);
    const [key] = Object.keys(raw);

    assert.equal(out[key as never], raw[key], `refused a legal value: ${why}`);
  }

  // 🛑 THE POSITIVE CONTROL. A parse that refused all three keys outright
  // would satisfy every smuggling case above.
  assert.equal(good.length, 8);
});

/**
 * 🛑 A REFUSAL A HUMAN CANNOT ACT ON IS HALF A GUARD. lee ruled on 2026-11-19
 * that a human edits this JSON, and a human writes `2` rather than `"2"`.
 * String-only stays — docker's own forms are `512m` and `1.5` — so the MESSAGE
 * has to carry the quotes. Raised by claude2 reviewing PR 331.
 */
test("a number value is refused with a message naming the quoted form", () => {
  const cases: [string, unknown, string][] = [
    ["cpus", { cpus: 2 }, '"2"'],
    ["memory", { memory: 512 }, '"512m"'],
    ["image", { image: 22 }, '"node:22-slim"'],
  ];

  for (const [key, raw, example] of cases) {
    assert.throws(
      () => parseHandleOverride(raw),
      (err: unknown) => {
        const message = (err as Error).message;

        assert.match(message, /quoted string/, `${key}: ${message}`);
        assert.ok(
          message.includes(example),
          `${key} does not show the quoted form ${example}: ${message}`,
        );

        return true;
      },
    );
  }

  assert.equal(cases.length, 3);
});

/* ------------------------------------------------------------------------ *
 * #222 unit 3 — the `profile` key and the ADD-only merge.
 *
 * 🛑 THE CONTAINER SURFACE STAYS AT FIVE KEYS. `profile` is a POINTER to a
 * second file, not a sixth thing the container can be told. That is why the
 * handle file accepts six names and a profile file accepts five.
 *
 * 🛑 ADD-ONLY IS lee's RULING OF 2026-11-19 (`#mcp` 15889). A merge may
 * overwrite a VALUE and may never drop a NAME, so every name the profile
 * contributes survives whatever the handle file says.
 * ------------------------------------------------------------------------ */

/** A legal profile name, which is deliberately not a legal path. */
const PROFILE_NAMES = ["reviewer", "browser", "browser-2", "a", "0"];

test("the container keys stay at five and only a handle may name a profile", () => {
  assert.deepEqual([...ALLOWED_OVERRIDE_KEYS], ALLOWED);
  assert.equal(ALLOWED_OVERRIDE_KEYS.length, 5);

  // 🛑 THE POINTER IS NOT A CONTAINER SETTING. A `profile` added to
  // ALLOWED_OVERRIDE_KEYS would read as a sixth thing docker is told.
  assert.ok(!ALLOWED_OVERRIDE_KEYS.includes("profile" as never));
  assert.deepEqual([...ALLOWED_HANDLE_KEYS], [...ALLOWED, "profile"]);
  assert.equal(ALLOWED_HANDLE_KEYS.length, 6);
});

test("a handle override may name a profile", () => {
  let accepted = 0;

  for (const name of PROFILE_NAMES) {
    assert.deepEqual(
      parseHandleOverride({ profile: name }),
      { profile: name },
      `refused a legal profile name: ${name}`,
    );
    accepted += 1;
  }

  // 🛑 THE POSITIVE CONTROL. A parse that refused every name would satisfy
  // every refusal below and report green.
  assert.equal(accepted, PROFILE_NAMES.length);
  assert.equal(accepted, 5);
});

/**
 * 🛑 THE NAME BECOMES A FILENAME, so a name that is a path is a traversal.
 * `profiles/../../.ssh/id_ed25519` is the shape this refuses, and refusing
 * the dot and the slash outright is narrower than resolving the path and
 * checking where it landed.
 */
test("a profile name can never be a path", () => {
  const refused: [string, unknown][] = [
    ["climbs out", "../escape"],
    ["has a slash", "a/b"],
    ["is a bare dot-dot", ".."],
    ["carries an extension", "a.json"],
    ["is dot-relative", "./a"],
    ["is absolute", "/etc/passwd"],
    ["is upper case", "Reviewer"],
    ["is empty", ""],
    ["leads with a dash", "-x"],
    ["holds an underscore", "a_b"],
    ["holds a space", "a b"],
    ["is a number", 2],
    ["is an array", ["reviewer"]],
    ["is null", null],
  ];

  for (const [why, name] of refused) {
    assert.throws(
      () => parseHandleOverride({ profile: name }),
      (err: unknown) => {
        const message = (err as Error).message;

        // 🛑 NOT THE GENERIC REFUSAL. Before `profile` was allowed at all,
        // every case here threw `unknown key "profile"`, which matches
        // /profile/i and made this whole test pass against no implementation.
        assert.ok(
          !/unknown key/i.test(message),
          `${why} hit the unknown-key refusal, so the name was never checked: ${message}`,
        );
        assert.match(message, /profile name/i, `${why}: ${message}`);

        return true;
      },
      `accepted a profile name that ${why}: ${JSON.stringify(name)}`,
    );
  }

  assert.equal(refused.length, 14);
});

test("a profile file carries the five keys and may not name another profile", () => {
  for (const key of ALLOWED) {
    const out = parseProfile({ [key]: sampleFor(key) });

    assert.ok(key in out, `a profile file dropped ${key}`);
  }

  // 🛑 NO CHAINING. A profile that names a profile is a graph, and a graph
  // needs cycle detection the ruling never asked for.
  assert.throws(
    () => parseProfile({ profile: "reviewer" }),
    (err: unknown) => {
      const message = (err as Error).message;

      // 🛑 ITS OWN SENTENCE, NOT THE GENERIC ONE. `unknown key "profile"`
      // matches /profile/i and would tell the human nothing about why.
      assert.ok(!/unknown key/i.test(message), message);
      assert.match(message, /may not set a profile name/i, message);

      return true;
    },
    "a profile named another profile",
  );
});

test("the merge unions env, and the handle wins on a collision", () => {
  const merged = mergeOverrides({
    profile: { env: { SHARED: "from-profile", ONLY_PROFILE: "1" } },
    handle: { env: { SHARED: "from-handle", ONLY_HANDLE: "1" } },
  });

  assert.deepEqual(merged.env, {
    SHARED: "from-handle",
    ONLY_PROFILE: "1",
    ONLY_HANDLE: "1",
  });
});

test("the merge unions readOnlyMounts, profile first, with no duplicate", () => {
  const merged = mergeOverrides({
    profile: { readOnlyMounts: ["docs", "web/assets"] },
    handle: { readOnlyMounts: ["web/assets", "plans"] },
  });

  // 🛑 DEDUPED, because a repeated `-v` puts one directory at one destination
  // twice and docker's own error for that is unreadable.
  assert.deepEqual(merged.readOnlyMounts, ["docs", "web/assets", "plans"]);
});

test("image, memory and cpus are replaced by the handle", () => {
  const merged = mergeOverrides({
    profile: { image: "node:22-slim", memory: "4g", cpus: "4" },
    handle: { memory: "2g" },
  });

  assert.deepEqual(merged, {
    image: "node:22-slim",
    memory: "2g",
    cpus: "4",
  });
});

/**
 * 🛑 THE ADD-ONLY INVARIANT, AND IT IS THE WHOLE RULING. A handle may change
 * what a name is set to. No handle file can express dropping the name.
 */
test("the merge can never remove an env name or a mount the profile set", () => {
  const profile = {
    env: { KEPT: "1", BLANKED: "1" },
    readOnlyMounts: ["docs"],
  };

  const attempts: [string, Record<string, unknown>][] = [
    ["an empty value", { env: { BLANKED: "" } }],
    ["an empty env object", { env: {} }],
    ["an empty mount list", { readOnlyMounts: [] }],
    ["an unrelated key", { image: "node:22-slim" }],
  ];

  for (const [why, handle] of attempts) {
    const merged = mergeOverrides({ profile, handle });

    for (const name of Object.keys(profile.env)) {
      assert.ok(
        merged.env && name in merged.env,
        `${why} removed the env name ${name}`,
      );
    }

    assert.ok(
      merged.readOnlyMounts?.includes("docs"),
      `${why} removed the mount docs`,
    );
  }

  assert.equal(attempts.length, 4);
});

test("the merged result never carries the profile pointer", () => {
  const merged = mergeOverrides({
    profile: { image: "node:22-slim" },
    handle: { profile: "reviewer", memory: "2g" },
  });

  // 🛑 A POINTER THAT SURVIVED THE MERGE WOULD REACH A SPAWN, where it is
  // neither a docker flag nor an error anybody sees.
  assert.ok(!("profile" in merged), "the pointer survived into the merge");
  assert.deepEqual(merged, { image: "node:22-slim", memory: "2g" });
});

/* ------------------------------------------------------------------------ *
 * #222 unit 3, review remediation. Both reviewers on PR 333 found the same
 * fall-through, and the security scanner found three ways a value defeats a
 * ruling the keys already enforce.
 * ------------------------------------------------------------------------ */

test("every container key has a merge policy, and the two lists partition it", () => {
  // 🛑 A HAND-KEPT SCALAR LIST WOULD DROP A SIXTH KEY FROM BOTH SIDES of the
  // merge, and the spawn would run without it with nothing printed.
  assert.deepEqual(
    [...UNION_KEYS, ...SCALAR_KEYS].sort(),
    [...ALLOWED_OVERRIDE_KEYS].sort(),
  );
  assert.equal(UNION_KEYS.length + SCALAR_KEYS.length, 5);
});

/**
 * 🛑 EVERY ALLOWED KEY HAS ITS OWN CHECK, which is the fall-through both
 * reviewers found. The chain's terminal `else` meant `profile`, so a sixth
 * allowed key with no branch would have been validated as a FILENAME.
 */
test("every key a handle may set refuses an illegal value, naming that key", () => {
  const illegal: Record<string, unknown> = {
    env: "not-an-object",
    readOnlyMounts: "not-an-array",
    image: "-v /:/host",
    memory: "not-a-size",
    cpus: "not-a-number",
    profile: "../escape",
  };

  for (const key of ALLOWED_HANDLE_KEYS) {
    assert.throws(
      () => parseHandleOverride({ [key]: illegal[key] }),
      (err: unknown) => {
        const message = (err as Error).message;

        assert.ok(
          !/unknown key/i.test(message),
          `${key} was refused as unknown rather than checked: ${message}`,
        );

        return true;
      },
      `${key} accepted an illegal value, so it has no check of its own`,
    );
  }

  assert.equal(ALLOWED_HANDLE_KEYS.length, 6);
  assert.equal(Object.keys(illegal).length, 6);
});

/**
 * 🛑 A VALUE CAN DEFEAT THE ADD-ONLY RULING WHERE A KEY CANNOT. The ruling
 * protects NAMES, and for these two keys the value is the only thing there is.
 * Docker reads zero as NO limit, so `"memory": "0"` in a handle file nullifies
 * a profile's cap while obeying the letter of the ruling.
 */
test("a zero memory or cpus limit is refused, because docker reads it as no limit", () => {
  const nullified: [string, Record<string, unknown>][] = [
    ["bare zero memory", { memory: "0" }],
    ["zero megabytes", { memory: "0m" }],
    ["zero gigabytes", { memory: "0G" }],
    ["padded zero memory", { memory: "00" }],
    ["zero cpus", { cpus: "0" }],
    ["zero point zero cpus", { cpus: "0.0" }],
    ["many zero cpus", { cpus: "0.000" }],
  ];

  for (const [why, raw] of nullified) {
    assert.throws(
      () => parseHandleOverride(raw),
      /no limit/i,
      `accepted a limit that removes the limit: ${why}`,
    );
  }

  // 🛑 THE POSITIVE CONTROL. A check that refused every limit would satisfy
  // all seven cases above.
  assert.equal(parseHandleOverride({ memory: "1" }).memory, "1");
  assert.equal(parseHandleOverride({ cpus: "0.5" }).cpus, "0.5");
  assert.equal(nullified.length, 7);
});

/**
 * 🛑 A NEWLINE IN AN ENV VALUE RE-INTRODUCES A RESERVED NAME. `docker run -e`
 * is immune, because it sets one multi-line variable. `--env-file` is
 * line-based, and `--env-file` plus `writePrivateFileSync` is the documented
 * way to keep a secret out of argv — so the next unit on that path walks into
 * this. Found by `security-scanner` on PR 333.
 */
test("an env value may not carry a newline, which --env-file reads as a second variable", () => {
  const smuggled: [string, string][] = [
    ["a newline", "x\nCLAUDE_CODE_OAUTH_TOKEN=stolen"],
    ["a carriage return", "x\rGH_TOKEN=stolen"],
    ["a NUL", "x\u0000GH_TOKEN=stolen"],
  ];

  for (const [why, value] of smuggled) {
    assert.throws(
      () => parseHandleOverride({ env: { FOO: value } }),
      /newline|line break|control character/i,
      `accepted an env value holding ${why}`,
    );
  }

  // 🛑 THE POSITIVE CONTROL. An ordinary value still passes.
  assert.deepEqual(parseHandleOverride({ env: { FOO: "plain value" } }).env, {
    FOO: "plain value",
  });
  assert.equal(smuggled.length, 3);
});

/**
 * 🛑 THE DEDUP COMPARED STRINGS, SO A SECOND SPELLING OF ONE PATH BEAT IT.
 * `"docs"` in a profile and `"./docs"` in a handle produced TWO mounts of one
 * directory, which is the exact harm `checkReadOnlyMounts`' own docblock names.
 * Found by claude2 reviewing PR 333 at `e790869`.
 *
 * 🛑 REFUSED, NOT NORMALISED. Normalising here would disagree with the
 * driver's own containment check, and two readings of one path is what puts a
 * directory at two destinations.
 */
test("a mount path must be in canonical form, so one path has one spelling", () => {
  const refused: [string, string][] = [
    ["a dot-relative prefix", "./docs"],
    ["a bare dot segment", "docs/./sub"],
    ["a trailing slash", "docs/"],
    ["a doubled slash", "docs//sub"],
    ["a lone dot", "."],
  ];

  for (const [why, entry] of refused) {
    assert.throws(
      () => parseHandleOverride({ readOnlyMounts: [entry] }),
      /mount/i,
      `accepted ${why}: ${JSON.stringify(entry)}`,
    );
  }

  // 🛑 THE POSITIVE CONTROL. A check that refused every path would satisfy
  // all five cases above.
  assert.deepEqual(
    parseHandleOverride({ readOnlyMounts: ["docs", "web/assets", "Docs"] })
      .readOnlyMounts,
    ["docs", "web/assets", "Docs"],
  );
  assert.equal(refused.length, 5);
});

test("the merge cannot mount one directory twice through two spellings", () => {
  // 🛑 THE DEDUP IS NOW LOAD-BEARING ONLY FOR THE EXACT REPEAT. Every other
  // spelling is refused before it reaches the merge, which is why this asserts
  // the refusal rather than a deduped result.
  for (const spelling of ["./docs", "docs/", "docs//sub"]) {
    assert.throws(
      () => parseHandleOverride({ readOnlyMounts: [spelling] }),
      /mount/i,
      `a second spelling reached the merge: ${spelling}`,
    );
  }

  const merged = mergeOverrides({
    profile: parseProfile({ readOnlyMounts: ["docs"] }),
    handle: parseHandleOverride({ readOnlyMounts: ["docs", "plans"] }),
  });

  assert.deepEqual(merged.readOnlyMounts, ["docs", "plans"]);
});

/**
 * 🛑 A SIXTH CONTAINER KEY IS CLASSIFIED BY DEFAULT, AND THE DEFAULT IS WRONG.
 * `SCALAR_KEYS` is the complement of `UNION_KEYS`, so a key nobody classified
 * silently joins the REPLACING half — and a handle file could then drop what a
 * profile set, which is the ADD-only ruling inverted with nothing printed.
 *
 * 🛑 `Record<AllowedOverrideKey, …>` IS THE GUARD. A new container key does not
 * compile until someone writes down which half it belongs to. Found by claude2
 * reviewing PR 333.
 */
const MERGE_BEHAVIOUR: Record<AllowedOverrideKey, "union" | "replace"> = {
  env: "union",
  readOnlyMounts: "union",
  image: "replace",
  memory: "replace",
  cpus: "replace",
};

test("every container key is classified union or replace, and the lists agree", () => {
  const declared = Object.entries(MERGE_BEHAVIOUR);

  assert.deepEqual(
    declared
      .filter(([, how]) => how === "union")
      .map(([key]) => key)
      .sort(),
    [...UNION_KEYS].sort(),
  );

  assert.deepEqual(
    declared
      .filter(([, how]) => how === "replace")
      .map(([key]) => key)
      .sort(),
    [...SCALAR_KEYS].sort(),
  );

  // 🛑 THE DENOMINATOR. Two agreeing lists that both omit a key would pass
  // every assertion above.
  assert.deepEqual(
    declared.map(([key]) => key).sort(),
    [...ALLOWED_OVERRIDE_KEYS].sort(),
  );
});

test("a union key keeps the profile's value and a scalar key loses it", () => {
  const merged = mergeOverrides({
    profile: parseProfile({
      env: { FROM_PROFILE: "1" },
      readOnlyMounts: ["docs"],
      image: "profile-image",
      memory: "512m",
      cpus: "1",
    }),
    handle: parseHandleOverride({
      env: { FROM_HANDLE: "2" },
      readOnlyMounts: ["plans"],
      image: "handle-image",
      memory: "1g",
      cpus: "2",
    }),
  });

  // The union half keeps BOTH sides.
  assert.deepEqual(Object.keys(merged.env ?? {}).sort(), [
    "FROM_HANDLE",
    "FROM_PROFILE",
  ]);
  assert.deepEqual(merged.readOnlyMounts, ["docs", "plans"]);

  // The replacing half keeps the handle's value only.
  assert.equal(merged.image, "handle-image");
  assert.equal(merged.memory, "1g");
  assert.equal(merged.cpus, "2");
});
