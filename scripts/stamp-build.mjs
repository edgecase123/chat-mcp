#!/usr/bin/env node
// Record the commit this build came from, so a running shim can report it.
// Written after `tsc`, beside `dist/`, so running from `src/` finds nothing.
// Argv: [outPath] [repoDir] — both exist so a test can stamp a tree it made.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] ?? join(SELF, "dist", "build-info.json");
const repo = process.argv[3] ?? SELF;

/**
 * 🛑 DERIVED FROM `tsconfig.json`, NEVER TYPED. A hand-written path list is a
 * second copy of `include` that drifts the day a root is added, and the drift
 * is silent: a new source root would simply stop counting toward `dirty`.
 *
 * 🛑 UNTRACKED FILES COUNT, so `--untracked-files=no` is wrong here. `include`
 * matches by whether a file EXISTS, not by whether git tracks it, so an
 * untracked module under a source root ships in `dist/` and is absent from the
 * commit. Paths outside these roots cannot reach `dist/`, so a stray note does
 * not count.
 *
 * ⚠️ AN EMPTY ANSWER MEANS THE WHOLE TREE, AND IT IS REACHABLE. A `tsconfig`
 * with neither `include` nor `files` compiles its whole directory, and a root
 * that is itself a glob spans the tree too. Both are the right answer rather
 * than a fallback, and both have tests. An earlier comment here called the
 * empty case unreachable; a committed `files`-only tsconfig reaches it with
 * the tree clean, which is claude1's finding on PR 383.
 */
const ALWAYS = ["package.json", "package-lock.json", "tsconfig.json"];

function buildInputs() {
  try {
    const config = JSON.parse(
      readFileSync(join(repo, "tsconfig.json"), "utf8"),
    );
    const patterns = [
      ...(Array.isArray(config.include) ? config.include : []),
      ...(Array.isArray(config.files) ? config.files : []),
    ];

    // `tsc` compiles the whole containing directory when neither is given.
    if (patterns.length === 0) return [];

    const roots = new Set();

    for (const pattern of patterns) {
      // "./src/**/*" names the same root as "src/**/*"; git takes paths.
      const first = String(pattern).replace(/^\.\//, "").split("/")[0];

      // "**/*.ts" and "." genuinely span the tree, so narrowing would UNDER
      // report. Answering empty hands the whole tree to `git status`.
      if (!first || first === "." || first === ".." || first.includes("*")) {
        return [];
      }

      roots.add(first);
    }

    return [...roots, ...ALWAYS];
  } catch {
    return [];
  }
}

function git(args) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

// A shallow or exported tree has no commit to report. An unstamped build is a
// supported state, so this exits 0 and writes nothing rather than failing it.
let commit;
try {
  commit = git(["rev-parse", "HEAD"]);
} catch {
  console.warn("stamp-build: no git revision available; dist is unstamped");
  process.exit(0);
}

// A dirty build does not match the commit it names, so a comparison that saw
// only the commit would call it current while the code differs.
let dirty;
try {
  dirty = git(["status", "--porcelain", "--", ...buildInputs()]).length > 0;
} catch {
  dirty = true;
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  JSON.stringify(
    { commit, dirty, builtAt: new Date().toISOString() },
    null,
    2,
  ) + "\n",
);
