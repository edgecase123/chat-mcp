import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 🛑 A `file.ts:NNN` POINTER IN PROSE FAILS SILENTLY. The Prettier adoption
 * moved 37,669 lines, so a pointer written before it lands on unrelated code
 * and still reads as verified. 34 of them were stale at once.
 *
 * Name the SYMBOL instead. A symbol survives a reflow and a rename shows up as
 * a grep miss; a line number survives neither and says nothing when it breaks.
 */

const ROOT = join(import.meta.dirname, "..");

/** `path/to/file.ext:123`, and the bare `` `:123` `` continuation form. */
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

/** Every tracked text file, so the scan has a denominator. */
function textFiles(): string[] {
  const out = execFileSync("git", ["ls-files"], {
    cwd: ROOT,
    encoding: "utf8",
  });

  return out
    .split("\n")
    .filter((p) => p.length > 0)
    .filter((p) => !/\.(png|jpg|jpeg|gif|ico|woff2?|ttf|zip|pdf)$/i.test(p))
    .filter((p) => p !== "package-lock.json");
}

test("the detector catches a pointer, so a clean scan is not vacuous", () => {
  // Assembled, never written out, so this file stays inside its own scan.
  const bad = "src/supervise/" + "index.ts" + ":" + "440";
  const bareBad = "`" + ":" + "1148" + "`";

  assert.match(bad, POINTER, "the pointer regex cannot see a pointer");
  assert.match(bareBad, BARE_POINTER, "the bare-pointer regex cannot see one");
  assert.doesNotMatch(
    "src/supervise/index.ts",
    POINTER,
    "a bare path is not a pointer",
  );
  assert.doesNotMatch("TurnQueue.offer", POINTER, "a symbol is not a pointer");
});

test("no tracked file outside the allowlist carries a `file.ext:NNN` pointer", () => {
  const files = textFiles();
  assert.ok(
    files.length > 200,
    `only ${files.length} files scanned — the listing broke`,
  );

  const offences: string[] = [];
  let scanned = 0;

  for (const path of files) {
    if (allowedReason(path)) continue;
    scanned += 1;
    const lines = readFileSync(join(ROOT, path), "utf8").split("\n");
    lines.forEach((line, i) => {
      const hit = POINTER.exec(line) ?? BARE_POINTER.exec(line);
      if (hit) offences.push(`${path}:${i + 1} — ${hit[0]}`);
    });
  }

  assert.ok(scanned > 200, `only ${scanned} files reached the pointer check`);
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
