import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

/**
 * A tree holding every entry `git ls-files` offers that `readFileSync` cannot
 * answer for. Separate from `fixtureRepo` so the tests above keep one subject.
 */
function unreadableRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "committable-unreadable-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir });

  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "committable-files fixture");

  writeFileSync(join(dir, "real.ts"), "export const a = 1;\n");
  git("add", "real.ts");
  git("commit", "-q", "-m", "first");

  // The review pattern this repo documents: a worktree borrowing the parent's
  // dependencies. `node_modules/` in .gitignore does not match a SYMLINK.
  mkdirSync(join(dir, "elsewhere"));
  symlinkSync(join(dir, "elsewhere"), join(dir, "node_modules"));

  symlinkSync(join(dir, "gone.ts"), join(dir, "broken-link.ts"));
  symlinkSync(join(dir, "real.ts"), join(dir, "link-to-file.ts"));

  writeFileSync(join(dir, "deleted.ts"), "export const b = 2;\n");
  git("add", "deleted.ts");
  unlinkSync(join(dir, "deleted.ts"));

  return dir;
}

function withUnreadable(body: (dir: string) => void): void {
  const dir = unreadableRepo();
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 🛑 THE LISTING IS WHAT A SCANNER CAN READ, NOT WHAT `ls-files` PRINTS.
 *
 * `--others` offers entries no `readFileSync` can answer for, and a guard that
 * THROWS is worse than one that reports: a crash in a scanner reads as a
 * broken suite and the next person blames their own delta. Found by claude1 on
 * PR 313, in a review worktree with `ln -s ../node_modules`.
 */
test("🛑 a symlinked node_modules is dropped, so a review worktree does not CRASH the guards", () => {
  withUnreadable((dir) => {
    // The control FIRST: git really does offer it, so the filter is the thing
    // doing the work. `.gitignore`'s `node_modules/` cannot match a symlink.
    const raw = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: dir, encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);

    assert.ok(
      raw.includes("node_modules"),
      `git stopped offering the symlink, so this test proves nothing: ${raw.join(", ")}`,
    );

    assert.equal(
      committableFiles({ cwd: dir }).includes("node_modules"),
      false,
      "a symlink to a directory is listed; readFileSync on it throws EISDIR",
    );
  });
});

test("🛑 every listed path can actually be READ — the denominator, not one case", () => {
  withUnreadable((dir) => {
    const files = committableFiles({ cwd: dir });

    assert.ok(files.length > 0, "the listing is empty, so nothing is proven");

    const unreadable = files.filter((rel) => {
      try {
        readFileSync(join(dir, rel), "utf8");

        return false;
      } catch {
        return true;
      }
    });

    assert.deepEqual(
      unreadable,
      [],
      `listed but unreadable: ${unreadable.join(", ")}`,
    );
  });
});

test("a broken symlink and a staged-then-deleted file are both dropped", () => {
  withUnreadable((dir) => {
    const files = committableFiles({ cwd: dir });

    assert.equal(files.includes("broken-link.ts"), false, "broken symlink");
    assert.equal(files.includes("deleted.ts"), false, "staged, then deleted");
  });
});

/**
 * ⚠️ NOT A BLANKET SYMLINK BAN. The subject is readability, so a link that
 * resolves to a file stays — dropping it would hide real committable text.
 */
test("a symlink to a FILE is still listed", () => {
  withUnreadable((dir) => {
    const files = committableFiles({ cwd: dir });

    assert.ok(
      files.includes("link-to-file.ts"),
      `a readable symlink was dropped: ${files.join(", ")}`,
    );
    assert.ok(files.includes("real.ts"), "the plain file went missing too");
  });
});

/**
 * 🛑 `URL.pathname` STAYS PERCENT-ENCODED, SO IT IS NOT A PATH. The helper
 * resolved its own default root that way, and a checkout under a path with a
 * space became `%20` — every `cwd` here would then be wrong. claude1, PR 313.
 *
 * ⚠️ THE DEFAULT ROOT ITSELF CANNOT BE EXERCISED without relocating this
 * checkout, so what is pinned is the decoding step the fix depends on.
 */
test("a file URL with a space decodes to a usable path, encoded it does not", () => {
  const dir = mkdtempSync(join(tmpdir(), "committable with space-"));
  try {
    const target = join(dir, "x.ts");
    const url = new URL(pathToFileURL(target).href);

    assert.ok(
      url.pathname.includes("%20"),
      `the fixture name lost its space, so this proves nothing: ${url.pathname}`,
    );
    assert.equal(fileURLToPath(url), target);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
