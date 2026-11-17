import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 🛑 A SHA THAT DOES NOT RESOLVE IS IGNORED SILENTLY. `git blame
 * --ignore-revs-file` holding a bogus 40-hex string exits 0 and prints the
 * unmodified blame, so a typo here reads exactly like a working entry.
 *
 * Measured: a file holding `deadbeef...` blames `package.json` normally, rc 0,
 * no warning on stderr.
 */

const ROOT = join(import.meta.dirname, "..");
const FILE = join(ROOT, ".git-blame-ignore-revs");

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/** The shas, with comments and blanks dropped. */
function listedRevs(): string[] {
  return readFileSync(FILE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

test("the file lists at least one rev", () => {
  const revs = listedRevs();
  assert.ok(
    revs.length > 0,
    `${FILE} has no revs — an empty file ignores nothing and still exits 0`,
  );
});

test("every listed rev is a full 40-hex sha", () => {
  for (const rev of listedRevs()) {
    assert.match(
      rev,
      /^[0-9a-f]{40}$/,
      `"${rev}" is not a full sha. An abbreviation resolves for the author and ` +
        `can go ambiguous as the repo grows.`,
    );
  }
});

test("every listed rev resolves to a commit reachable from HEAD", () => {
  const revs = listedRevs();
  for (const rev of revs) {
    const type = git("cat-file", "-t", rev);
    assert.equal(type, "commit", `${rev} is a ${type}, not a commit`);

    // `--is-ancestor` exits 1 for "no", which execFileSync throws on.
    let reachable = true;
    try {
      git("merge-base", "--is-ancestor", rev, "HEAD");
    } catch {
      reachable = false;
    }
    assert.ok(
      reachable,
      `${rev} is not an ancestor of HEAD, so blame never walks through it and ` +
        `the entry is dead weight.`,
    );
  }
  assert.equal(
    revs.length,
    1,
    "one rev expected; update this count deliberately",
  );
});

test("the listed reformat really did move the lines it claims", () => {
  const [rev] = listedRevs();
  const stat = git("show", "--shortstat", "--format=", rev);

  const files = Number(/(\d+) files? changed/.exec(stat)?.[1] ?? 0);
  const moved =
    Number(/(\d+) insertions?/.exec(stat)?.[1] ?? 0) +
    Number(/(\d+) deletions?/.exec(stat)?.[1] ?? 0);

  // The denominator, so a regex that stopped matching cannot read as a pass.
  assert.ok(files > 0 && moved > 0, `parsed nothing out of: ${stat}`);
  assert.ok(
    files >= 300,
    `${rev} touched ${files} files. A repo-wide reformat is the only thing ` +
      `that belongs here; a small diff means the wrong sha was pasted.`,
  );
  assert.ok(
    moved >= 30_000,
    `${rev} moved ${moved} lines, too few for a reformat`,
  );
});

test("blame with the file skips the reformat on a line it rewrote", () => {
  // `.prettierignore` is NOT in the reformat, so it is the control: its blame
  // must be identical with and without the ignore file.
  const control = (ignore: boolean) =>
    git(
      "blame",
      ...(ignore ? [`--ignore-revs-file=${FILE}`] : []),
      "-L",
      "1,1",
      "--",
      ".prettierignore",
    ).slice(0, 8);

  assert.equal(
    control(true),
    control(false),
    "a file the reformat never touched must blame the same either way",
  );

  // A line the reformat DID rewrite must name something else once ignored.
  const reformatted = (ignore: boolean) =>
    git(
      "blame",
      ...(ignore ? [`--ignore-revs-file=${FILE}`] : []),
      "-L",
      "1,1",
      "--",
      "src/supervise/drivers/claude.ts",
    ).slice(0, 8);

  assert.notEqual(
    reformatted(true),
    reformatted(false),
    "the ignore file changed nothing on a reformatted line — it is not taking effect",
  );
});
