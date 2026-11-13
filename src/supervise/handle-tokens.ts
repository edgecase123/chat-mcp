import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { assertHandle } from '../util/naming.js';
import { chmodVerified, stateDir, writePrivateFileSync } from '../util/paths.js';

const TOKEN_BYTES = 32;

/** Pinned by `the stored file holds NO token, only its SHA-256`. */
const DIGEST = 'sha256';

const HEX_DIGEST = /^[0-9a-f]{64}$/;
const SUFFIX = '.json';
const DIR_MODE = 0o700;

interface TokenFile {
  digest: string;
}

/**
 * 🛑 ONE FILE PER HANDLE, AND THAT IS THE FIX FOR A MEASURED DATA LOSS. A
 * single shared JSON file made `mintToken` a read-modify-write with no lock:
 * four concurrent mints returned four tokens and the file kept three, so one
 * agent started holding a credential that authenticated as nobody. Separate
 * files cannot lose a sibling's write.
 *
 * Pinned by `🛑 CONCURRENT mints of DISTINCT handles all keep working`.
 */
export function handleTokensDir(): string {
  return join(stateDir(), 'tokens');
}

/**
 * 🛑 THE HANDLE BECOMES A FILENAME, SO IT IS VALIDATED — same reason as
 * `manifestPathFor`. It also closes a second data loss: `__proto__` assigned
 * into a `JSON.parse` object hit the inherited setter, so minting returned a
 * token and stored nothing.
 */
export function handleTokenPathFor(handle: string): string {
  assertHandle(handle);

  return join(handleTokensDir(), `${handle}${SUFFIX}`);
}

function digestOf(token: string): Buffer {
  return createHash(DIGEST).update(token, 'utf8').digest();
}

function ensureTokensDir(): string {
  const dir = handleTokensDir();

  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodVerified(dir, DIR_MODE);

  return dir;
}

/**
 * Mint `handle`'s bearer token, returning it ONCE. Only its digest is stored,
 * so nothing that reads the file afterwards can authenticate with it.
 *
 * Replaces any token the handle already had, which is what a container restart
 * needs — see `🛑 re-minting a handle INVALIDATES the token it had before`.
 *
 * Written to a temp name and renamed, so a concurrent reader sees either the
 * old file or the new one and never a half-written digest.
 */
export function mintToken(handle: string): string {
  const path = handleTokenPathFor(handle);
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const payload: TokenFile = { digest: digestOf(token).toString('hex') };

  ensureTokensDir();

  const staging = `${path}.${process.pid}.tmp`;

  writePrivateFileSync(staging, `${JSON.stringify(payload, null, 2)}\n`);
  renameSync(staging, path);

  return token;
}

export function revokeToken(handle: string): void {
  rmSync(handleTokenPathFor(handle), { force: true });
}

/**
 * 🛑 A MALFORMED DIGEST THROWS RATHER THAN NEVER MATCHING. A non-hex value
 * decodes to a zero-length buffer, so the length guard skipped it and that
 * handle stopped authenticating forever with no signal — indistinguishable
 * from an attacker presenting a forged token. Found by claude2.
 *
 * 🛑 THE BLAST RADIUS IS EVERY HANDLE, NOT THE OWNING ONE.
 * `authenticateToken` scans the whole directory, so one corrupt file is a
 * total outage and the 500 it causes should be read that way. Throwing is
 * still the right call, because the alternative is the silent death above.
 * Pinned by `🛑 a corrupt token file stops EVERY handle authenticating`.
 */
function digestIn(path: string): Buffer {
  const parsed = parseTokenFile(path);

  if (typeof parsed?.digest !== 'string' || !HEX_DIGEST.test(parsed.digest)) {
    throw new Error(`${path} does not hold a ${DIGEST} hex digest`);
  }

  return Buffer.from(parsed.digest, 'hex');
}

/**
 * 🛑 NAMES THE FILE. A bare `JSON.parse` raised a `SyntaxError` carrying only
 * the offending text, so the one file an operator has to delete was the one
 * thing the total outage did not say.
 */
function parseTokenFile(path: string): TokenFile {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as TokenFile;
  } catch (err) {
    throw new Error(`${path} does not hold readable JSON`, { cause: err });
  }
}

/**
 * 🛑 THE CALLER'S IDENTITY COMES FROM ITS SECRET, NEVER FROM A FIELD IT FILLS
 * IN. This is what `BrokerOptions.authenticate` and `McpHttpService` both
 * want, so neither invents its own comparison.
 *
 * Both sides are fixed-width digests, so a wrong-length token is refused
 * rather than raising out of `timingSafeEqual` — pinned by `🛑 a token of the
 * WRONG LENGTH is refused, never thrown`.
 *
 * Rejected: returning inside the loop on the first match. An early return
 * makes the work depend on WHICH handle matched, and the whole reason for
 * `timingSafeEqual` here is that the work must not depend on the secret. Two
 * handles holding one digest is the deterministic proof — a full scan sees
 * both and refuses, an early return answers the first. claude2's test.
 */
export function authenticateToken(token: string): string | null {
  const dir = handleTokensDir();

  if (!existsSync(dir)) return null;

  const presented = digestOf(token);
  const matched: string[] = [];

  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(SUFFIX)) continue;

    const candidate = digestIn(join(dir, entry));

    if (candidate.length !== presented.length) continue;
    if (timingSafeEqual(candidate, presented)) matched.push(entry.slice(0, -SUFFIX.length));
  }

  // 🛑 AMBIGUOUS MEANS REFUSE. Two handles sharing a digest is a hand-edited
  // file, not a collision anyone can produce, and guessing which one the
  // caller is would be the one thing this function must never do.
  return matched.length === 1 ? (matched[0] as string) : null;
}
