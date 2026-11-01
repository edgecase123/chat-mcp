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
  /** Absolute directory to list. */
  dirAbs: string;
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
  // ⚠️ REDUNDANT WITH THE CONTAINMENT TEST BELOW, AND KEPT ON PURPOSE.
  // path.resolve ignores the root when the tail is absolute, so isInside
  // already refuses these. Measured: removing EITHER guard alone leaves the
  // absolute tests green, and removing BOTH fails them. It stays because it
  // refuses at the cheapest point and says so in one line.
  if (token.startsWith('/')) return null;

  const tilde = token === '~' || token.startsWith('~/');
  const root = tilde ? home : cwd;
  const body = tilde ? token.slice(1).replace(/^\//, '') : token;

  const lastSlash = body.lastIndexOf('/');
  const dirPart = lastSlash >= 0 ? body.slice(0, lastSlash + 1) : '';
  const prefix = lastSlash >= 0 ? body.slice(lastSlash + 1) : body;

  const dirAbs = path.resolve(root, dirPart || '.');
  if (!isInside(dirAbs, root)) return null;

  return { dirAbs, prefix, rebuild: tilde ? `~/${dirPart}` : dirPart };
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
