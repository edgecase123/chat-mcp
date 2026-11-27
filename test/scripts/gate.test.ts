import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseTestTotals, verdictFor } from "../../scripts/lib/gate-totals.mjs";

/**
 * 🛑 THIS FILE EXISTS BECAUSE A 15-HOUR HANG REPORTED ZERO FAILURES.
 *
 * pid 84590 ran `node --test` for 15h 22m. Its log showed typecheck EXIT 0 and
 * clean formatting, then nothing from the test step — no verdict, no totals.
 * A grep for `fail` or `not ok` over that log is indistinguishable from a
 * clean sweep, and that is how "11 tests green" got into a status file for a
 * number no run ever produced.
 *
 * The fixtures below are REAL `node --test` output, not hand-written. A
 * hand-written block is a guess at what the runner prints.
 */

const REPO = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Captured verbatim from `node --test --test-timeout=500` against a test that
 * sleeps 3s. 🛑 NOTE `fail 0` BESIDE `cancelled 1` — that is the whole point.
 */
const TIMED_OUT = `ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 0
ℹ cancelled 1
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 506.978917
`;
// Tail trimmed at the totals block: the runner's `✖ failing tests:` section
// names a file and line, and `stale-line-pointers` forbids that in a comment.
// It said `'test timed out after 500ms'`, which is the only thing it added.

/** The same runner, same file, a timeout it fits inside. */
const GREEN = `ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3005.1
`;

test("a timed-out run is RED, and `fail` is not what says so", () => {
  const totals = parseTestTotals(TIMED_OUT);

  assert.equal(totals.fail, 0, "the fixture must really report zero failures");
  assert.equal(totals.cancelled, 1);

  const v = verdictFor(totals);
  assert.equal(v.ok, false);
  assert.match(v.reason, /cancelled/);
});

test("the discriminator is real: a fail-only check calls that same run clean", () => {
  // Without this, the test above passes just as well against a parser that
  // ruled on something else. This is the control for the claim in the header.
  assert.equal(/^\D*\bfail\s+[1-9]/m.test(TIMED_OUT), false);
  assert.equal(verdictFor(parseTestTotals(TIMED_OUT)).ok, false);
});

test("a genuinely green run is GREEN", () => {
  const v = verdictFor(parseTestTotals(GREEN));
  assert.equal(v.ok, true);
  assert.match(v.reason, /1 of 1/);
});

test("🛑 output with NO totals block THROWS rather than reporting zeroes", () => {
  assert.throws(
    () =>
      parseTestTotals("typecheck EXIT 0\nprettier: all matched files use\n"),
    /no totals block/,
  );
});

test("a PARTIAL totals block throws and names what was missing", () => {
  const partial = GREEN.split("\n")
    .filter((l) => !l.includes("cancelled"))
    .join("\n");
  assert.throws(() => parseTestTotals(partial), /missing cancelled/);
});

test("totals that do not add up are RED even with zero failures", () => {
  const totals = {
    tests: 10,
    pass: 4,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
  };
  const v = verdictFor(totals);
  assert.equal(v.ok, false);
  assert.match(v.reason, /do not add up/);
});

test("the glyph is not load-bearing — a stripped transcript parses the same", () => {
  // The same lines arrive with the `ℹ` escaped, entity-encoded or gone
  // depending on who piped them. A glyph-anchored match returns nothing and
  // reads as a clean parse.
  const stripped = TIMED_OUT.replace(/ℹ /g, "");
  assert.deepEqual(parseTestTotals(stripped), parseTestTotals(TIMED_OUT));
});

test("package.json carries BOTH halves of the fix", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  assert.match(
    pkg.scripts.gate ?? "",
    /scripts\/gate\.sh/,
    "there is no gate script",
  );
  // Both halves in one pattern: the knob is wired AND it falls back to a
  // number, so a bare `npm test` with no env set still cannot hang forever.
  assert.match(
    pkg.scripts.test ?? "",
    /--test-timeout=\$\{GATE_TEST_TIMEOUT_MS:-\d+\}/,
    "a bare `npm test` must not be able to hang forever",
  );
});

test("🛑 gate.sh hardcodes no worktree path — that was the defect it replaces", () => {
  // `snippets/gate.sh` was pinned to one worktree, so the agent in the other
  // one was told not to run it. Two agents, one script, one of them gateless.
  const src = readFileSync(join(REPO, "scripts", "gate.sh"), "utf8");
  assert.equal(/\/Users\/|\/home\/|dev\/chat-mcp/.test(src), false);
  assert.match(
    src,
    /BASH_SOURCE/,
    "the root must be derived from the script's own location",
  );
});

/** gate.sh in a throwaway git repo, so $REPO is the temp dir, not this one. */
function gateIn(dir: string, args: string[]): number {
  try {
    execFileSync("bash", [join(dir, "scripts", "gate.sh"), ...args], {
      stdio: "pipe",
    });
    return 0;
  } catch (err) {
    return (err as { status?: number }).status ?? -1;
  }
}

test("gate.sh: help is 0, a bad argument is 2, a dirty tree is 3", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-mcp-gate-"));
  mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
  cpSync(join(REPO, "scripts", "gate.sh"), join(dir, "scripts", "gate.sh"));
  cpSync(
    join(REPO, "scripts", "lib", "gate-totals.mjs"),
    join(dir, "scripts", "lib", "gate-totals.mjs"),
  );
  execFileSync("git", ["init", "-q"], { cwd: dir });

  assert.equal(gateIn(dir, ["--help"]), 0, "help is not an error");
  assert.equal(gateIn(dir, ["--bogus"]), 2, "an unknown argument is bad usage");

  writeFileSync(join(dir, "uncommitted.txt"), "x");
  assert.equal(gateIn(dir, []), 3, "🛑 a dirty tree must REFUSE, not gate");
});

/**
 * A throwaway repo with `build`, `typecheck` and `format:check` stubbed to
 * `true`, so only the test step runs. `--allow-dirty` keeps git out of it.
 */
function stubRepo(testScript: string): string {
  const dir = mkdtempSync(join(tmpdir(), "chat-mcp-gatestub-"));
  mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
  cpSync(join(REPO, "scripts", "gate.sh"), join(dir, "scripts", "gate.sh"));
  cpSync(
    join(REPO, "scripts", "lib", "gate-totals.mjs"),
    join(dir, "scripts", "lib", "gate-totals.mjs"),
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "gatestub",
      private: true,
      scripts: {
        build: "true",
        typecheck: "true",
        "format:check": "true",
        test: testScript,
      },
    }),
  );
  return dir;
}

function runGate(dir: string, env: Record<string, string>) {
  try {
    const stdout = execFileSync(
      "bash",
      [join(dir, "scripts", "gate.sh"), "--allow-dirty"],
      {
        cwd: dir,
        // 🛑 NODE_TEST_CONTEXT makes a NESTED `node --test` wait for a parent
        // reporter that is not listening, and the inner run hangs forever.
        env: { ...process.env, NODE_TEST_CONTEXT: undefined, ...env },
        encoding: "utf8",
        stdio: "pipe",
      },
    );
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? "" };
  }
}

test("🛑 the wall ceiling kills the RUNNER, not just the npm wrapper", () => {
  // Killing the npm pid alone leaves the child alive and reparented to pid 1.
  // The ceiling then cannot end the hang it exists for, and the orphan
  // poisons the next session's `pgrep -f "node --test"` pre-flight.
  const dir = stubRepo(
    `node -e "require('fs').writeFileSync(process.env.PIDFILE, String(process.pid)); setInterval(() => {}, 1000)"`,
  );
  const pidFile = join(dir, "grandchild.pid");

  const { status } = runGate(dir, { PIDFILE: pidFile, GATE_WALL_SECONDS: "2" });

  // 🛑 REAP BEFORE ASSERTING. When this test fails, it fails BECAUSE the stub
  // is still alive — so asserting first strands it on a shared host, which is
  // the poisoned `pgrep` pre-flight this very change exists to prevent.
  // ⚠️ READ DEFENSIVELY. A `gate.sh` that dies UPSTREAM of the ceiling never
  // runs the stub, so a bare read throws ENOENT and buries the named assertion
  // below under a filesystem error.
  const pid = existsSync(pidFile)
    ? Number(readFileSync(pidFile, "utf8").trim())
    : 0;
  const alive = isAlive(pid);
  if (alive) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* it exited between the check and the kill */
    }
  }

  assert.notEqual(status, 0, "a run the ceiling killed is RED, never green");
  assert.ok(pid > 0, "the stub must really have recorded a grandchild pid");
  assert.equal(
    alive,
    false,
    `the runner (pid ${pid}) outlived the wall ceiling`,
  );
});

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("🛑 GATE_TEST_TIMEOUT_MS is a LIVE knob, not a printed one", () => {
  // `npm test -- --test-timeout=X` lands AFTER the glob and node silently
  // ignores it. The knob read as live and did nothing. So it travels as an
  // env var the `test` script interpolates, and this proves it arrives.
  const dir = mkdtempSync(join(tmpdir(), "chat-mcp-gateknob-"));
  mkdirSync(join(dir, "scripts", "lib"), { recursive: true });
  mkdirSync(join(dir, "test"));
  cpSync(join(REPO, "scripts", "gate.sh"), join(dir, "scripts", "gate.sh"));
  cpSync(
    join(REPO, "scripts", "lib", "gate-totals.mjs"),
    join(dir, "scripts", "lib", "gate-totals.mjs"),
  );
  writeFileSync(
    join(dir, "test", "slow.test.mjs"),
    `import { test } from "node:test";\n` +
      `test("sleeps 400ms", async () => { await new Promise((r) => setTimeout(r, 400)); });\n`,
  );
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "gateknob",
      private: true,
      scripts: {
        build: "true",
        typecheck: "true",
        "format:check": "true",
        test: "node --test --test-timeout=${GATE_TEST_TIMEOUT_MS:-60000} 'test/**/*.test.mjs'",
      },
    }),
  );

  const generous = runGate(dir, { GATE_WALL_SECONDS: "60" });
  assert.equal(
    generous.status,
    0,
    `a 400ms test under the default ceiling is green:\n${generous.stdout}`,
  );

  const tight = runGate(dir, {
    GATE_TEST_TIMEOUT_MS: "50",
    GATE_WALL_SECONDS: "60",
  });
  assert.notEqual(tight.status, 0, "a 50ms ceiling must cancel the same test");
  assert.match(tight.stdout, /cancelled 1/, "and `cancelled` is what says so");
});

test("gate.sh does not pass the timeout through `npm test --`", () => {
  // The control for the test above: it would pass just as well against the
  // broken form if the broken form happened to also work.
  // 🛑 COMMENTS STRIPPED FIRST. gate.sh explains the broken form in a comment
  // quoting it, and the first cut of this guard matched that comment and
  // failed against a correct script.
  const src = readFileSync(join(REPO, "scripts", "gate.sh"), "utf8")
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");

  assert.equal(
    /npm test\s+--\s+--test-timeout/.test(src),
    false,
    "a flag after the glob is silently ignored by node",
  );
  // The stripper must not be so eager that the guard can never fire.
  assert.match(
    src,
    /npm test >"\$LOG"/,
    "the real invocation survived the strip",
  );
  assert.match(src, /export GATE_TEST_TIMEOUT_MS/);
  assert.match(
    src,
    /kill -9 -- "-\$TEST_PID"/,
    "the ceiling must kill the process GROUP",
  );
});
