import { existsSync, readFileSync } from "node:fs";
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
  assertHandle(handle);

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`"${handle}" must map to an object of vendor and mode`);
  }

  const record = raw as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `"${handle}" has an unknown key "${key}": this file holds ` +
          `${ALLOWED_KEYS.join(" and ")} only`,
      );
    }
  }

  const { vendor, mode } = record;

  if (typeof vendor !== "string" || vendor.length === 0) {
    throw new Error(
      `"${handle}" needs a non-empty vendor string, got ${JSON.stringify(vendor)}`,
    );
  }

  if (!MODES.includes(mode as SandboxMode)) {
    throw new Error(
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

  ensureStateDir();
  writePrivateFileSync(
    registrationsPath(),
    `${JSON.stringify({ agents }, null, 2)}\n`,
  );

  return record;
}

/** Forget a handle's registration entirely. Its siblings are untouched. */
export function unregisterAgent(handle: string): void {
  const agents = { ...readRegistrations().agents };
  delete agents[handle];

  ensureStateDir();
  writePrivateFileSync(
    registrationsPath(),
    `${JSON.stringify({ agents }, null, 2)}\n`,
  );
}
