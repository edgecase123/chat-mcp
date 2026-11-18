import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 🛑 REVERTING THE `cli` HALF OF #314's FIX SURVIVED THE WHOLE SUITE.
 *
 * claude1 measured it on PR 316: deleting the `resolveDefaultHandle` call from
 * the `cli` action left 2043 passing at the baseline denominator. The `web`
 * half has a behavioural test that starts a server and reads its banner; the
 * `cli` half had nothing, because starting a REPL to read its identity back is
 * not worth a second spawned process (see the ERANGE note in
 * `test/cli/web/handle-default-wiring.test.ts`).
 *
 * So this is a PAIRING assertion over the source instead: every command that
 * takes an OPTIONAL `--handle` is accounted for, and the two that register this
 * process as a peer must both reach the resolver.
 *
 * ⚠️ A `requiredOption("--handle")` IS A DIFFERENT THING and is excluded on
 * purpose. `install`, `uninstall` and `report-context` name ANOTHER agent, so
 * there is no identity of this process's to default.
 */

const SRC = readFileSync(
  new URL("../../src/index.ts", import.meta.url),
  "utf8",
);

/**
 * 🛑 COMMENTS ARE STRIPPED FIRST, so this file's own prose and the docblocks in
 * `index.ts` cannot satisfy any assertion below. Pattern borrowed from
 * `test/cli/web/gauge-payload-scope.test.ts`.
 */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Each `.command("name")` registration and the source that follows it. */
function commandBlocks(src: string): Map<string, string> {
  const starts = [...src.matchAll(/\.command\(\s*"([a-z-]+)/g)];
  const blocks = new Map<string, string>();

  starts.forEach((m, i) => {
    const from = m.index;
    const to = starts[i + 1]?.index ?? src.length;
    blocks.set(m[1] as string, src.slice(from, to));
  });

  return blocks;
}

/**
 * The commands whose `--handle` IS this process's own identity. Both must
 * default it the same way, or half the fix is revertible in silence.
 */
const PEER_COMMANDS = ["cli", "web"];

/**
 * Every command taking an OPTIONAL `--handle` today, peer or not. A new one
 * fails this test, which is the point: the author has to say which list it
 * belongs in rather than inherit a default by omission.
 */
const OPTIONAL_HANDLE_COMMANDS = ["cli", "web", "inbox"];

test("🛑 every command that registers THIS process as a peer resolves its handle the same way", () => {
  const blocks = commandBlocks(withoutComments(SRC));

  for (const name of PEER_COMMANDS) {
    const block = blocks.get(name);
    assert.ok(block, `no .command("${name}") found in src/index.ts`);
    assert.match(
      block,
      /resolveDefaultHandle\(/,
      `the "${name}" command does not call resolveDefaultHandle, so an operator who passes no --handle gets whatever commander defaulted`,
    );
    assert.doesNotMatch(
      block,
      /\.option\(\s*\n?\s*"--handle <handle>",\s*\n?\s*"[^"]*",\s*\n?\s*"/,
      `the "${name}" command passes a hardcoded default to --handle, which is the #314 bug`,
    );
  }
});

test("🛑 the set of commands taking an OPTIONAL --handle is accounted for, so a NEW one cannot inherit a default silently", () => {
  const blocks = commandBlocks(withoutComments(SRC));
  const found = [...blocks]
    .filter(([, block]) => /\.option\(\s*\n?\s*"--handle/.test(block))
    .map(([name]) => name)
    .sort();

  assert.deepEqual(
    found,
    [...OPTIONAL_HANDLE_COMMANDS].sort(),
    "a command's optional --handle is unclassified: add it to PEER_COMMANDS if it registers this process as a peer, or to OPTIONAL_HANDLE_COMMANDS if it names someone else",
  );

  // The denominator, printed rather than assumed. A parser that found no
  // command blocks at all would satisfy every assertion above vacuously.
  assert.ok(
    blocks.size >= 15,
    `only ${blocks.size} command blocks parsed out of src/index.ts — the parser is the thing that broke, not the source`,
  );
});
