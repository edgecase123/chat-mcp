import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  ensureStateDir,
  stateDir,
  writePrivateFileSync,
} from "../util/paths.js";
import { assertHandle } from "../util/naming.js";
import type { SandboxMode } from "./vendor.js";

/**
 * Which (vendor, mode) pair each registered agent is started with — the
 * operator-edited half of #132, kept apart from the live `agents` table.
 *
 * 🛑 A FILE UNDER `stateDir()`, NOT A SQLITE TABLE. `projects.json`,
 * `mounts.json` and `container.json` are already this shape, and the `agents`
 * table's `metadata_json` is replaced wholesale by five writers that never
 * read the row first — so an operator field stored there is destroyed by the
 * agent's own next register call, silently.
 *
 * 🛑 IT HOLDS `vendor` AND `mode` AND NOTHING ELSE. `profile` is the override
 * file's, `display_name` is the `agents` table's column, and `project_dir` is
 * `dirsFor`'s. Each of the three was proposed for this file and each would be
 * a second source of truth. `ALLOWED_KEYS` refuses them by name.
 */

export interface AgentRegistration {
  readonly vendor: string;
  readonly mode: SandboxMode;
}

export interface RegistrationConfig {
  /** handle -> the (vendor, mode) pair that handle is started with. */
  readonly agents: Record<string, AgentRegistration>;
}

const EMPTY: RegistrationConfig = { agents: {} };

const ALLOWED_KEYS = ["vendor", "mode"] as const;

/**
 * 🛑 ENUMERATED HERE RATHER THAN IMPORTED FROM `resolveDriver`.
 *
 * That function derives the mode from a BOOLEAN, so every value it does not
 * recognise resolves to `host` — the looser of the two. A registration reading
 * `"Docker"` would hand the operator an uncontained agent and a card saying
 * contained.
 */
const MODES: readonly SandboxMode[] = ["host", "docker"];

/**
 * A CALLER's mistake in a registration — a bad handle, an unknown mode, an
 * extra key. Distinct from a failed write.
 *
 * 🛑 A TYPE, SO AN API CAN RETURN 400 WITHOUT RE-VALIDATING. `server.ts` maps
 * only this class to a 4xx and rethrows everything else, which is the rule
 * `RoomSendInputError` already carries: a full disk must stay a 500. A blanket
 * catch around `registerAgent` cannot tell the two apart, and a second copy of
 * the rules in the handler would be free to drift from these ones.
 */
export class RegistrationInputError extends Error {}

export function registrationsPath(): string {
  return join(stateDir(), "agents.json");
}

/**
 * 🛑 THE HANDLE IS VALIDATED EVEN THOUGH IT IS NOT A FILENAME HERE.
 *
 * The spawn path turns it into one — `notifyPathFor`, `socketPathFor`,
 * `mcpConfigPathFor` all call `assertHandle`. A key accepted here and refused
 * there is a registration no agent can ever be started from.
 */
function parseRecord(handle: string, raw: unknown): AgentRegistration {
  // 🛑 RECLASSIFIED, NOT RE-CHECKED. `assertHandle` is the one home for the
  // handle rules and it throws a plain Error, which an API would report as a
  // 500. Re-testing the shape here would be the second copy this file's
  // header already refuses.
  try {
    assertHandle(handle);
  } catch (e) {
    throw new RegistrationInputError((e as Error).message);
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new RegistrationInputError(
      `"${handle}" must map to an object of vendor and mode`,
    );
  }

  const record = raw as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
      throw new RegistrationInputError(
        `"${handle}" has an unknown key "${key}": this file holds ` +
          `${ALLOWED_KEYS.join(" and ")} only`,
      );
    }
  }

  const { vendor, mode } = record;

  if (typeof vendor !== "string" || vendor.length === 0) {
    throw new RegistrationInputError(
      `"${handle}" needs a non-empty vendor string, got ${JSON.stringify(vendor)}`,
    );
  }

  if (!MODES.includes(mode as SandboxMode)) {
    throw new RegistrationInputError(
      `"${handle}" has mode ${JSON.stringify(mode)}: it must be one of ` +
        `${MODES.join(", ")}. Refusing rather than reading an unknown mode as host.`,
    );
  }

  return { vendor, mode: mode as SandboxMode };
}

/**
 * Every registration on file, or an empty set when there is no file.
 *
 * 🛑 MALFORMED THROWS, UNLIKE `readProjects` AND `readMounts`. Those read
 * empty on purpose, because `dirsFor` reports an empty registration loudly. An
 * empty read HERE is byte-identical to the normal no-file case, so a stray
 * comma would start a handle on the default pair while its operator's file
 * says something else, and nothing would say so.
 *
 * 🛑 THE PATH IS IN EVERY MESSAGE. `JSON.parse` says "Unexpected token" and
 * names no file, and an operator who wrote this into the wrong tree needs the
 * location rather than the name.
 */
export function readRegistrations(): RegistrationConfig {
  const path = registrationsPath();

  if (!existsSync(path)) return EMPTY;

  let raw: unknown;

  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`cannot read ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }

  if (typeof raw !== "object" || raw === null) {
    throw new Error(`refusing ${path}: the document must be an object`);
  }

  const parsed = (raw as { agents?: unknown }).agents ?? {};

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`refusing ${path}: "agents" must be an object of handles`);
  }

  const agents: Record<string, AgentRegistration> = {};

  for (const [handle, record] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    try {
      agents[handle] = parseRecord(handle, record);
    } catch (err) {
      throw new Error(`refusing ${path}: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }

  return { agents };
}

/**
 * One handle's registration, or `null` when it has none.
 *
 * ⚠️ `null` IS THE NORMAL CASE, NOT AN ERROR. Every handle started with
 * explicit `--driver` / `--container` flags has no file entry, and an explicit
 * flag still wins over a stored value because a flag is the operator saying it
 * out loud.
 */
export function registrationFor(handle: string): AgentRegistration | null {
  return readRegistrations().agents[handle] ?? null;
}

/**
 * Store `handle`'s pair, replacing any record it already had.
 *
 * 🛑 REPLACED, NOT MERGED. Both fields are required, so a merge could only
 * ever carry a stale half — and the stale half here is the one that decides
 * whether the agent is contained.
 */
export function registerAgent(
  handle: string,
  registration: AgentRegistration,
): AgentRegistration {
  const record = parseRecord(handle, registration);

  const agents = { ...readRegistrations().agents, [handle]: record };

  writeRegistrations(agents);

  return record;
}

/**
 * Forget a handle's registration. Its siblings are untouched.
 *
 * 🛑 A HANDLE WITH NO RECORD WRITES NOTHING, AND THAT INCLUDES NOT CREATING
 * THE FILE. `overrideStore.ts`'s header states the principle: a module that
 * creates the file it is about to read can no longer tell "nothing configured"
 * from "the operator's file is missing". Raised by claude2 on PR 360.
 */
export function unregisterAgent(handle: string): void {
  const { agents } = readRegistrations();

  if (!(handle in agents)) return;

  const remaining = { ...agents };
  delete remaining[handle];

  writeRegistrations(remaining);
}

/**
 * 🛑 STAGED AND RENAMED, NEVER TRUNCATED IN PLACE.
 *
 * `auth.ts`'s `writeSecrets` gives the reason for `secrets.env`: a write that
 * dies partway leaves a plausible-looking partial. Here it is worse, because
 * `readRegistrations` REFUSES a malformed document — so one torn write takes
 * every handle down, not just the one being written. `renameSync` is atomic
 * within a filesystem and carries the staging file's `0600` across, so the
 * live path is never briefly wider.
 */
function writeRegistrations(agents: Record<string, AgentRegistration>): void {
  ensureStateDir();

  const path = registrationsPath();
  const staging = `${path}.${process.pid}.tmp`;

  writePrivateFileSync(staging, `${JSON.stringify({ agents }, null, 2)}\n`);
  renameSync(staging, path);
}
