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
 * 🛑 TEST INFRASTRUCTURE. Never import it from `src/`.
 */
import { execFileSync } from "node:child_process";

const REPO_ROOT = new URL("../../", import.meta.url).pathname;

type Options = {
  /** One path to limit the listing to, as `git ls-files -- <pathspec>` does. */
  pathspec?: string;
  /** Which tree to list. Defaults to this repo; the tests pass a fixture. */
  cwd?: string;
};

export function committableFiles(options: Options = {}): string[] {
  const { pathspec, cwd = REPO_ROOT } = options;

  const args = ["ls-files", "--cached", "--others", "--exclude-standard"];
  if (pathspec !== undefined) args.push("--", pathspec);

  return execFileSync("git", args, { cwd, encoding: "utf8" })
    .split("\n")
    .filter((p) => p.length > 0);
}
