import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-limits-"));

const {
  DEFAULT_MAX_BUFFER,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_TIMEOUT_MS,
  commandLimits,
  limitsPath,
} = await import("../../src/supervise/command-limits.js");

const dir = mkdtempSync(join(tmpdir(), "chat-mcp-limits-files-"));
let seq = 0;

/** Each case writes its own file, so one malformed fixture cannot leak. */
function fileWith(body: string): string {
  const path = join(dir, `limits-${(seq += 1)}.json`);

  writeFileSync(path, body);

  return path;
}

const fileOf = (value: unknown): string => fileWith(JSON.stringify(value));

test("a missing file is the normal case and gives the three defaults", () => {
  const limits = commandLimits(join(dir, "absent.json"));

  assert.equal(limits.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  assert.equal(limits.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(limits.maxBuffer, DEFAULT_MAX_BUFFER);
});

test("⚠️ control — a well-formed file really does override, so the defaults above are not vacuous", () => {
  const limits = commandLimits(
    fileOf({ maxConcurrent: 2, timeoutMinutes: 3, maxBufferMb: 5 }),
  );

  assert.equal(limits.maxConcurrent, 2);
  assert.notEqual(limits.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  assert.equal(limits.timeoutMs, 3 * 60 * 1000);
  assert.equal(limits.maxBuffer, 5 * 1024 * 1024);
});

test("🛑 AN UNPARSEABLE FILE THROWS AND NAMES THE PATH — it must never read as the defaults", () => {
  const path = fileWith('{ "maxConcurrent": 1,, }');

  assert.throws(
    () => commandLimits(path),
    (err: Error) =>
      err.message.includes(path) && /readable JSON/.test(err.message),
  );
});

test("a JSON value that is not an object throws and names the path", () => {
  for (const body of ["[1,2]", '"4"', "7", "null"]) {
    const path = fileWith(body);

    assert.throws(
      () => commandLimits(path),
      new RegExp(`${path}.*JSON object`),
      `body ${body}`,
    );
  }
});

/**
 * 🛑 THE ORDER OF THE FINITE CHECK AND THE CLAMP IS THE WHOLE TEST.
 * `Math.max(1, NaN)` is `NaN`, and `count >= NaN` is false for every count, so
 * a junk value clamped BEFORE being checked removes the cap entirely.
 */
test("🛑 a non-numeric maxConcurrent THROWS rather than becoming NaN and removing the cap", () => {
  for (const value of [
    "4",
    null,
    {},
    [],
    true,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    const path = fileOf({ maxConcurrent: value });

    assert.throws(
      () => commandLimits(path),
      /"maxConcurrent".*is not a finite number/,
      `maxConcurrent ${JSON.stringify(value)}`,
    );
  }
});

test("maxConcurrent 0 and below is read as 1, the same meaning the option path gives it", () => {
  for (const value of [0, -1, -1000]) {
    assert.equal(
      commandLimits(fileOf({ maxConcurrent: value })).maxConcurrent,
      1,
      `value ${value}`,
    );
  }
});

test("timeoutMinutes and maxBufferMb REFUSE a non-positive value, naming the key", () => {
  for (const key of ["timeoutMinutes", "maxBufferMb"]) {
    for (const value of [0, -5]) {
      assert.throws(
        () => commandLimits(fileOf({ [key]: value })),
        new RegExp(`"${key}".*greater than zero`),
        `${key} ${value}`,
      );
    }
  }
});

test("a non-numeric timeoutMinutes or maxBufferMb throws and names the key", () => {
  for (const key of ["timeoutMinutes", "maxBufferMb"]) {
    assert.throws(
      () => commandLimits(fileOf({ [key]: "fifteen" })),
      new RegExp(`"${key}".*is not a finite number`),
      key,
    );
  }
});

test("a partial file applies the key it names and defaults the two it does not", () => {
  const limits = commandLimits(fileOf({ timeoutMinutes: 1 }));

  assert.equal(limits.timeoutMs, 60 * 1000);
  assert.equal(limits.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  assert.equal(limits.maxBuffer, DEFAULT_MAX_BUFFER);
});

test("an empty object defaults all three, so an operator cannot blank the limits", () => {
  const limits = commandLimits(fileOf({}));

  assert.equal(limits.maxConcurrent, DEFAULT_MAX_CONCURRENT);
  assert.equal(limits.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(limits.maxBuffer, DEFAULT_MAX_BUFFER);
});

test("the units are converted, so an operator writing 15 does not get 15 ms", () => {
  const limits = commandLimits(fileOf({ timeoutMinutes: 15, maxBufferMb: 8 }));

  assert.equal(limits.timeoutMs, 900_000);
  assert.equal(limits.maxBuffer, 8_388_608);
});

test("an unknown key is ignored rather than refused", () => {
  assert.equal(
    commandLimits(fileOf({ maxConcurrnet: 99 })).maxConcurrent,
    DEFAULT_MAX_CONCURRENT,
  );
});

test("limitsPath sits inside the state directory, which is mounted into no container", () => {
  assert.equal(
    limitsPath(),
    join(process.env.CHAT_MCP_HOME as string, "limits.json"),
  );
});
