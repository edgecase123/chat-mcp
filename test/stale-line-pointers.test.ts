import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { committableFiles } from "./support/committable-files.js";

/**
 * 🛑 A `file.ts:NNN` POINTER IN PROSE FAILS SILENTLY. The Prettier adoption
 * moved 37,669 lines, so a pointer written before it lands on unrelated code
 * and still reads as verified. 34 of them were stale at once.
 *
 * Name the SYMBOL instead. A symbol survives a reflow and a rename shows up as
 * a grep miss; a line number survives neither and says nothing when it breaks.
 */

const ROOT = join(import.meta.dirname, "..");

/**
 * A path with a known source extension and a line number, and the bare
 * backtick-colon-digits continuation form that follows one.
 *
 * 🛑 NEITHER FORM IS SPELT OUT ANYWHERE IN THIS FILE. This file is inside its
 * own scan, so an illustrative example here is a real offence — and the first
 * draft shipped one, which claude1 caught. Every example below is assembled at
 * run time instead.
 */
const POINTER =
  /[A-Za-z0-9_/.-]+\.(?:ts|tsx|js|mjs|cjs|css|html|json|md|sh|yml):\d+/;
const BARE_POINTER = /`:\d+`/;

/**
 * Paths allowed to keep a line number, each for a reason that is not "we did
 * not get round to it".
 */
const ALLOWED: readonly { prefix: string; why: string }[] = [
  {
    prefix: "docs/superpowers/",
    why: "frozen records — `docs/system/README.md` fixes a spec or plan at the date in its filename, so editing one rewrites history",
  },
  {
    prefix: ".claude/agents/",
    why: "the pointers are inside EXAMPLE output showing an agent its report format, not references to real code",
  },
  {
    prefix: "test/supervise/body-reaches-sender.test.ts",
    why: "its docblock cites the historical shift of one call site as the argument AGAINST line numbers; the numbers are the evidence",
  },
];

function allowedReason(path: string): string | null {
  return ALLOWED.find((a) => path.startsWith(a.prefix))?.why ?? null;
}

/** Every text file a commit would carry, so the scan has a denominator. */
function textFiles(): string[] {
  return committableFiles()
    .filter((p) => !/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|zip|pdf)$/i.test(p))
    .filter((p) => p !== "package-lock.json");
}

/** Every pointer in `text`, each reported as `path:line — the match`. */
function pointersIn(path: string, text: string): string[] {
  const found: string[] = [];

  text.split("\n").forEach((line, i) => {
    const hit = POINTER.exec(line) ?? BARE_POINTER.exec(line);
    if (hit) found.push(`${path}:${i + 1} — ${hit[0]}`);
  });

  return found;
}

/**
 * Both forms, assembled rather than written out. A literal example would be a
 * real offence, because this file is inside the scan below.
 */
const EXAMPLE_POINTER = "src/supervise/" + "index.ts" + ":" + "440";
const EXAMPLE_BARE = "`" + ":" + "1148" + "`";

/** The fixture's own name, assembled for the same reason as the examples. */
const FIXTURE = "f" + ".ts";

test("the scan reports what it finds, so a clean repo is not a vacuous pass", () => {
  // 🛑 THROUGH `pointersIn`, NOT THE REGEX. Testing the regex alone leaves the
  // line that RECORDS a hit unexercised whenever the repo is clean — gutting
  // it left the whole suite green and the failure set identical. claude1's
  // finding.
  assert.deepEqual(
    pointersIn(FIXTURE, `ok\nsee ${EXAMPLE_POINTER} there\nok`),
    [`${FIXTURE}:2 — ${EXAMPLE_POINTER}`],
    "a pointer on line 2 must be reported, with its line and its text",
  );
  assert.deepEqual(pointersIn(FIXTURE, `and ${EXAMPLE_BARE} too`), [
    `${FIXTURE}:1 — ${EXAMPLE_BARE}`,
  ]);
  assert.deepEqual(
    pointersIn(FIXTURE, "src/supervise/index.ts and TurnQueue.offer"),
    [],
    "a bare path and a symbol are not pointers",
  );
});

test("no committable file outside the allowlist carries a line-number pointer", () => {
  const files = textFiles();
  const scanned = files.filter((p) => !allowedReason(p));

  // 🛑 MEMBERSHIP, NOT A FLOOR. A count threshold cannot see ONE absence, and
  // the absence it still catches is an `ALLOWED` prefix growing to cover this
  // file — `prefix: "test/stale-"` exempts the scanner from its own scan while
  // `scanned.length` stays over 200. Proven by mutation, claude1 on PR 313.
  assert.ok(
    scanned.includes("test/stale-line-pointers.test.ts"),
    "this file is not in its own scan — commit it before trusting a pass",
  );
  assert.ok(
    scanned.length > 200,
    `only ${scanned.length} files reached the check`,
  );

  const offences = scanned.flatMap((path) =>
    pointersIn(path, readFileSync(join(ROOT, path), "utf8")),
  );

  assert.deepEqual(
    offences,
    [],
    `name the symbol instead of the line. ${offences.length} pointer(s):\n` +
      offences.join("\n"),
  );
});

test("every allowlist entry still matches at least one real path", () => {
  const files = textFiles();

  for (const { prefix, why } of ALLOWED) {
    assert.ok(
      files.some((p) => p.startsWith(prefix)),
      `"${prefix}" matches nothing — drop the entry rather than leave a carve-out ` +
        `for a path that no longer exists. Reason on file: ${why}`,
    );
  }
});
