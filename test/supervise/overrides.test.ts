import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_OVERRIDE_KEYS,
  EXPLAINED_REFUSALS,
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
