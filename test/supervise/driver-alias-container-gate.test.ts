import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

/**
 * 🛑 `--driver docker-claude` SELECTED A CONTAINER AND SKIPPED THE BLOCK THAT
 * MAKES ONE USABLE. The CLI keyed that block on the `--container` flag, while
 * `resolveDriver` keeps the alias containerized without it, so the build and
 * the one-time plan confirmation were both bypassed and `startSupervisor`
 * refused the handle it had just been told to start.
 *
 * ⚠️ A non-interactive caller is the measured case, not a hypothetical one.
 * `rl.question` reads `''` at EOF, which is not `y`, so the confirmation used
 * to print `aborted` and exit 0 — a scripted mint of a new containerized
 * agent looked like it had worked.
 */

const ENTRY = new URL("../../src/index.ts", import.meta.url).pathname;

function scratchHome(t: TestContext): string {
  const home = mkdtempSync(join(tmpdir(), "cm-alias-gate-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

/**
 * 🛑 STDIN IS `/dev/null` ON PURPOSE — that is what a script gives the CLI, and
 * it is the input the old `aborted` path answered green to. The run must also
 * never reach `buildImage`, so every assertion here holds on a machine with no
 * agent image and no docker daemon.
 */
function supervise(t: TestContext, home: string, args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", ENTRY, "supervise", ...args],
    {
      encoding: "utf8",
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CHAT_MCP_HOME: home },
    },
  );
}

async function withToken(home: string): Promise<void> {
  process.env.CHAT_MCP_HOME = home;
  const { setToken } = await import("../../src/supervise/auth.js");
  setToken("sk-ant-oat-test");
}

test("🚨 --driver docker-claude reaches the container gate, not the supervisor's refusal", async (t) => {
  const home = scratchHome(t);
  await withToken(home);

  const r = supervise(t, home, [
    `alias-gate-${process.pid}`,
    "--driver",
    "docker-claude",
  ]);
  const out = `${r.stdout}${r.stderr}`;

  // The old failure. `startSupervisor` told the operator to re-run with the
  // flag whose only extra effect was the block the CLI had just skipped.
  assert.doesNotMatch(
    out,
    /is not confirmed; run/,
    `the gate was skipped and startSupervisor refused instead:\n${out}`,
  );
  assert.match(
    out,
    /needs a terminal/,
    `expected the gate's own non-interactive refusal, got:\n${out}`,
  );
});

/**
 * 🛑 `--container` IS THE SPELLING THAT CARRIES THIS ONE, AND THE ALIAS CANNOT
 * SUBSTITUTE FOR IT. `--driver docker-claude` used to miss the block entirely,
 * so it exited non-zero from `startSupervisor` and never printed `aborted` —
 * the same assertions pass against the old bug and prove nothing. Only the
 * flag reached the abort path, so only the flag is a control for it.
 */
test("🚨 an unconfirmed plan refuses with a non-zero exit instead of printing aborted", async (t) => {
  const home = scratchHome(t);
  await withToken(home);

  const r = supervise(t, home, [`alias-abort-${process.pid}`, "--container"]);
  const out = `${r.stdout}${r.stderr}`;

  // ⚠️ THE EXIT CODE IS THE ASSERTION. `aborted` on stdout was already a
  // refusal a reader could see; what made it expensive is that it was green.
  assert.notEqual(r.status, 0, `a refused start exited 0:\n${out}`);
  assert.doesNotMatch(out, /^aborted$/m, out);
  assert.match(out, /needs a terminal/, out);
});

/**
 * ⚠️ NO SEPARATE TEST ASSERTS THAT THE CONFIRMATION PRECEDES THE BUILD,
 * BECAUSE THE TWO ABOVE ALREADY FAIL IF IT DOES NOT. Both run against a
 * scratch `CHAT_MCP_HOME`, where `builtHash` is null and `imageNeedsBuild()`
 * is therefore true. Build first and the refusal they assert on never
 * arrives — the run spends `npm run build` and then dies in `buildImage` on a
 * machine with no daemon.
 *
 * A standalone order test was written and deleted. Its only mutant is moving
 * the build back above the confirmation, and that mutant bakes a mutated
 * `dist/` into `chat-mcp-agent:local` through the Dockerfile's `COPY dist`.
 * An uncontrolled guard is worth less than the two that are controlled.
 */

/**
 * 🛑 THE TWO TESTS ABOVE CANNOT TELL A MODE-KEYED GATE FROM A STRING-KEYED
 * ONE, AND claude1 MEASURED THAT. `if (o.driver === "docker-claude" ||
 * o.container)` passes both of them, because `docker-claude` is the only
 * `ALIASES` entry with `mode: "docker"` today. A behavioural test needs a
 * SECOND docker alias to separate the two, and inventing one in production
 * code to be testable is worse than the gap.
 *
 * So this is a source guard, after `bind-before-spawn.test.ts`'s precedent in
 * this repo. It exists because the gate's comment claims a future alias is
 * covered the day it joins `ALIASES`, and that claim had no test behind it.
 */
test("🛑 the container gate reads the resolved mode, never a driver name", () => {
  const src = readFileSync(
    new URL("../../src/index.ts", import.meta.url),
    "utf8",
  );

  // ⚠️ THE DENOMINATOR FIRST. A guard that greps a file it failed to read, or
  // whose landmark moved, reports clean for the wrong reason.
  assert.ok(src.length > 10_000, `read only ${src.length} bytes of index.ts`);
  assert.equal(
    (src.match(/\.mode === "docker"/g) ?? []).length,
    1,
    "the gate's own condition is gone or duplicated — this guard is now blind",
  );

  // ⚠️ BOTH ARMS ARE ANCHORED ON `===`, AND A BARE `"docker-<name>"` ARM WAS
  // DROPPED. Unscoped, it matched the whole file, so quoting the alias in a
  // comment reported the gate as name-matching while the gate was untouched.
  const nameChecks = [
    ...src.matchAll(/o\.driver\s*===|===\s*"docker-[a-z]+"/g),
  ].map((m) => m[0]);

  assert.deepEqual(
    nameChecks,
    [],
    `the gate is matching a driver NAME: ${nameChecks.join(", ")}. A second ` +
      `vendor spells its own alias differently, so a name match reopens #260 ` +
      `for every alias added after the first.`,
  );
});
