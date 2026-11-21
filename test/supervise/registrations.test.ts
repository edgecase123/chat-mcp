import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-regs-"));

const {
  registerAgent,
  unregisterAgent,
  readRegistrations,
  registrationFor,
  registrationsPath,
} = await import("../../src/supervise/registrations.js");

/**
 * ⚠️ `null` IS THE NORMAL CASE. Every handle started from the CLI with flags
 * has no registration, and that must not read as an error.
 */
test("a handle with no registration reads as null, not an error", () => {
  assert.equal(registrationFor("nobody"), null);
  assert.deepEqual(readRegistrations(), { agents: {} });
});

test("a registered handle round-trips vendor and mode", () => {
  registerAgent("claude1", { vendor: "claude", mode: "docker" });

  assert.deepEqual(registrationFor("claude1"), {
    vendor: "claude",
    mode: "docker",
  });
});

test("and host is stored as faithfully as docker", () => {
  registerAgent("hosty", { vendor: "cursor", mode: "host" });

  assert.deepEqual(registrationFor("hosty"), {
    vendor: "cursor",
    mode: "host",
  });
});

test("one handle's registration does not leak into another's", () => {
  assert.equal(registrationFor("claude1")?.vendor, "claude");
  assert.equal(registrationFor("hosty")?.vendor, "cursor");
});

/**
 * 🛑 MALFORMED THROWS HERE, UNLIKE `readProjects` AND `readMounts`.
 *
 * Those two read empty on purpose, because `dirsFor` reports an empty
 * registration loudly. An empty read HERE is byte-identical to the normal
 * no-file case, so a stray comma would spawn a handle on the default
 * (vendor, mode) pair while its operator's file says something else, and
 * nothing would say so.
 */
test("a malformed agents.json THROWS rather than reading as empty", () => {
  writeFileSync(registrationsPath(), '{ "agents": {,} }');

  assert.throws(() => readRegistrations(), /cannot read/);
});

/** 🛑 THE PATH IS IN THE MESSAGE. `JSON.parse` names no file. */
test("and the refusal names the file, because JSON.parse does not", () => {
  assert.throws(() => readRegistrations(), {
    message: new RegExp(
      registrationsPath().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ),
  });
});

/**
 * 🛑 AN UNKNOWN MODE MUST NOT FALL BACK TO `host`.
 *
 * `resolveDriver` derives the mode from a boolean, so any value it does not
 * recognise reads as `host` — the LOOSER of the two. An operator who wrote
 * `"Docker"` would get an uncontained agent and a card that says contained.
 */
test("an unrecognised mode is refused, never read as host", () => {
  writeFileSync(
    registrationsPath(),
    JSON.stringify({ agents: { x: { vendor: "claude", mode: "Docker" } } }),
  );

  assert.throws(() => readRegistrations(), /mode/);
});

test("a missing mode is refused too, rather than defaulting", () => {
  writeFileSync(
    registrationsPath(),
    JSON.stringify({ agents: { x: { vendor: "claude" } } }),
  );

  assert.throws(() => readRegistrations(), /mode/);
});

test("a missing or non-string vendor is refused", () => {
  writeFileSync(
    registrationsPath(),
    JSON.stringify({ agents: { x: { mode: "host" } } }),
  );
  assert.throws(() => readRegistrations(), /vendor/);

  writeFileSync(
    registrationsPath(),
    JSON.stringify({ agents: { x: { vendor: 7, mode: "host" } } }),
  );
  assert.throws(() => readRegistrations(), /vendor/);
});

/**
 * 🛑 THE KEY IS A HANDLE AND IS VALIDATED ON THE WAY IN AND OUT.
 *
 * Not because this one becomes a filename — it does not — but because the
 * spawn path reads it and `notifyPathFor` does. A key refused there and
 * accepted here is a registration that can never be honoured.
 */
test("an illegal handle is refused at registration", () => {
  assert.throws(
    () => registerAgent("Claude1", { vendor: "claude", mode: "host" }),
    /Invalid handle/,
  );
});

test("and an illegal handle already in the file is refused on read", () => {
  writeFileSync(
    registrationsPath(),
    JSON.stringify({ agents: { Claude1: { vendor: "claude", mode: "host" } } }),
  );

  assert.throws(() => readRegistrations(), /Invalid handle/);
});

/**
 * 🛑 AN UNKNOWN KEY IS REFUSED, NOT IGNORED.
 *
 * `profile`, `display_name` and `project_dir` were all proposed for this file
 * and all three are owned elsewhere — the override file, the `agents` table
 * and `projects.json`. Ignoring one silently gives the operator a second
 * source of truth that nothing reads.
 */
test("an unknown key in a record is refused, so this file cannot grow a second source of truth", () => {
  writeFileSync(
    registrationsPath(),
    JSON.stringify({
      agents: { x: { vendor: "claude", mode: "host", profile: "lean" } },
    }),
  );

  assert.throws(() => readRegistrations(), /profile/);
});

test("unregister removes one handle and leaves its siblings", () => {
  writeFileSync(registrationsPath(), JSON.stringify({ agents: {} }));
  registerAgent("a", { vendor: "claude", mode: "host" });
  registerAgent("b", { vendor: "cursor", mode: "docker" });

  unregisterAgent("a");

  assert.equal(registrationFor("a"), null);
  assert.deepEqual(registrationFor("b"), {
    vendor: "cursor",
    mode: "docker",
  });
});

test("re-registering a handle replaces its record rather than merging", () => {
  registerAgent("b", { vendor: "claude", mode: "host" });

  assert.deepEqual(registrationFor("b"), {
    vendor: "claude",
    mode: "host",
  });
});

/** The file sits in the state dir beside its three siblings, owner-only. */
test("the file is written owner-only, like every other state file", () => {
  registerAgent("c", { vendor: "claude", mode: "host" });

  assert.equal(
    registrationsPath(),
    join(process.env.CHAT_MCP_HOME!, "agents.json"),
  );
  if (process.platform !== "win32") {
    assert.equal(statSync(registrationsPath()).mode & 0o777, 0o600);
  }
});
