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
 * ⚠️ IT FAILS SAFE AND NO TEST COVERS THAT, BECAUSE NOTHING CAN REACH IT.
 * An include-less or unparseable `tsconfig.json` falls back to the whole tree.
 * Every way of producing one also makes git call `tsconfig.json` modified —
 * even `chmod 000`, since git reports a file it cannot hash as changed — and
 * `tsconfig.json` is itself a build input. So the fallback cannot change the
 * answer, and a test asserting it was green against a fallback failing OPEN.
 */
const ALWAYS = ["package.json", "package-lock.json", "tsconfig.json"];

function buildInputs() {
  try {
    const include = JSON.parse(
      readFileSync(join(repo, "tsconfig.json"), "utf8"),
    ).include;

    if (!Array.isArray(include) || include.length === 0) return [];

    // "src/**/*" is the whole `src` tree to git, which takes paths not globs.
    const roots = new Set(
      include.map((glob) => String(glob).split("/")[0]).filter(Boolean),
    );

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
