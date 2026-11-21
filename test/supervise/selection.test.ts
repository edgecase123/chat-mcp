import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-selection-"));

/** A second, EMPTY state dir, for the tests that must see no file at all. */
const COLD_HOME = mkdtempSync(join(tmpdir(), "chat-mcp-selection-cold-"));

const { selectionFor } = await import("../../src/supervise/selection.js");
const { resolveDriver } = await import("../../src/supervise/drivers/index.js");
const { registerAgent } = await import("../../src/supervise/registrations.js");

/**
 * The core of #132 slice 2: a stored pair is what the handle starts on when
 * the operator named nothing on the command line.
 */
test("a registered handle starts on its stored vendor and mode", () => {
  registerAgent("stored", { vendor: "cursor", mode: "docker" });

  assert.deepEqual(selectionFor("stored", {}), {
    vendor: "cursor",
    mode: "docker",
  });
});

/**
 * 🛑 THE PRECEDENCE RULE, AND IT HAD NO TEST BEFORE THIS FILE. PR 360 stated
 * it in a docblock only, because there was no reader to assert it against.
 */
test("an explicit --driver beats the stored vendor", () => {
  registerAgent("overridden", { vendor: "cursor", mode: "host" });

  assert.equal(
    selectionFor("overridden", { driver: "claude" }).vendor,
    "claude",
  );
});

test("an explicit --container tightens a stored host mode to docker", () => {
  registerAgent("tighten", { vendor: "claude", mode: "host" });

  assert.equal(selectionFor("tighten", { container: true }).mode, "docker");
});

/**
 * 🛑 A FLAG MAY TIGHTEN THE MODE AND MAY NEVER LOOSEN IT.
 *
 * `--driver claude` is an alias naming `mode: host`, and `resolveDriver`
 * returns `host` for it and for a bare invocation alike — the two are
 * indistinguishable downstream. So treating that `host` as an override would
 * hand the operator an UNCONTAINED agent while `agents.json` and the web card
 * both say contained. `registrations.ts` refuses an unknown mode for the same
 * reason, and `resolveDriver` already says `--container` can only tighten.
 */
test("a host-naming driver alias does NOT loosen a stored docker mode", () => {
  registerAgent("contained", { vendor: "cursor", mode: "docker" });

  assert.deepEqual(selectionFor("contained", { driver: "claude" }), {
    vendor: "claude",
    mode: "docker",
  });
});

/**
 * 🛑 THE AXES ARE INDEPENDENT. `--container` says nothing about which CLI to
 * drive, so it must not reset the vendor to the `claude` default that
 * `resolveDriver` returns when no `--driver` is given.
 */
test("--container alone keeps the stored vendor", () => {
  registerAgent("axes", { vendor: "cursor", mode: "host" });

  assert.deepEqual(selectionFor("axes", { container: true }), {
    vendor: "cursor",
    mode: "docker",
  });
});

/**
 * 🛑 THE NEGATIVE CONTROL. With no file at all the composed reader must be
 * byte-identical to the old flag-only path, so slice 2 cannot change how any
 * unregistered handle starts.
 */
test("an unregistered handle resolves exactly as the flag-only path did", () => {
  const prior = process.env.CHAT_MCP_HOME;
  process.env.CHAT_MCP_HOME = COLD_HOME;

  try {
    for (const flags of [
      {},
      { driver: "cursor" },
      { container: true },
      { driver: "docker-cursor" },
      { driver: "claude", container: true },
    ]) {
      assert.deepEqual(
        selectionFor("nobody", flags),
        resolveDriver(flags),
        `flags ${JSON.stringify(flags)} must not change for an unregistered handle`,
      );
    }
  } finally {
    process.env.CHAT_MCP_HOME = prior;
  }
});

/**
 * 🛑 AN UNREADABLE FILE MUST THROW, NOT FALL BACK TO THE DEFAULT PAIR.
 *
 * `try { registrationFor() } catch { return resolveDriver() }` is the obvious
 * implementation and it is the dangerous one: one bad byte would start every
 * handle uncontained on `claude` while the operator's file says otherwise, and
 * nothing would say so. `readRegistrations` escalates on purpose — these cases
 * pin that the escalation survives composition.
 *
 * 🛑 BOTH REFUSAL PATHS ARE COVERED, BECAUSE THEY ARE DIFFERENT GUARDS. A
 * stray comma dies in the `JSON.parse` wrapper at `registrations.ts:119`; a
 * mode outside `host | docker` dies in `parseRecord` at `:88`. An earlier cut
 * of this test named the comma and exercised only the second, so the claim
 * was true and this test was not what proved it. Raised by claude2 on PR 362.
 *
 * ⚠️ THE REGEX ANCHORS ON THE REFUSAL PREFIX, NOT ON A WORD IN THE DETAIL.
 * `/mode/` greened on any error whose message happened to contain "mode".
 */
for (const [label, bytes] of [
  ["a stray comma", '{"agents":{"x":{"vendor":"cursor","mode":"host"},}}'],
  [
    "a mode outside host|docker",
    '{"agents":{"x":{"vendor":"cursor","mode":"nope"}}}',
  ],
  [
    "a key this file refuses",
    '{"agents":{"x":{"vendor":"cursor","mode":"host","profile":"p"}}}',
  ],
] as const) {
  test(`${label} in agents.json throws rather than falling back to the default pair`, () => {
    const broken = mkdtempSync(join(tmpdir(), "chat-mcp-selection-broken-"));
    writeFileSync(join(broken, "agents.json"), bytes);

    const prior = process.env.CHAT_MCP_HOME;
    process.env.CHAT_MCP_HOME = broken;

    try {
      assert.throws(
        () => selectionFor("x", {}),
        /refusing .*agents\.json|cannot read .*agents\.json/,
      );
    } finally {
      process.env.CHAT_MCP_HOME = prior;
    }
  });
}
