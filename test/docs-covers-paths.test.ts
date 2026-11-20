import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { committableFiles } from "./support/committable-files.js";

/**
 * 🛑 A `covers:` ENTRY NAMING A DELETED FILE FAILS SILENTLY. `docs/system`'s
 * own README says every page lists the source files it describes, so that list
 * is the first thing a reader uses to find the code behind a page. A rename or
 * a delete leaves the pointer behind and nothing notices.
 *
 * #329 did it twice. Deleting `src/supervise/broker.ts` left it listed in
 * `settings.md` and in `project-commands.md`; both were `covers:` entries, and
 * the second survived one PR because the fix was memory rather than a check.
 */

const ROOT = join(import.meta.dirname, "..");

/**
 * Pages whose `covers:` entries are not expected to resolve.
 *
 * 🛑 THE TEMPLATE'S PLACEHOLDERS ARE THE POINT. `_template.md` names
 * `src/path/to/...` so an author can see the shape; making those resolve would
 * mean inventing files to satisfy a test.
 *
 * `docs/superpowers/**` needs no entry here — it is outside this scan by
 * construction, and that is deliberate. lee ruled on 2026-11-19 that those
 * pages stay as written, so a plan naming a since-deleted file is correct
 * history rather than a stale pointer.
 */
const EXEMPT: readonly { page: string; why: string }[] = [
  {
    page: "docs/system/_template.md",
    why: "its `covers:` entries are placeholders showing an author the shape",
  },
];

function exemptReason(page: string): string | null {
  return EXEMPT.find((e) => e.page === page)?.why ?? null;
}

/** Every `docs/system` page a commit would carry. */
function systemPages(): string[] {
  return committableFiles({ pathspec: "docs/system" }).filter((p) =>
    p.endsWith(".md"),
  );
}

/**
 * The `covers:` entries in a page's YAML front matter, or `null` when the page
 * has no front matter at all.
 *
 * `null` and `[]` are different answers and the caller needs both: an index
 * page legitimately carries neither, while a page with front matter and no
 * `covers:` key has dropped its pointers.
 */
function coversIn(text: string): string[] | null {
  const frontMatter = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (frontMatter === null) return null;

  const block = /^covers:[ \t]*\n((?:[ \t]+-[ \t]*\S.*\n?)+)/m.exec(
    frontMatter[1],
  );
  if (block === null) return [];

  return block[1]
    .split("\n")
    .map((line) => line.trim().replace(/^-[ \t]*/, ""))
    .filter((entry) => entry.length > 0);
}

/**
 * Every path a commit would carry, plus every directory prefix of one.
 *
 * 🛑 A `covers:` ENTRY MAY NAME A DIRECTORY. `terminal-ui.md` lists
 * `src/oneshot`, which `git ls-files` never returns on its own. Checking file
 * membership alone would report a live directory as dangling, and the obvious
 * repair — dropping directory entries from the scan — hides every pointer
 * inside one.
 */
function resolvablePaths(): Set<string> {
  const paths = new Set<string>();

  for (const file of committableFiles()) {
    paths.add(file);

    const parts = file.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      paths.add(parts.slice(0, i).join("/"));
    }
  }

  return paths;
}

test("the parser reports what a page covers, so a clean tree is not a vacuous pass", () => {
  // 🛑 THE EXTENSION ALTERNATION IS WHERE THIS GOES WRONG, SO IT IS TESTED
  // FIRST. #341 was filed off a finding that turned out to be a scanner bug:
  // a pattern ending `\.ts` truncates `App.tsx` to a path that does not exist,
  // and its mirror `\.ts\b` cannot see `App.tsx` at all. Parsing the structured
  // `covers:` list avoids guessing at extensions entirely — these cases pin
  // that there is no extension matching left to get wrong.
  assert.deepEqual(
    coversIn(
      "---\ntitle: T\ncovers:\n  - src/cli/ink/App.tsx\n  - src/oneshot\n---\n# T\n",
    ),
    ["src/cli/ink/App.tsx", "src/oneshot"],
    "a .tsx path and a bare directory must both survive the parse intact",
  );
  assert.deepEqual(
    coversIn("---\ntitle: T\nupdated: 2026-01-01\n---\n# T\n"),
    [],
    "front matter without a covers: key has no entries",
  );
  assert.equal(
    coversIn("# T\n\ncovers: src/nope.ts\n"),
    null,
    "a page with no front matter is not a page with empty front matter",
  );
});

test("the resolver distinguishes a live path from the one that motivated this guard", () => {
  const resolvable = resolvablePaths();

  // CONTROL. `App.tsx` exists and `App.ts` never did. A resolver that reports
  // the first as missing, or the second as present, is the bug #341 records
  // rather than a finding.
  assert.ok(
    resolvable.has("src/cli/ink/App.tsx"),
    "src/cli/ink/App.tsx is tracked — a resolver that cannot see it is broken",
  );
  assert.ok(
    !resolvable.has("src/cli/ink/App.ts"),
    "src/cli/ink/App.ts has never existed — a resolver that finds it is broken",
  );

  // CONTROL. A directory entry must resolve, and a path under no tracked file
  // must not.
  assert.ok(
    resolvable.has("src/oneshot"),
    "src/oneshot is a tracked directory",
  );
  assert.ok(
    !resolvable.has("src/supervise/broker.ts"),
    "broker.ts was deleted in #329 — this is the exact pointer that went stale",
  );
});

test("every covers: entry on a docs/system page names a path that exists", () => {
  const pages = systemPages();
  const scanned = pages.filter((p) => exemptReason(p) === null);
  const resolvable = resolvablePaths();

  const dangling: string[] = [];
  let entries = 0;
  let withoutFrontMatter = 0;

  for (const page of scanned) {
    const covers = coversIn(readFileSync(join(ROOT, page), "utf8"));

    if (covers === null) {
      withoutFrontMatter += 1;
      continue;
    }

    for (const entry of covers) {
      entries += 1;
      if (!resolvable.has(entry)) dangling.push(`${page} — ${entry}`);
    }
  }

  // 🛑 THE DENOMINATOR, ASSERTED. A parse that silently matches nothing
  // reports zero dangling entries, which is indistinguishable from a clean
  // tree. These two floors are what tell the difference.
  assert.ok(
    scanned.length >= 14,
    `only ${scanned.length} docs/system pages reached the check`,
  );
  assert.ok(
    entries >= 50,
    `only ${entries} covers: entries were parsed from ${scanned.length} pages`,
  );

  assert.deepEqual(
    dangling,
    [],
    `a covers: entry names a path that does not exist. ` +
      `${dangling.length} of ${entries} entries, over ${scanned.length} pages ` +
      `(${withoutFrontMatter} page(s) carry no front matter and were skipped):\n` +
      dangling.join("\n"),
  );
});

test("every exemption still matches a real page", () => {
  const pages = systemPages();

  for (const { page, why } of EXEMPT) {
    assert.ok(
      pages.includes(page),
      `"${page}" matches nothing — drop the exemption rather than leave a ` +
        `carve-out for a page that no longer exists. Reason on file: ${why}`,
    );
  }
});
