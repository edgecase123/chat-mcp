import { realpath as fsRealpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * 🛑 THIS RUNS BEHIND AN HTTP ENDPOINT, WHICH THE Ink CLI's COPY DOES NOT.
 *
 * `src/cli/ink/input/completions.ts` does the same job inside the operator's
 * own terminal process, where reaching anywhere on the disk is a convenience.
 * Served over HTTP it would be a directory-listing API, so this copy refuses
 * absolute paths and refuses to escape its root. The duplication is deliberate;
 * sharing one implementation would give one of the two surfaces the wrong
 * reach.
 */

/** Directories first, then alphabetical, capped so one reply stays small. */
export const HINT_LIMIT = 30;

export interface HintQuery {
  /** Absolute directory to list. LEXICAL — see realContainedDir. */
  dirAbs: string;
  /** The root `dirAbs` must stay inside, so the caller need not re-derive it. */
  root: string;
  /** Filter entries by this case-insensitive prefix. */
  prefix: string;
  /** What to put back in front of a chosen name, preserving `~/` vs relative. */
  rebuild: string;
}

export interface HintRoots {
  /** The project folder. A relative token resolves against this. */
  cwd: string;
  /** `~/` expands to this, and a `~` token may not escape it. */
  home: string;
}

/**
 * Turns the text after `@` into a directory to list, or null to refuse.
 *
 * Refuses an absolute token, and refuses any token that resolves outside the
 * root it started from. `@../../../etc/` is the case that matters: without the
 * containment test it lists the filesystem.
 */
export function resolveHintQuery(token: string, { cwd, home }: HintRoots): HintQuery | null {
  if (token.includes('\0')) return null;
  // An absolute token has no root to be contained by.
  //
  // ⚠️ NOT REDUNDANT WITH THE CONTAINMENT TEST BELOW. Each guard covers a case
  // the other does not: on win32 `C:\Windows\` does not start with `/` and
  // only containment refuses it, and containment on its own has the symlink
  // hole realContainedDir closes. Measured: removing EITHER alone leaves the
  // absolute tests green, so no single mutant turns them red.
  if (token.startsWith('/')) return null;

  const tilde = token === '~' || token.startsWith('~/');
  const root = tilde ? home : cwd;
  const body = tilde ? token.slice(1).replace(/^\//, '') : token;

  const lastSlash = body.lastIndexOf('/');
  const dirPart = lastSlash >= 0 ? body.slice(0, lastSlash + 1) : '';
  const prefix = lastSlash >= 0 ? body.slice(lastSlash + 1) : body;

  const dirAbs = path.resolve(root, dirPart || '.');
  if (!isInside(dirAbs, root)) return null;

  return { dirAbs, root, prefix, rebuild: tilde ? `~/${dirPart}` : dirPart };
}

/**
 * 🛑 THE LEXICAL CONTAINMENT ABOVE IS NOT ENOUGH ON ITS OWN.
 *
 * `path.resolve` and `isInside` are both string work, so a symlink inside the
 * root points anywhere and still reads as textually inside — and `readdir`
 * follows it. `@esc/etc/` listed `/etc` over HTTP, where `esc` was any symlink
 * to `/` in the root. Found by claude1.
 *
 * Same hole and same fix as `src/supervise/allowlist.ts`, which resolves both
 * sides before comparing. The root is resolved too: on macOS `tmpdir()` is
 * itself a symlink, so comparing a real path against a lexical root refuses
 * paths that are genuinely inside.
 *
 * Returns the real directory to list, or null to refuse. A path that does not
 * exist yet is the normal case while typing, and refuses rather than throwing.
 */
export async function realContainedDir(
  query: HintQuery,
  realpath: (p: string) => Promise<string> = fsRealpath,
): Promise<string | null> {
  let dir: string;
  let root: string;
  try {
    dir = await realpath(query.dirAbs);
    root = await realpath(query.root);
  } catch {
    return null;
  }

  return isInside(dir, root) ? dir : null;
}

/** True when `child` is `root` itself or sits under it. */
export function isInside(child: string, root: string): boolean {
  const rel = path.relative(root, child);

  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The home directory, as a separate export so a test can inject its own. */
export function defaultRoots(): HintRoots {
  return { cwd: process.cwd(), home: os.homedir() };
}

export interface HintEntry {
  /** What replaces the `@token`, including the leading `@`. */
  value: string;
  kind: 'dir' | 'file';
}

/**
 * Shapes a directory listing into hints. Takes the entries rather than reading
 * them, so the ordering, the dotfile rule and the cap are testable with no
 * filesystem.
 */
export function buildHints(
  entries: { name: string; isDirectory: boolean }[],
  { prefix, rebuild }: Pick<HintQuery, 'prefix' | 'rebuild'>,
): HintEntry[] {
  const lower = prefix.toLowerCase();

  return entries
    .filter((e) => e.name.toLowerCase().startsWith(lower))
    // Hidden unless the prefix opens with a dot, so `@` is not a wall of dotfiles.
    .filter((e) => !e.name.startsWith('.') || prefix.startsWith('.'))
    .sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;

      return a.name.localeCompare(b.name);
    })
    .slice(0, HINT_LIMIT)
    .map((e) => ({
      value: `@${rebuild}${e.name}${e.isDirectory ? '/' : ''}`,
      kind: e.isDirectory ? ('dir' as const) : ('file' as const),
    }));
}
