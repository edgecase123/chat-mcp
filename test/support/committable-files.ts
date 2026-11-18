/**
 * Every file a commit from this tree would carry — the index PLUS new files
 * the author has not staged yet.
 *
 * #312. Four self-check guards enumerated their subject with `git ls-files`,
 * which lists the index alone. Those guards exist to catch NEW code, and new
 * code is the one thing a bare `ls-files` cannot see: PR 311 ran a full suite
 * with an offending test file unstaged, reported EXIT 0, and went red the
 * moment `git add` made the file visible. No code changed between the runs.
 *
 * 🛑 `--exclude-standard` IS LOAD-BEARING, NOT TIDINESS. Without it the
 * listing carries `node_modules/` and `dist/`, so a scan would report files no
 * commit can contain. Pinned by `an ignored file is never listed` below.
 *
 * 🛑 READABLE REGULAR FILES ONLY. `--others` offers a symlinked
 * `node_modules`, a broken link and a staged-then-deleted path, and a guard
 * that THROWS on one reads as a broken suite. Pinned by `every listed path can
 * actually be READ` below.
 *
 * 🛑 TEST INFRASTRUCTURE. Never import it from `src/`.
 */
import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// `URL.pathname` stays percent-encoded, so a checkout under a path with a
// space resolves to `%20` and every `cwd` here is wrong. claude1, PR 313.
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

type Options = {
  /** One path to limit the listing to, as `git ls-files -- <pathspec>` does. */
  pathspec?: string;
  /** Which tree to list. Defaults to this repo; the tests pass a fixture. */
  cwd?: string;
};

/**
 * Whether a scanner can read this entry's text.
 *
 * 🛑 `statSync` FOLLOWS THE LINK, ON PURPOSE. A link resolving to a file holds
 * real committable text; one resolving to a directory throws EISDIR. Dropping
 * every symlink would hide the first to fix the second.
 */
function isReadableFile(cwd: string, rel: string): boolean {
  try {
    return statSync(join(cwd, rel)).isFile();
  } catch {
    // A broken link, or a path staged and then deleted. Both are listed.
    return false;
  }
}

export function committableFiles(options: Options = {}): string[] {
  const { pathspec, cwd = REPO_ROOT } = options;

  const args = ["ls-files", "--cached", "--others", "--exclude-standard"];
  if (pathspec !== undefined) args.push("--", pathspec);

  return execFileSync("git", args, { cwd, encoding: "utf8" })
    .split("\n")
    .filter((p) => p.length > 0)
    .filter((p) => isReadableFile(cwd, p));
}
