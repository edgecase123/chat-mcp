#!/usr/bin/env node
// Record the commit this build came from, so a running shim can report it.
// Written after `tsc`, beside `dist/`, so running from `src/` finds nothing.
// Argv: [outPath] [repoDir] — both exist so a test can stamp a tree it made.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] ?? join(SELF, "dist", "build-info.json");
const repo = process.argv[3] ?? SELF;

/**
 * 🛑 SCOPED TO WHAT `tsc` COMPILES, AND UNTRACKED FILES COUNT.
 * `tsconfig.json` includes `src/**` by whether the file EXISTS, not by whether
 * git tracks it, so an untracked module under `src/` ships in `dist/` and is
 * absent from the commit. `--untracked-files=no` would call that build clean.
 * Paths outside this list cannot reach `dist/`, so a stray note does not count.
 */
const BUILD_INPUTS = [
  "src",
  "tsconfig.json",
  "package.json",
  "package-lock.json",
];

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
  dirty = git(["status", "--porcelain", "--", ...BUILD_INPUTS]).length > 0;
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
