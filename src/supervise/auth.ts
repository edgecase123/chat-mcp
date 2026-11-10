import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureStateDir, stateDir, writePrivateFileSync } from '../util/paths.js';

/**
 * One `CLAUDE_CODE_OAUTH_TOKEN`, shared by every containerized handle for
 * now. #129's design decision 3: generated on the HOST via
 * `claude setup-token` (needs a browser, which no container has), stored
 * here, read by the docker driver and injected with `docker run -e`.
 */
export function secretsEnvPath(): string {
  return join(stateDir(), 'secrets.env');
}

export function setToken(token: string): void {
  const trimmed = token.trim();

  if (trimmed.length === 0) {
    throw new Error('refusing to store an empty token');
  }

  ensureStateDir();
  writePrivateFileSync(secretsEnvPath(), `CLAUDE_CODE_OAUTH_TOKEN=${trimmed}\n`);
}

/** `null` when nothing is on file — the driver turns that into a fail-fast error naming this command. */
export function readToken(): string | null {
  const path = secretsEnvPath();

  if (!existsSync(path)) return null;

  const match = /^CLAUDE_CODE_OAUTH_TOKEN=(.*)$/m.exec(readFileSync(path, 'utf8'));

  return match ? (match[1]?.trim() ?? null) : null;
}
