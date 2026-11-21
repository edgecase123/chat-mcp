import { readFileSync } from "node:fs";

/** The running build's version, read from `package.json`.
 *
 *  `../../package.json` resolves from both `src/util/version.ts` under tsx and
 *  `dist/util/version.js` after a build, because `src/` and `dist/` are each
 *  one level below the package root.
 *
 *  Rejected: hand-updating a const per surface. That is the arrangement that
 *  let four surfaces print three different numbers. */
export function packageVersion(): string {
  try {
    const raw = readFileSync(
      new URL("../../package.json", import.meta.url),
      "utf8",
    );

    return (JSON.parse(raw) as { version?: string }).version ?? "0.0.0-unknown";
  } catch {
    return "0.0.0-unknown";
  }
}

/** A full git object name, which is the only shape a stamp may carry. */
const COMMIT = /^[0-9a-f]{40}$/;

/**
 *  The commit out of a build stamp, or null for anything that is not one.
 *
 *  🛑 AN ABBREVIATED SHA IS REJECTED ON PURPOSE. A comparison against
 *  `origin/main` needs a name that resolves without a repository, and a
 *  7-character prefix does not.
 */
export function parseBuildCommit(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;

    const commit = (parsed as { commit?: unknown }).commit;

    return typeof commit === "string" && COMMIT.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

/**
 *  The commit this build was produced from, or null when it was never stamped.
 *
 *  🛑 IT REPORTS THE BUILD, NEVER THE TREE. Reading `.git/HEAD` would answer
 *  for a clone that was pulled and not rebuilt, which is the case AGENTS.md
 *  calls worse than a missing `dist/`. The stamp is written beside `dist/`, so
 *  running from `src/` under tsx finds nothing and says so.
 *
 *  ⚠️ `from` EXISTS SO A TEST CAN POINT AT A STAMP IT WROTE. A null answer is
 *  reachable by a missing file, an unreadable one and a malformed one alike,
 *  so asserting null alone cannot tell a working reader from a broken one.
 */
export function buildCommit(from: string = import.meta.url): string | null {
  try {
    return parseBuildCommit(
      readFileSync(new URL("../build-info.json", from), "utf8"),
    );
  } catch {
    return null;
  }
}
