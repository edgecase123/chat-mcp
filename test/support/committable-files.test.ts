import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { committableFiles } from "./committable-files.js";

/**
 * A throwaway repo rather than this one, so the cases can be STAGED and
 * UNSTAGED on purpose. Probing the real tree would mean writing files into it
 * while the parallel suite's own scanners are reading it.
 */
function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "committable-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });

  git("init", "-q");
  // A commit is refused outright on a host with no global identity.
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "committable-files fixture");

  writeFileSync(join(dir, ".gitignore"), "ignored/\n");
  writeFileSync(join(dir, "tracked.ts"), "export const a = 1;\n");
  git("add", ".gitignore", "tracked.ts");
  git("commit", "-q", "-m", "first");

  writeFileSync(join(dir, "unstaged.ts"), "export const b = 2;\n");
  mkdirSync(join(dir, "ignored"));
  writeFileSync(join(dir, "ignored", "junk.ts"), "junk\n");
  mkdirSync(join(dir, "sub"));
  writeFileSync(join(dir, "sub", "deep.ts"), "export const c = 3;\n");

  return dir;
}

function withFixture(body: (dir: string) => void): void {
  const dir = fixtureRepo();
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("🛑 an UNSTAGED file is listed, which is the whole of #312", () => {
  withFixture((dir) => {
    // The paired control FIRST: the command this replaced, same fixture, same
    // moment. Without it, "the helper lists unstaged.ts" says nothing about
    // whether the instrument changed the answer.
    const indexOnly = execFileSync("git", ["ls-files"], {
      cwd: dir,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);

    assert.deepEqual(
      indexOnly.includes("unstaged.ts"),
      false,
      "`git ls-files` already saw the unstaged file, so the fixture is wrong",
    );

    assert.ok(
      committableFiles({ cwd: dir }).includes("unstaged.ts"),
      "an unstaged file is invisible to the guards again",
    );
  });
});

test("🛑 an IGNORED file is never listed, so a guard cannot report what no commit carries", () => {
  withFixture((dir) => {
    const files = committableFiles({ cwd: dir });

    assert.ok(
      files.includes("tracked.ts"),
      `the listing is empty or broken: ${files.join(", ")}`,
    );
    assert.equal(
      files.includes("ignored/junk.ts"),
      false,
      "`--exclude-standard` is gone; the listing now carries node_modules too",
    );
  });
});

test("a pathspec narrows the listing, and still reaches an unstaged file inside it", () => {
  withFixture((dir) => {
    assert.deepEqual(committableFiles({ cwd: dir, pathspec: "sub" }), [
      "sub/deep.ts",
    ]);

    mkdirSync(join(dir, "sub", "nested"));
    writeFileSync(
      join(dir, "sub", "nested", "new.ts"),
      "export const d = 4;\n",
    );

    assert.deepEqual(committableFiles({ cwd: dir, pathspec: "sub" }), [
      "sub/deep.ts",
      "sub/nested/new.ts",
    ]);
  });
});

test("the default listing reads THIS repo, with a denominator", () => {
  const files = committableFiles();

  // 🛑 A FLOOR, BECAUSE THE SUBJECT IS "the invocation still works here". A
  // wrong cwd or a renamed flag returns an empty list, which every membership
  // assertion in the four guards would pass.
  assert.ok(
    files.length > 200,
    `only ${files.length} files listed — the invocation or the cwd broke`,
  );
  assert.ok(
    files.includes("test/support/committable-files.ts"),
    "the helper cannot see itself, so the paths are not repo-relative",
  );
});
