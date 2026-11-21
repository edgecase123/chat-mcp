import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-regs-"));

/** A second, EMPTY state dir, for the two tests that must see no file at all. */
const COLD_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-regs-cold-"));

const {
  registerAgent,
  unregisterAgent,
  readRegistrations,
  registrationFor,
  registrationsPath,
} = await import("../../src/supervise/registrations.js");
const { stateDir } = await import("../../src/util/paths.js");

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

/**
 * 🛑 STAGE AND RENAME, BECAUSE THIS READER THROWS. Raised by claude2 on PR 360.
 *
 * `auth.ts`'s own docblock gives the reason for `secrets.env`: a
 * truncate-in-place that dies mid-write leaves a plausible-looking partial.
 * Here it is worse. `readRegistrations` refuses a malformed document, so one
 * torn write stops EVERY handle rather than the one being written.
 *
 * 🛑 THE CONTROL IS A READ-ONLY LIVE FILE, NOT AN ABSENT TEMP FILE. Asserting
 * no `.tmp` survives passes just as well when nothing was ever staged.
 * `writeFileSync` on a 0400 file raises EACCES; `renameSync` over one succeeds,
 * because replacing a directory entry needs the DIRECTORY's write bit and not
 * the file's. So this goes red on a truncate-in-place writer and green on a
 * staged one.
 */
test("🛑 the write is STAGED, so a torn write cannot take every handle down with it", (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("file modes are not enforceable here");
    return;
  }

  writeFileSync(registrationsPath(), JSON.stringify({ agents: {} }));
  chmodSync(registrationsPath(), 0o400);

  registerAgent("staged", { vendor: "claude", mode: "docker" });

  assert.deepEqual(registrationFor("staged"), {
    vendor: "claude",
    mode: "docker",
  });
});

/**
 * ⚠️ IT DOES ITS OWN WRITE, RATHER THAN READING THE ONE ABOVE.
 *
 * Raised by claude2 on PR 360: the test above SKIPS where file modes are not
 * enforceable, and a leftover check that inspects the directory afterwards
 * then passes because nothing was ever staged. Calling `registerAgent` here
 * makes this assertion mean the same thing on every platform.
 */
test("and no staging file survives a write, on every platform", () => {
  registerAgent("leftovers", { vendor: "claude", mode: "host" });

  const stray = readdirSync(stateDir()).filter((f) =>
    f.startsWith("agents.json."),
  );

  assert.deepEqual(stray, []);
});

/**
 * 🛑 A WRITER THAT CREATES WHAT IT WAS ASKED TO REMOVE. Raised by claude2 on
 * PR 360, and `overrideStore.ts`'s header states the principle: a module that
 * creates the file it is about to read cannot tell "nothing configured" from
 * "the operator's file is missing".
 *
 * ⚠️ THE TWO TESTS BELOW RUN AGAINST A SECOND, EMPTY STATE DIR, and each one
 * sets it ITSELF. Reassigning it once in the first test made the second depend
 * on the first having run — order coupling claude2 flagged on PR 360.
 */
test("🛑 unregistering a handle that was never registered creates NOTHING", () => {
  process.env.CHAT_MCP_HOME = COLD_HOME;

  unregisterAgent("nobody");

  assert.equal(existsSync(registrationsPath()), false);
  assert.equal(registrationFor("nobody"), null);
});

test("and nor does unregistering an absent handle from a file that DOES exist rewrite it", () => {
  process.env.CHAT_MCP_HOME = COLD_HOME;
  registerAgent("keeper", { vendor: "cursor", mode: "host" });
  const before = readFileSync(registrationsPath(), "utf8");
  // 🛑 THE INODE IS THE DISCRIMINATOR, NOT THE BYTES. A rewrite reproduces
  // identical bytes, so a content comparison passes either way. A staged write
  // renames a NEW file over this path, which changes the inode.
  const inode = statSync(registrationsPath()).ino;

  unregisterAgent("nobody");

  assert.equal(readFileSync(registrationsPath(), "utf8"), before);
  assert.equal(statSync(registrationsPath()).ino, inode);
  assert.deepEqual(registrationFor("keeper"), {
    vendor: "cursor",
    mode: "host",
  });
});
