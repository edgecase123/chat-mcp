import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeSpawn } from "../../src/adapters/claude-spawn.js";
import { supervisorArgsFrom } from "../../src/supervise/supervisorArgs.js";

/**
 * 🛑 `manual` IS THE DEFAULT SO THE SHIPPED BEHAVIOUR IS A LIST A SECOND
 * PERSON CAN READ. lee, 2026-10-31: *"manual as default with opt in for auto
 * through an easy flag"*.
 *
 * Measured: `auto` let an un-allowlisted `rm` through with no denial at all.
 * Inverting the ternary that picks it is a sandbox weakening with no signal,
 * and the assertion it used to have was a regex over `src/index.ts`.
 */
test("an explicit --permission-mode wins over --auto", () => {
  const args = supervisorArgsFrom("h", claudeSpawn, {
    permissionMode: "plan",
    auto: true,
  });

  assert.equal(args.permissionMode, "plan");
});

test("--auto alone asks for auto", () => {
  const args = supervisorArgsFrom("h", claudeSpawn, { auto: true });

  assert.equal(args.permissionMode, "auto");
});

test("neither flag names no mode, so the supervisor's own default stands", () => {
  const args = supervisorArgsFrom("h", claudeSpawn, {});

  assert.equal(args.permissionMode, undefined);
});

test("--auto false does not name a mode", () => {
  const args = supervisorArgsFrom("h", claudeSpawn, { auto: false });

  assert.equal(args.permissionMode, undefined);
});

/**
 * 🛑 `none` IS FAIL-CLOSED. Anything that would prompt is denied, so an agent
 * with no human at the terminal cannot stall or run unattended. Only the exact
 * string `host` may widen that.
 */
test("--permission-prompts host is the only value that reaches host", () => {
  assert.equal(
    supervisorArgsFrom("h", claudeSpawn, { permissionPrompts: "host" })
      .permissionPrompts,
    "host",
  );
});

test("an unrecognised --permission-prompts narrows to none", () => {
  for (const value of ["none", "HOST", "both", "", "operator"]) {
    assert.equal(
      supervisorArgsFrom("h", claudeSpawn, { permissionPrompts: value })
        .permissionPrompts,
      "none",
      `${JSON.stringify(value)} widened the prompt target`,
    );
  }
});

test("an absent --permission-prompts narrows to none", () => {
  assert.equal(
    supervisorArgsFrom("h", claudeSpawn, {}).permissionPrompts,
    "none",
  );
});

test("--allowed-tools splits on commas", () => {
  assert.deepEqual(
    supervisorArgsFrom("h", claudeSpawn, { allowedTools: "Read,Bash,Edit" })
      .allowedTools,
    ["Read", "Bash", "Edit"],
  );
});

/**
 * 🛑 UNDEFINED, NOT `[]`. An empty array is an allowlist that permits nothing,
 * and the supervisor's own `DEFAULT_ALLOWED` is what an absent flag means.
 */
test("an absent --allowed-tools leaves the supervisor's default in place", () => {
  assert.equal(
    supervisorArgsFrom("h", claudeSpawn, {}).allowedTools,
    undefined,
  );
});

/**
 * ⚠️ UNGUARDED BEFORE THIS TEST. `reply` and `container` were two of the three
 * `as unknown as` casts in the bag, and no assertion reached either.
 */
test("--no-reply reaches the supervisor as reply false", () => {
  assert.equal(
    supervisorArgsFrom("h", claudeSpawn, { reply: false }).reply,
    false,
  );
});

test("an absent --no-reply leaves reply undefined, which defaults to true", () => {
  assert.equal(supervisorArgsFrom("h", claudeSpawn, {}).reply, undefined);
});

test("--container reaches the supervisor", () => {
  assert.equal(
    supervisorArgsFrom("h", claudeSpawn, { container: true }).container,
    true,
  );
  assert.equal(
    supervisorArgsFrom("h", claudeSpawn, { container: false }).container,
    false,
  );
});

/**
 * 🛑 THE FLAG IS `--resume` AND THE FIELD IS `resumeSessionId`. A rename is
 * the one pass-through that can be dropped without a type error.
 */
test("--resume is carried across the rename", () => {
  assert.equal(
    supervisorArgsFrom("h", claudeSpawn, { resume: "sess-1" }).resumeSessionId,
    "sess-1",
  );
});

test("the plain pass-throughs arrive unchanged", () => {
  const args = supervisorArgsFrom("agent-7", claudeSpawn, {
    model: "opus",
    binary: "/usr/local/bin/claude",
    driver: "docker-claude",
    cwd: "/tmp/work",
  });

  assert.equal(args.handle, "agent-7");
  assert.equal(args.vendor, claudeSpawn);
  assert.equal(args.model, "opus");
  assert.equal(args.binary, "/usr/local/bin/claude");
  assert.equal(args.driver, "docker-claude");
  assert.equal(args.cwd, "/tmp/work");
});
