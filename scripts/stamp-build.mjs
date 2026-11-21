#!/usr/bin/env node
// Record the commit this build came from, so a running shim can report it.
// Written after `tsc`, beside `dist/`, so running from `src/` finds nothing.
// Takes an output path for tests; defaults to dist/build-info.json.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = process.argv[2] ?? join(REPO, "dist", "build-info.json");

// A shallow or exported tree has no commit to report. An unstamped build is a
// supported state, so this exits 0 and writes nothing rather than failing it.
let commit;
try {
  commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: REPO,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
} catch {
  console.warn("stamp-build: no git revision available; dist is unstamped");
  process.exit(0);
}

// A dirty tree's build does not match the commit it names, so a comparison
// that saw only the commit would call it current while the code differs.
let dirty = false;
try {
  dirty =
    execFileSync("git", ["status", "--porcelain"], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim().length > 0;
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
