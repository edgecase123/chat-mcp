import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildCommit, parseBuildCommit } from "../../src/util/version.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const STAMPER = join(REPO, "scripts", "stamp-build.mjs");

/** The revision git itself reports, so the stamp is compared to a second source. */
function headCommit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO,
    encoding: "utf8",
  }).trim();
}

test("the stamper writes the commit git reports for this tree", () => {
  const out = mkdtempSync(join(tmpdir(), "chat-mcp-stamp-"));
  const file = join(out, "build-info.json");

  try {
    execFileSync("node", [STAMPER, file], { cwd: REPO, encoding: "utf8" });

    assert.ok(existsSync(file), `${file} was not written`);
    const written = JSON.parse(readFileSync(file, "utf8")) as {
      commit?: string;
    };

    assert.equal(written.commit, headCommit());
    assert.match(written.commit ?? "", /^[0-9a-f]{40}$/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

/** A throwaway repo with one commit, so a dirty case can be MADE not waited for. */
function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "chat-mcp-repo-"));
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  run("init", "-q");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "t");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ include: ["src/**/*"] }, null, 2) + "\n",
  );
  run("add", "-A");
  run("commit", "-qm", "one");

  return dir;
}

/** Stamp `repo` into a temp file and hand back what was written. */
function stamp(repo: string): { commit?: string; dirty?: unknown } {
  const file = join(mkdtempSync(join(tmpdir(), "chat-mcp-out-")), "info.json");
  execFileSync("node", [STAMPER, file, repo], { cwd: REPO, encoding: "utf8" });

  return JSON.parse(readFileSync(file, "utf8")) as {
    commit?: string;
    dirty?: unknown;
  };
}

/**
 * 🛑 THE CLEAN CASE IS THE ONE A MUTANT SURVIVES. `dirty` hardcoded false is
 * green in any clean checkout, which is what CI always has — and a control run
 * by EDITING this tree can never show it, because the edit dirties the tree.
 * So the test makes both trees itself.
 */
test("the stamper reports a clean build as clean", () => {
  const repo = scratchRepo();

  try {
    assert.equal(stamp(repo).dirty, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the stamper reports an edited build input as dirty", () => {
  const repo = scratchRepo();

  try {
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
    assert.equal(stamp(repo).dirty, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/**
 * 🛑 AN UNTRACKED FILE UNDER `src/` SHIPS IN `dist/` AND IS NOT IN THE COMMIT.
 * `tsconfig.json` includes `src/**` by existence, not by git tracking, so
 * `--untracked-files=no` would call this build clean. It is not.
 */
test("the stamper reports an untracked module under src as dirty", () => {
  const repo = scratchRepo();

  try {
    writeFileSync(join(repo, "src", "sneaked.ts"), "export const b = 2;\n");
    assert.equal(stamp(repo).dirty, true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/**
 * ⚠️ THE FALSE POSITIVE claude1 MEASURED ON PR 383. A stray note cannot reach
 * `dist/`, so flagging it would train an operator to ignore the flag.
 */
test("the stamper ignores an untracked file that cannot reach the build", () => {
  const repo = scratchRepo();

  try {
    writeFileSync(join(repo, "notes.md"), "scratch\n");
    assert.equal(stamp(repo).dirty, false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the build script runs the stamper, so a build cannot forget it", () => {
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  assert.match(pkg.scripts.build ?? "", /stamp-build\.mjs/);
});

test("parseBuildCommit answers null for every shape that is not a commit", () => {
  const rejected = [
    "",
    "not json",
    "{}",
    '{"commit":null}',
    '{"commit":""}',
    '{"commit":"HEAD"}',
    '{"commit":"deadbeef"}',
    '{"commit":"' + "g".repeat(40) + '"}',
    "[]",
  ];

  for (const raw of rejected) {
    assert.equal(
      parseBuildCommit(raw),
      null,
      `accepted ${JSON.stringify(raw)}`,
    );
  }

  assert.equal(rejected.length, 9, "the denominator moved; re-read the list");
});

test("parseBuildCommit answers the commit for a well formed stamp", () => {
  const sha = "a".repeat(40);

  assert.equal(parseBuildCommit(`{"commit":"${sha}"}`), sha);
});

/**
 * 🛑 THIS IS THE RUNNING-FROM-SOURCE CASE, AND IT MUST NOT GUESS.
 * Under tsx the stamp sits beside `dist/`, never beside `src/`, so a build
 * that was never run has to report nothing rather than the tree's HEAD.
 *
 * ⚠️ IT IS PAIRED WITH THE TEST BELOW ON PURPOSE. Null alone is reachable by a
 * reader that is simply broken, so a control that breaks the reader leaves this
 * one green. The pair is what discriminates.
 */
test("buildCommit answers null when no stamp sits beside this module", () => {
  assert.equal(buildCommit(), null);
});

test("buildCommit reads the stamp that is actually beside it", () => {
  const out = mkdtempSync(join(tmpdir(), "chat-mcp-read-"));
  const dir = join(out, "util");
  mkdirSync(dir);

  try {
    execFileSync("node", [STAMPER, join(out, "build-info.json")], {
      cwd: REPO,
      encoding: "utf8",
    });

    assert.equal(
      buildCommit(pathToFileURL(join(dir, "version.js")).href),
      headCommit(),
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

/**
 * 🛑 THE TREE IS NOT THE BUILD. A pulled-but-not-rebuilt clone has a current
 * HEAD and stale code, and reporting HEAD there is the wrong answer this
 * function exists to avoid.
 */
test("buildCommit ignores the tree's HEAD when no stamp was written", () => {
  assert.notEqual(buildCommit(), headCommit());
});

/**
 * 🛑 THE DRIFT claude1 FLAGGED ON PR 383. A hand-written path list stops
 * counting a source root the day one is added, and nothing says so.
 */
test("a source root added to tsconfig starts counting toward dirty", () => {
  const repo = scratchRepo();

  try {
    writeFileSync(
      join(repo, "tsconfig.json"),
      JSON.stringify({ include: ["src/**/*", "lib/**/*"] }, null, 2) + "\n",
    );
    execFileSync("git", ["add", "-A"], { cwd: repo, encoding: "utf8" });
    execFileSync("git", ["commit", "-qm", "two"], {
      cwd: repo,
      encoding: "utf8",
    });

    assert.equal(stamp(repo).dirty, false, "the new root is not dirty yet");

    mkdirSync(join(repo, "lib"));
    writeFileSync(join(repo, "lib", "c.ts"), "export const c = 3;\n");

    assert.equal(
      stamp(repo).dirty,
      true,
      "a file under the new root was ignored",
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
