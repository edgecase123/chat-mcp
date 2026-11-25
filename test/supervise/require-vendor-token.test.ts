import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 🛑 BEFORE any import that resolves a state path, per AGENTS.md.
process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-require-token-home-"),
);

const VENDOR = {
  vendor: "testvendor",
  authEnvVar: "TESTVENDOR_API_KEY",
  authSetupHint: "get a key from the test dashboard",
};

test("requireVendorToken returns the token on file", async () => {
  const { requireVendorToken, setVendorToken } =
    await import("../../src/supervise/auth.js");

  setVendorToken(VENDOR, "a-real-shaped-token");

  assert.equal(requireVendorToken(VENDOR), "a-real-shaped-token");
});

/**
 * 🛑 THE MESSAGE IS THE WHOLE VALUE OF THE REFUSAL. A throw that does not name
 * the env var and the command sends the operator to the spawn layer, which is
 * what #396 looked like before it was diagnosed.
 */
test("requireVendorToken throws, naming the env var and how to store one", async () => {
  const { requireVendorToken } = await import("../../src/supervise/auth.js");

  const absent = {
    vendor: "neverstored",
    authEnvVar: "NEVERSTORED_API_KEY",
    authSetupHint: "there is no hint, this vendor is fictional",
  };

  assert.throws(
    () => requireVendorToken(absent),
    (err: unknown) => {
      const message = (err as Error).message;

      assert.match(message, /NEVERSTORED_API_KEY/);
      assert.match(message, /set-token --vendor neverstored/);
      assert.match(message, /there is no hint, this vendor is fictional/);

      return true;
    },
  );
});

/**
 * 🛑 ONE READ-AND-REFUSE, AND THE INSTRUMENT PRINTS ITS OWN DENOMINATOR.
 *
 * The host and container drivers had byte-identical copies of this guard, and
 * `startSupervisor` a third variant. The host copy's ABSENCE is #396. Counting
 * one literal cannot see a second site that reuses it, so this forbids the
 * CALL outside `auth.ts` instead.
 *
 * ⚠️ COMMENTS ARE STRIPPED FIRST. A docblock mentioning the builder by name
 * would otherwise satisfy a raw grep, and a source-text pin that a comment can
 * launder proves nothing.
 *
 * ⚠️ IT ASSERTS HOW MANY FILES IT READ. A traversal that reached nothing would
 * otherwise report CLEAN, which is the same false green the scan exists to
 * prevent.
 */
test("missingVendorTokenMessage is CALLED in one file only, and the scan reached the tree", async () => {
  const root = new URL("../../src/", import.meta.url).pathname;
  const files: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);

      if (statSync(path).isDirectory()) walk(path);
      else if (path.endsWith(".ts")) files.push(path);
    }
  };

  walk(root);

  // The denominator. `src/` held 70+ TypeScript files when this was written, so
  // anything under 40 means the traversal broke rather than the tree shrank.
  assert.ok(
    files.length > 40,
    `the scan reached only ${files.length} files under src/`,
  );

  const callers = files.filter((path) => {
    const code = readFileSync(path, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");

    return /missingVendorTokenMessage\(/.test(code);
  });

  assert.deepEqual(
    callers.map((path) => path.slice(root.length)),
    ["supervise/auth.ts"],
    "a second site builds the refusal itself instead of calling requireVendorToken",
  );
});

/**
 * 🛑 #449. `claude setup-token` needs a subscription, so demanding a stored
 * token made the whole supervised-agent feature unreachable for an account
 * without one — not degraded, absent. A vendor whose CLI logs in with a
 * browser authenticates itself from the store a host child inherits.
 */
test("resolveHostVendorToken returns null for a cli-login vendor with nothing on file", async () => {
  const { resolveHostVendorToken } =
    await import("../../src/supervise/auth.js");

  assert.equal(
    resolveHostVendorToken({
      vendor: "logsitselfin",
      authEnvVar: "LOGSITSELFIN_API_KEY",
      authSetupHint: "there is no hint, this vendor is fictional",
      hostAuth: "cli-login",
    }),
    null,
  );
});

/**
 * 🛑 THE FALLBACK lee ASKED FOR, AND IT IS A SEPARATE CLAIM. A fix that simply
 * stopped reading the store on the host would satisfy the test above and
 * strand every operator who DOES have a token — the stored value has to keep
 * winning over the CLI's own login, because that is today's behaviour.
 */
test("resolveHostVendorToken still returns a stored token to a cli-login vendor", async () => {
  const { resolveHostVendorToken, setVendorToken } =
    await import("../../src/supervise/auth.js");

  const vendor = {
    vendor: "logsitselfin",
    authEnvVar: "LOGSITSELFIN_API_KEY",
    authSetupHint: "there is no hint, this vendor is fictional",
    hostAuth: "cli-login",
  } as const;

  setVendorToken(vendor, "stored-beats-the-login");

  assert.equal(resolveHostVendorToken(vendor), "stored-beats-the-login");
});

/**
 * 🛑 THE DISCRIMINATOR. Without this arm the two above pass against a
 * resolver that never throws for anybody, which is #396 shipped a second time
 * under a new name.
 */
test("resolveHostVendorToken still throws for a token-required vendor", async () => {
  const { resolveHostVendorToken } =
    await import("../../src/supervise/auth.js");

  assert.throws(
    () =>
      resolveHostVendorToken({
        vendor: "nologinroute",
        authEnvVar: "NOLOGINROUTE_API_KEY",
        authSetupHint: "a dashboard key is the only route",
        hostAuth: "token-required",
      }),
    /no NOLOGINROUTE_API_KEY on file/,
  );
});
