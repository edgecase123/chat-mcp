import { test } from "node:test";
import assert from "node:assert/strict";
import { oneLine } from "./source-text.js";

/**
 * 🛑 SEVERAL GUARDS NOW READ THROUGH THIS FUNCTION, so a mistake in it greens
 * them all at once. The truth table is pinned rather than described, same
 * reason as `topLevelYields` in `bind-before-spawn.test.ts`.
 */

test("oneLine: the pinned truth table", () => {
  const CASES: [string, string, string][] = [
    [
      "a wrapped statement rejoins",
      "if (a === null)\n  return { ok: false };",
      "if (a === null) return { ok: false };",
    ],
    [
      "indentation collapses to one space",
      "a(\n    b,\n    c,\n  );",
      "a( b, c, );",
    ],
    ["leading and trailing space goes", "  a;  ", "a;"],
    ["a tab is whitespace too", "a\tb", "a b"],
    ["an already-flat line is unchanged", "const x = 1;", "const x = 1;"],
    ["quotes are left exactly as they are", "a(\"b\", 'c')", "a(\"b\", 'c')"],
  ];

  for (const [name, input, want] of CASES)
    assert.equal(oneLine(input), want, name);
});

test("⚠️ control — oneLine is not an identity function", () => {
  // A no-op implementation would pass every "unchanged" row above.
  assert.notEqual(oneLine("a\n  b"), "a\n  b");
});
