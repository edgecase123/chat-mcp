import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  ensureStateDir,
  stateDir,
  writePrivateFileSync,
} from "../util/paths.js";

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
  return join(stateDir(), "secrets.env");
}

/**
 * 🛑 ONE STRING, for the reason `GH_TOKEN_KEY` below spells out. It is also
 * `claudeSpawn.authEnvVar`, and `per-vendor-auth.test.ts` pins the two
 * together — this module cannot import an adapter, so the equality needs a
 * test rather than a shared constant.
 */
export const CLAUDE_TOKEN_KEY = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * 🛑 THE STORAGE KEY AND THE INJECTED ENV VAR NAME ARE ONE STRING, NOT TWO
 * THAT HAPPEN TO MATCH. The docker driver re-exports this as
 * `CONTAINER_GH_TOKEN_ENV` rather than declaring its own copy. Two literals
 * would let a rename inject `-e <newname>` for a var this file never stores,
 * and the container would get an UNSET `GH_TOKEN` — which `gh` reports as a
 * bad credential rather than as no credential. Raised in review before merge.
 */
export const GH_TOKEN_KEY = "GH_TOKEN";

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

  const lines = readFileSync(path, "utf8").split("\n");

  for (const [index, line] of lines.entries()) {
    const match = ENV_LINE.exec(line);

    if (match?.[1]) {
      secrets.set(match[1], match[2] ?? "");
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
      console.error(
        `chat-mcp: ${path}: ignoring unparseable line ${index + 1}`,
      );
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

  const body = [...secrets].map(([key, value]) => `${key}=${value}`).join("\n");
  const path = secretsEnvPath();
  const temp = `${path}.tmp`;

  writePrivateFileSync(temp, body.length > 0 ? `${body}\n` : "");
  renameSync(temp, path);
}

function setSecret(key: string, token: string): void {
  const trimmed = token.trim();

  if (trimmed.length === 0) {
    throw new Error("refusing to store an empty token");
  }

  // 🛑 ONE LINE PER CREDENTIAL IS THE WHOLE FILE FORMAT. An embedded newline
  // would split one token across two lines, and the tail could parse as some
  // other key — so the next read returns a truncated credential rather than
  // failing. Refuse it at the door instead.
  if (/[\r\n]/.test(trimmed)) {
    throw new Error("refusing to store a token containing a newline");
  }

  const secrets = readSecrets();

  secrets.set(key, trimmed);
  writeSecrets(secrets);
}

/** `null` when nothing is on file — the driver turns that into a fail-fast error naming this command. */
function readSecret(key: string): string | null {
  return readSecrets().get(key)?.trim() ?? null;
}

/**
 * This vendor's own credential, keyed off the env var it is injected under.
 *
 * 🛑 ONE TOKEN PER VENDOR, BECAUSE ONE TOKEN FOR ALL OF THEM SENT A CLAUDE
 * SUBSCRIPTION CREDENTIAL TO CURSOR'S SERVERS. `dockerRunPlan` read a single
 * `readToken()` and injected it under whatever name the vendor declared, so
 * the name changed per vendor and the value never did. #347.
 *
 * ⚠️ `null` IS A SUPPORTED ANSWER AND THE CALLER MUST REFUSE ON IT. Measured
 * on #347: `CURSOR_API_KEY` set to a credential Cursor cannot use OVERRIDES a
 * working login rather than filling a gap, so injecting the wrong token is
 * worse than injecting none — the container exits 1 before its first event.
 */
export function readVendorToken(vendor: { authEnvVar: string }): string | null {
  return readSecret(vendor.authEnvVar);
}

export function setVendorToken(
  vendor: { authEnvVar: string },
  token: string,
): void {
  setSecret(vendor.authEnvVar, token);
}

/**
 * The Claude-specific aliases, kept because the test suite seeds through them.
 *
 * 🛑 ALIASES OF THE LIVE PATH, NOT A SECOND ONE. They had zero production
 * callers the moment `dockerRunPlan` went per-vendor, and a helper that no
 * longer shares the code it is testing is how a test keeps passing against a
 * path the application abandoned. Routing them through the same `readSecret`
 * key means there is nothing for them to diverge from. Raised by claude1 on
 * PR 354; deleting them and reseeding those tests is a follow-up, not this
 * security fix's business.
 */
export function setToken(token: string): void {
  setSecret(CLAUDE_TOKEN_KEY, token);
}

export function readToken(): string | null {
  return readSecret(CLAUDE_TOKEN_KEY);
}

/**
 * The refusal for a containerized spawn with no credential on file.
 *
 * 🛑 ONE BUILDER FOR BOTH REFUSAL SITES. `startSupervisor` and
 * `dockerRunPlan` each carried their own copy of this sentence, and both
 * copies named Claude. A second vendor made them wrong in two places at once.
 */
export function missingVendorTokenMessage(vendor: {
  vendor: string;
  authEnvVar: string;
  authSetupHint: string;
}): string {
  return (
    `no ${vendor.authEnvVar} on file; ${vendor.authSetupHint}, then ` +
    `\`pbpaste | chat-mcp auth set-token --vendor ${vendor.vendor}\` ` +
    `(stdin, never argv)`
  );
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
