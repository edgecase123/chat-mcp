import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureStateDir, stateDir, writePrivateFileSync } from '../util/paths.js';

const TOKEN_BYTES = 32;

/** Pinned by `the stored file holds NO token, only its digest`. */
const DIGEST = 'sha256';

interface TokenFile {
  handles: Record<string, string>;
}

export function handleTokensPath(): string {
  return join(stateDir(), 'handle-tokens.json');
}

function digestOf(token: string): Buffer {
  return createHash(DIGEST).update(token, 'utf8').digest();
}

/**
 * Throws on a file it cannot parse rather than returning an empty map.
 *
 * Rejected: swallowing the parse error. That turns a corrupt file into
 * "every token is wrong", which looks identical to an attack and sends the
 * operator hunting the caller instead of the file.
 */
function readTokens(): Record<string, string> {
  const path = handleTokensPath();

  if (!existsSync(path)) return {};

  const parsed = JSON.parse(readFileSync(path, 'utf8')) as TokenFile;

  if (typeof parsed?.handles !== 'object' || parsed.handles === null) {
    throw new Error(`${path} has no "handles" object`);
  }

  return parsed.handles;
}

function writeTokens(handles: Record<string, string>): void {
  ensureStateDir();
  writePrivateFileSync(handleTokensPath(), `${JSON.stringify({ handles }, null, 2)}\n`);
}

/**
 * Mint `handle`'s bearer token, returning it ONCE. Only its digest is stored,
 * so nothing that reads the file afterwards can authenticate with it.
 *
 * Replaces any token the handle already had — see `🛑 re-minting a handle
 * INVALIDATES the token it had before`.
 */
export function mintToken(handle: string): string {
  if (handle.trim().length === 0) {
    throw new Error('refusing to mint a token for an empty handle');
  }

  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const handles = readTokens();

  handles[handle] = digestOf(token).toString('hex');
  writeTokens(handles);

  return token;
}

export function revokeToken(handle: string): void {
  const handles = readTokens();

  if (!(handle in handles)) return;

  delete handles[handle];
  writeTokens(handles);
}

/**
 * 🛑 THE CALLER'S IDENTITY COMES FROM ITS SECRET, NEVER FROM A FIELD IT FILLS
 * IN. This is what `BrokerOptions.authenticate` and the HTTP transport both
 * want, so neither invents its own comparison.
 *
 * Both sides are fixed-width digests, so a wrong-length token is refused
 * rather than raising out of `timingSafeEqual` — pinned by `🛑 a token of the
 * WRONG LENGTH is refused, never thrown`.
 *
 * Rejected: returning inside the loop on the first match. An early return
 * makes the work depend on WHICH handle matched, and the whole reason for
 * `timingSafeEqual` here is that the work must not depend on the secret.
 */
export function authenticateToken(token: string): string | null {
  const presented = digestOf(token);
  let found: string | null = null;

  for (const [handle, stored] of Object.entries(readTokens())) {
    const candidate = Buffer.from(stored, 'hex');

    if (candidate.length !== presented.length) continue;
    if (timingSafeEqual(candidate, presented)) found = handle;
  }

  return found;
}
