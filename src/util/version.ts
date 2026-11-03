import { readFileSync } from 'node:fs';

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
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');

    return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0-unknown';
  } catch {
    return '0.0.0-unknown';
  }
}
