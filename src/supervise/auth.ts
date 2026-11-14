import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ensureStateDir, stateDir, writePrivateFileSync } from '../util/paths.js';

/**
 * The credentials a containerized agent is spawned with, in ONE shared file.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` is #129's design decision 3: generated on the HOST
 * via `claude setup-token` (needs a browser, which no container has), stored
 * here, read by the docker driver and injected with `docker run -e`.
 *
 * `GH_TOKEN` is #214 and follows the same shape by lee's ruling of
 * 2026-11-13: one shared token for every handle, not one file per handle.
 * Revoking one agent therefore revokes all of them — the accepted cost,
 * recorded on the ticket.
 */
export function secretsEnvPath(): string {
  return join(stateDir(), 'secrets.env');
}

const CLAUDE_TOKEN_KEY = 'CLAUDE_CODE_OAUTH_TOKEN';

/**
 * 🛑 THE STORAGE KEY AND THE INJECTED ENV VAR NAME ARE ONE STRING, NOT TWO
 * THAT HAPPEN TO MATCH. The docker driver re-exports this as
 * `CONTAINER_GH_TOKEN_ENV` rather than declaring its own copy. Two literals
 * would let a rename inject `-e <newname>` for a var this file never stores,
 * and the container would get an UNSET `GH_TOKEN` — which `gh` reports as a
 * bad credential rather than as no credential. Raised in review before merge.
 */
export const GH_TOKEN_KEY = 'GH_TOKEN';

/** `KEY=value`, one per line. The value may contain `=`; the key may not. */
const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

/**
 * 🛑 PARSE-THEN-MERGE, NEVER OVERWRITE. Two credentials share this file, so a
 * writer that rewrites it whole drops the other one. The symptom arrives much
 * later and looks nothing like its cause: an agent that cannot reach GitHub,
 * or cannot reach Claude, with no error at the moment of loss.
 *
 * Only this module writes the file, so a line this cannot parse is not
 * something it wrote. Such a line is dropped rather than carried, which is
 * safe for that reason and for no other.
 */
function readSecrets(): Map<string, string> {
  const secrets = new Map<string, string>();
  const path = secretsEnvPath();

  if (!existsSync(path)) return secrets;

  const lines = readFileSync(path, 'utf8').split('\n');

  for (const [index, line] of lines.entries()) {
    const match = ENV_LINE.exec(line);

    if (match?.[1]) {
      secrets.set(match[1], match[2] ?? '');
      continue;
    }

    // 🛑 SAY SO BEFORE DROPPING IT. The next `setSecret` rebuilds the file
    // from this map, so an unparseable line is gone for good — and a
    // credential that vanished with no error at the moment of loss is the
    // exact failure this module is shaped to avoid. An operator hand-edit
    // (`export KEY=v`, a quoted value) is the realistic way one gets here.
    //
    // ⚠️ THE LINE NUMBER, NEVER THE CONTENT. This file holds secrets.
    if (line.trim().length > 0) {
      console.error(`chat-mcp: ${path}: ignoring unparseable line ${index + 1}`);
    }
  }

  return secrets;
}

/**
 * 🛑 WRITE THEN RENAME, BECAUSE BOTH CREDENTIALS ARE IN THIS ONE FILE. A
 * truncate-in-place that dies mid-write leaves the agent with NEITHER token,
 * and the file it leaves behind is a plausible-looking partial. `renameSync`
 * is atomic within a filesystem, and it carries the temp file's `0600` over,
 * so the live path is never briefly wider.
 */
function writeSecrets(secrets: Map<string, string>): void {
  ensureStateDir();

  const body = [...secrets].map(([key, value]) => `${key}=${value}`).join('\n');
  const path = secretsEnvPath();
  const temp = `${path}.tmp`;

  writePrivateFileSync(temp, body.length > 0 ? `${body}\n` : '');
  renameSync(temp, path);
}

function setSecret(key: string, token: string): void {
  const trimmed = token.trim();

  if (trimmed.length === 0) {
    throw new Error('refusing to store an empty token');
  }

  // 🛑 ONE LINE PER CREDENTIAL IS THE WHOLE FILE FORMAT. An embedded newline
  // would split one token across two lines, and the tail could parse as some
  // other key — so the next read returns a truncated credential rather than
  // failing. Refuse it at the door instead.
  if (/[\r\n]/.test(trimmed)) {
    throw new Error('refusing to store a token containing a newline');
  }

  const secrets = readSecrets();

  secrets.set(key, trimmed);
  writeSecrets(secrets);
}

/** `null` when nothing is on file — the driver turns that into a fail-fast error naming this command. */
function readSecret(key: string): string | null {
  return readSecrets().get(key)?.trim() ?? null;
}

export function setToken(token: string): void {
  setSecret(CLAUDE_TOKEN_KEY, token);
}

export function readToken(): string | null {
  return readSecret(CLAUDE_TOKEN_KEY);
}

export function setGhToken(token: string): void {
  setSecret(GH_TOKEN_KEY, token);
}

/** `null` when nothing is on file. Unlike the Claude token, that is a supported state. */
export function readGhToken(): string | null {
  return readSecret(GH_TOKEN_KEY);
}

/**
 * Presence without the value, for callers that only need to know whether to
 * mention the credential — the container confirmation banner prints env var
 * NAMES, so it has no business holding the secret to decide that.
 */
export function hasGhToken(): boolean {
  return readGhToken() !== null;
}

/** The inverse of `setGhToken`, so an agent's GitHub access can be withdrawn without clearing its Claude token. */
export function clearGhToken(): void {
  const secrets = readSecrets();

  if (!secrets.delete(GH_TOKEN_KEY)) return;

  writeSecrets(secrets);
}
