import { existsSync, readFileSync } from 'node:fs';
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
const GH_TOKEN_KEY = 'GH_TOKEN';

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

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = ENV_LINE.exec(line);

    if (match?.[1]) secrets.set(match[1], match[2] ?? '');
  }

  return secrets;
}

function writeSecrets(secrets: Map<string, string>): void {
  ensureStateDir();

  const body = [...secrets].map(([key, value]) => `${key}=${value}`).join('\n');

  writePrivateFileSync(secretsEnvPath(), body.length > 0 ? `${body}\n` : '');
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

/** The inverse of `setGhToken`, so an agent's GitHub access can be withdrawn without clearing its Claude token. */
export function clearGhToken(): void {
  const secrets = readSecrets();

  if (!secrets.delete(GH_TOKEN_KEY)) return;

  writeSecrets(secrets);
}
