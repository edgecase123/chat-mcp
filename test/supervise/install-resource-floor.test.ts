import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-install-floor-"),
);

const {
  INSTALL_CPUS_FLOOR,
  INSTALL_MEMORY_FLOOR,
  installResourceArgs,
  memoryToBytes,
} = await import("../../src/supervise/installResources.js");
const { dockerInstallPlan } =
  await import("../../src/supervise/drivers/containerized.js");
const { claudeSpawn } = await import("../../src/adapters/claude-spawn.js");
const { dockerRunPlan } =
  await import("../../src/supervise/drivers/containerized.js");
const { setToken } = await import("../../src/supervise/auth.js");

const PROJECT_DIR = mkdtempSync(join(tmpdir(), "chat-mcp-install-floor-proj-"));

function installArgv(containerOverride?: Record<string, string>) {
  return dockerInstallPlan(claudeSpawn, {
    cwd: PROJECT_DIR,
    supervisorHandle: "claude1",
    containerOverride,
  }).args;
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);

  return i === -1 ? undefined : args[i + 1];
}

test("memoryToBytes reads docker's own suffixes, and a bare number as bytes", () => {
  assert.equal(memoryToBytes("1024"), 1024);
  assert.equal(memoryToBytes("1b"), 1);
  assert.equal(memoryToBytes("2k"), 2 * 1024);
  assert.equal(memoryToBytes("512m"), 512 * 1024 * 1024);
  assert.equal(memoryToBytes("1g"), 1024 * 1024 * 1024);
  assert.equal(memoryToBytes("1G"), 1024 * 1024 * 1024, "case must not matter");
});

/**
 * 🔴 THE RULING. lee chose C on #222 OQ3: the install container inherits the
 * handle's caps, except a value below the floor is raised to the floor.
 */
test("a memory override BELOW the floor is raised to the floor", () => {
  assert.deepEqual(installResourceArgs({ memory: "256m" }), [
    "--memory",
    INSTALL_MEMORY_FLOOR,
  ]);
});

test("a memory override ABOVE the floor is inherited unchanged", () => {
  assert.deepEqual(installResourceArgs({ memory: "4g" }), ["--memory", "4g"]);
});

/**
 * 🔴 BOUNDARY. Raising only when STRICTLY below keeps an operator's own
 * spelling, so `docker inspect` shows what they wrote.
 */
test("a memory override EQUAL to the floor keeps the operator's spelling", () => {
  assert.deepEqual(installResourceArgs({ memory: "1024m" }), [
    "--memory",
    "1024m",
  ]);
});

test("a cpus override BELOW the floor is raised to the floor", () => {
  assert.deepEqual(installResourceArgs({ cpus: "0.5" }), [
    "--cpus",
    INSTALL_CPUS_FLOOR,
  ]);
});

test("a cpus override ABOVE the floor is inherited unchanged", () => {
  assert.deepEqual(installResourceArgs({ cpus: "4" }), ["--cpus", "4"]);
});

/**
 * 🔴 POSITIVE CONTROL. Without this, a function that always returned the two
 * floors would pass every test above — and it would cap an install nobody
 * asked to cap.
 */
test("no override means NO resource flags at all, not the floor", () => {
  assert.deepEqual(installResourceArgs(undefined), []);
  assert.deepEqual(installResourceArgs(null), []);
  assert.deepEqual(installResourceArgs({}), []);
});

test("memory and cpus are independent — one override does not synthesise the other", () => {
  assert.deepEqual(installResourceArgs({ memory: "2g" }), ["--memory", "2g"]);
  assert.deepEqual(installResourceArgs({ cpus: "2" }), ["--cpus", "2"]);
});

test("the install container inherits the handle's caps", () => {
  const args = installArgv({ memory: "2g", cpus: "2" });

  assert.equal(flagValue(args, "--memory"), "2g");
  assert.equal(flagValue(args, "--cpus"), "2");
});

test("the install container raises a below-floor cap rather than honouring it", () => {
  const args = installArgv({ memory: "64m", cpus: "0.25" });

  assert.equal(flagValue(args, "--memory"), INSTALL_MEMORY_FLOOR);
  assert.equal(flagValue(args, "--cpus"), INSTALL_CPUS_FLOOR);
});

/**
 * 🛑 AFTER THE IMAGE NAME THE FLAG REACHES `sh` AS AN UNKNOWN ARGUMENT, the
 * container runs UNCAPPED, and docker reports nothing. The agent container
 * already carries this rule; the install container is the second place it has
 * to hold.
 */
test("the resource flags come BEFORE the image operand", () => {
  const args = installArgv({ memory: "2g", cpus: "2" });
  const image = args.indexOf(claudeSpawn.image);

  assert.notEqual(image, -1, "the image operand must still be in the argv");

  // 🔴 PRESENCE FIRST. `indexOf` is -1 for an absent flag, and -1 is less
  // than every index — so the ordering assertions below passed vacuously
  // while the argv carried no caps at all.
  const memory = args.indexOf("--memory");
  const cpus = args.indexOf("--cpus");

  assert.notEqual(memory, -1, `no --memory in ${args.join(" ")}`);
  assert.notEqual(cpus, -1, `no --cpus in ${args.join(" ")}`);

  assert.ok(
    memory < image,
    `--memory must precede the image: ${args.join(" ")}`,
  );
  assert.ok(cpus < image, `--cpus must precede the image: ${args.join(" ")}`);
});

/**
 * 🔴 FAILS CLOSED. Found by claude2 on PR 346: an unparseable value compares
 * FALSE against the floor rather than below it, so trusting it SKIPS the floor
 * instead of raising to it. The store's own regex refuses these, but
 * `installResourceArgs` takes the override off a `SpawnOptions` a library
 * caller supplies — the same argument `assertImageRef` already makes.
 */
test("an unparseable memory value THROWS rather than skipping the floor", () => {
  for (const bad of ["100mb", "1.5g", "abc", "", "-512m"]) {
    assert.throws(
      () => installResourceArgs({ memory: bad }),
      /`memory` is not a legal value/,
      `${JSON.stringify(bad)} must not reach an argv`,
    );
  }
});

test("an unparseable cpus value THROWS rather than skipping the floor", () => {
  for (const bad of ["two", "", "-1"]) {
    assert.throws(
      () => installResourceArgs({ cpus: bad }),
      /`cpus` is not a legal value/,
      `${JSON.stringify(bad)} must not reach an argv`,
    );
  }
});

/**
 * 🛑 ZERO IS NO LIMIT, NOT A SMALL ONE, so it must not be read as below the
 * floor and quietly raised. `refuseNoLimit` rides along with the check.
 */
test("a zero cap is REFUSED on this route too, not floored", () => {
  assert.throws(() => installResourceArgs({ memory: "0" }), /may not be zero/);
  assert.throws(() => installResourceArgs({ cpus: "0" }), /may not be zero/);
});

test("an uncapped install container still carries no resource flags", () => {
  const args = installArgv();

  assert.equal(flagValue(args, "--memory"), undefined);
  assert.equal(flagValue(args, "--cpus"), undefined);
});

/**
 * 🔴 THE SAME BUG ONE FUNCTION AWAY, found by claude2 on PR 346. The agent
 * argv pushed the override's values raw, and the test was `if (override?.
 * memory)` — truthiness, which `"0"` passes. Docker reads zero as NO LIMIT, so
 * the container an operator capped ran uncapped.
 *
 * 🛑 I FIXED THE INSTALL PATH AND LEFT ITS SIBLING. An audit scoped by the
 * function I was editing could not see it.
 */
test("the AGENT argv refuses a zero cap rather than running uncapped", () => {
  setToken("sk-ant-oat-x");

  for (const override of [{ memory: "0" }, { cpus: "0" }]) {
    assert.throws(
      () =>
        dockerRunPlan(claudeSpawn, {
          cwd: PROJECT_DIR,
          supervisorHandle: "claude1",
          bus: { url: "http://127.0.0.1:1/", token: "t" },
          containerOverride: override,
        }),
      /may not be zero/,
      `${JSON.stringify(override)} must not reach the agent argv`,
    );
  }
});

/**
 * 🔴 WHY `!== undefined` AND NOT TRUTHINESS. With the assert in place, `"0"`
 * throws either way, because `"0"` is truthy. The empty string is the one
 * value that separates them: truthiness SKIPS it and the container runs
 * uncapped with no error, which is the fails-open direction.
 *
 * Without this test, reverting the condition to truthiness is an equivalent
 * mutant — measured, not assumed.
 */
test("the AGENT argv refuses an EMPTY cap rather than silently omitting it", () => {
  setToken("sk-ant-oat-x");

  for (const override of [{ memory: "" }, { cpus: "" }]) {
    assert.throws(
      () =>
        dockerRunPlan(claudeSpawn, {
          cwd: PROJECT_DIR,
          supervisorHandle: "claude1",
          bus: { url: "http://127.0.0.1:1/", token: "t" },
          containerOverride: override,
        }),
      /is not a legal value/,
      `${JSON.stringify(override)} must not be silently dropped`,
    );
  }
});

test("the AGENT argv refuses an unparseable cap", () => {
  setToken("sk-ant-oat-x");

  assert.throws(
    () =>
      dockerRunPlan(claudeSpawn, {
        cwd: PROJECT_DIR,
        supervisorHandle: "claude1",
        bus: { url: "http://127.0.0.1:1/", token: "t" },
        containerOverride: { memory: "1.5g" },
      }),
    /`memory` is not a legal value/,
  );
});
