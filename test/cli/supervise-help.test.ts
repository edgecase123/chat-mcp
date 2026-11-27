import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

/**
 * 🛑 THE SERVED HELP, NOT THE SOURCE TEXT. The assertions this replaces read
 * `src/index.ts` and matched a 400-character window after the `--auto`
 * literal, so the words they required could be satisfied by the comment block
 * beside the flag while the operator-facing string said nothing.
 *
 * It also proves `--auto` is still WIRED. `supervisorArgsFrom` can resolve the
 * mode perfectly with the flag deleted from the command.
 */

const ENTRY = resolve(import.meta.dirname, "..", "..", "src", "index.ts");

/** Commander wraps help at the terminal width, so compare on one line. */
function superviseHelp(): Promise<string> {
  return new Promise((done) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", ENTRY, "supervise", "--help"],
      { env: { ...process.env } },
    );
    let out = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString()));
    child.stderr.on("data", (c: Buffer) => (out += c.toString()));
    child.on("close", () => done(out.replace(/\s+/gu, " ")));
  });
}

test("supervise offers --auto as the opt-in flag", async () => {
  assert.match(await superviseHelp(), /--auto\b/u);
});

/**
 * 🛑 `manual` IS THE DEFAULT SO THE SHIPPED BEHAVIOUR IS A LIST A SECOND
 * PERSON CAN READ. lee, 2026-10-31: *"manual as default with opt in for auto
 * through an easy flag"*, because *"I want it to be usable by other devs
 * too"*.
 *
 * Measured: `auto` let an un-allowlisted `rm` through with no denial at all.
 * An operator choosing it has to be told that is the trade, not just that the
 * flag reduces friction.
 */
test("the help text says what --auto costs, not just what it does", async () => {
  const help = await superviseHelp();
  const flagAt = help.indexOf("--auto");
  assert.notEqual(flagAt, -1, "the --auto flag is gone");
  const blurb = help.slice(flagAt, flagAt + 300);

  assert.match(blurb, /allowlist/u, "the flag does not say what it replaces");
  assert.match(
    blurb,
    /not written down|cannot read|second person/u,
    "it does not state the cost",
  );
});

test("the help text says manual enforces the allowlist", async () => {
  assert.match(
    await superviseHelp(),
    /default: manual, which enforces the allowlist/u,
  );
});
