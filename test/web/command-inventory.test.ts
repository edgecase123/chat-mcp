import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { commandRows } from "../../web/assets/logic.js";
import { KNOWN_SUBCOMMANDS } from "../../src/util/subcommands.js";
import {
  INVENTORY,
  INVENTORY_LABELS,
  INVENTORY_PREFIXES,
} from "../../web/assets/inventory.js";

/**
 * 🛑 THE DEFECT THIS GUARDS IS A SHEET THAT READS AS COMPLETE AND IS NOT.
 * `/cli-commands` claims to list this project's CLI. A hand-kept list goes
 * stale the first time a command is added, and nothing on screen says so —
 * which is the whole reason #429 was re-ranked from `enhancement` to `bug`.
 *
 * 🛑 IT PINS NAMES, NOT DESCRIPTIONS. A description is editorial: the CLI's
 * own are multi-line `--help` prose. A name appearing or disappearing is the
 * drift that makes the sheet lie, and that is what reds here.
 *
 * Each test asserts its own denominator, so an extractor that matched nothing
 * cannot pass by comparing two empty sets.
 */

const namesIn = (cat: string): string[] =>
  INVENTORY.filter((c: { cat: string }) => c.cat === cat)
    .map((c: { name: string }) => c.name)
    .sort();

/** `help`, `--help`, `-h`, `--version`, `-V` are commander's own, not verbs. */
const HELP_AND_VERSION = new Set(["help", "--help", "-h", "--version", "-V"]);

const srcText = (rel: string): string =>
  readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

test("🛑 every chat-mcp subcommand appears on the CLI sheet", () => {
  const real = [...KNOWN_SUBCOMMANDS]
    .filter((c) => !HELP_AND_VERSION.has(c))
    .sort();

  assert.deepEqual(
    namesIn("cli"),
    real,
    "the CLI sheet drifted from KNOWN_SUBCOMMANDS",
  );

  // 🛑 AND `KNOWN_SUBCOMMANDS` ITSELF MUST NOT DRIFT FROM COMMANDER.
  // `test/supervise/subcommands.test.ts` only asserts every commander verb is
  // IN the set, never the reverse. Before this sheet existed a stale entry
  // cost an `unknown command` at a terminal. Now the sheet RENDERS it with a
  // copy button, so an operator pastes a command that does not exist — which
  // is this ticket's own defect class. Caught by claude2 on PR 432.
  const registered = [
    ...srcText("src/index.ts").matchAll(/\.command\(['"]([^'"\s<[]+)/g),
  ]
    .map((m) => m[1])
    .sort();
  assert.deepEqual(
    real,
    registered,
    "KNOWN_SUBCOMMANDS lists a verb commander never registers",
  );

  // The denominator. A filter that removed everything would pass the compare.
  assert.equal(real.length, 18);
});

test("🛑 every registered MCP tool appears on the sheet", () => {
  // The shim registers tools across 21 files and some files register more
  // than one — claims.ts registers three, run_command.ts two. Counting files
  // undercounts the surface by three, so this reads the registrations.
  const dir = new URL("../../src/shim/tools/", import.meta.url);
  const real = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) => [
      ...readFileSync(new URL(f, dir), "utf8").matchAll(
        /registerTool\(\s*"([a-z_]+)"/g,
      ),
    ])
    .map((m) => m[1])
    .sort();

  assert.deepEqual(namesIn("mcp"), real, "the MCP sheet drifted from the shim");
  // The denominator, and it is NOT the file count — see the note above.
  assert.equal(real.length, 24);
});

test("🛑 every scripts/agent verb appears on the sheet", () => {
  // The dispatch `case` is the authority, not the usage text above it. A verb
  // documented but not dispatched, or the reverse, is the drift that matters.
  const body = srcText("scripts/agent");
  const arms = body.slice(body.lastIndexOf("case "));
  const real = [...arms.matchAll(/^\s{2}([a-z-]+)\)\s/gm)]
    .map((m) => m[1])
    .sort();

  assert.deepEqual(
    namesIn("supervisor"),
    real,
    "the supervisor sheet drifted from scripts/agent",
  );
  assert.equal(real.length, 4);
});

test("🛑 every inventory row sits in a category that has a heading AND a prefix", () => {
  // A typo'd `cat` is silent: commandRows iterates the LABELS, so the row is
  // simply never rendered and the sheet is short by one with no error.
  const cats = [
    ...new Set(INVENTORY.map((c: { cat: string }) => c.cat)),
  ].sort();
  assert.deepEqual(cats, ["cli", "mcp", "supervisor"]);
  assert.deepEqual(Object.keys(INVENTORY_LABELS).sort(), cats);
  assert.deepEqual(Object.keys(INVENTORY_PREFIXES).sort(), cats);
});

test("🛑 EVERY inventory row reaches the sheet, not just every category", () => {
  // 🛑 THIS IS THE HALF THE DELETED TEST CARRIED THAT STILL MATTERS. The old
  // `/cli-commands` test pinned the row COUNT against the real table, so a
  // builder returning [] could not pass. The category tests use a 4-row
  // fixture and never see the shipped one.
  const rows = commandRows(
    INVENTORY,
    INVENTORY_LABELS,
    INVENTORY_PREFIXES,
  ).flatMap((s: { rows: unknown[] }) => s.rows);

  assert.equal(rows.length, INVENTORY.length, "a row never reached the sheet");
  // The denominator, so an empty INVENTORY cannot satisfy the compare.
  assert.equal(INVENTORY.length, 46);
});
