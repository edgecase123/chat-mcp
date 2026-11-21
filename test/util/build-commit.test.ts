import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildCommit, parseBuildCommit } from "../../src/util/version.js";

const REPO = new URL("../../", import.meta.url).pathname;
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

/**
 * 🛑 A DIRTY TREE'S BUILD DOES NOT MATCH THE COMMIT IT NAMES. Without this a
 * comparison reads "current" for a clone whose running code differs from the
 * revision stamped on it.
 */
test("the stamper records whether the tree it built from was dirty", () => {
  const out = mkdtempSync(join(tmpdir(), "chat-mcp-dirty-"));
  const file = join(out, "build-info.json");

  try {
    execFileSync("node", [STAMPER, file], { cwd: REPO, encoding: "utf8" });
    const written = JSON.parse(readFileSync(file, "utf8")) as {
      dirty?: unknown;
    };

    assert.equal(typeof written.dirty, "boolean");

    const porcelain = execFileSync("git", ["status", "--porcelain"], {
      cwd: REPO,
      encoding: "utf8",
    }).trim();

    assert.equal(written.dirty, porcelain.length > 0);
  } finally {
    rmSync(out, { recursive: true, force: true });
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
