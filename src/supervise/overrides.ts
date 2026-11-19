/**
 * Per-handle container overrides: the KEY allowlist and its refusals.
 *
 * 🛑 AN ALLOWLIST, NOT A DENYLIST. Accepting raw `docker run` arguments would
 * make every future container flag reachable from a config file, including the
 * ones this module exists to refuse.
 *
 * 🛑 EVERY VALUE IS CHECKED, NOT ONLY EVERY KEY. An allowed key whose value
 * passed through as `unknown` was still an escalation: `{ image:
 * ["--privileged", "node:22"] }` reached a consumer that spreads into argv.
 */

/** Every key a human may write in an override file. */
export const ALLOWED_OVERRIDE_KEYS = [
  "env",
  "readOnlyMounts",
  "image",
  "memory",
  "cpus",
] as const;

export type AllowedOverrideKey = (typeof ALLOWED_OVERRIDE_KEYS)[number];

export type HandleOverride = Partial<Record<AllowedOverrideKey, unknown>>;

/**
 * The escalations somebody reaches for on purpose, each with its own sentence.
 *
 * A generic "unknown key" would refuse these too, and tell the human nothing
 * about why the thing they wanted is not available.
 */
export const EXPLAINED_REFUSALS = new Map<string, string>([
  [
    "privileged",
    "`privileged` is refused: it disables the isolation the container boundary IS",
  ],
  [
    "dockerSock",
    "`dockerSock` is refused: the daemon socket lets a container start a second one with any flags",
  ],
  [
    "network",
    "`network` is refused: host networking puts the agent on every port this machine serves",
  ],
  [
    "capAdd",
    "`capAdd` is refused: a capability is exactly the isolation an override may not widen",
  ],
  [
    "stateDir",
    "`stateDir` is refused: AGENTS.md bans file shims across the container boundary, and the bus is reached over HTTP",
  ],
]);

/**
 * The env names the spawn already pushes as credentials.
 *
 * 🛑 AN OVERRIDE MAY NOT NAME ONE. `docker run -e NAME` copies this process's
 * value, so an override that re-declared one would decide which credential the
 * agent receives. Pinned equal to `containerCredentialEnvVars` by test, so the
 * two cannot drift into merely coinciding.
 */
export const RESERVED_ENV_NAMES = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GH_TOKEN",
  "CHAT_MCP_MCP_CONFIG",
] as const;

/** POSIX env var names, which is narrower than what a shell will accept. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

function checkEnv(value: unknown): Record<string, string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("`env` must be a JSON object of NAME to string");
  }

  const out: Record<string, string> = {};

  for (const [name, raw] of Object.entries(value)) {
    if (!ENV_NAME.test(name)) {
      throw new Error(
        `\`env\` name ${JSON.stringify(name)} is not an environment variable name`,
      );
    }

    if ((RESERVED_ENV_NAMES as readonly string[]).includes(name)) {
      throw new Error(
        `\`env\` may not name ${name}: the spawn already pushes it as a credential`,
      );
    }

    if (typeof raw !== "string") {
      throw new Error(`\`env\` value for ${name} must be a string`);
    }

    out[name] = raw;
  }

  return out;
}

/**
 * 🛑 REFUSES RATHER THAN NORMALISES. A `..` resolved away here would differ
 * from what the driver's own containment check reads, and two readings of one
 * path is the shape that puts a directory at two container destinations.
 */
function checkReadOnlyMounts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("`readOnlyMounts` must be an array of relative paths");
  }

  const seen = new Set<string>();

  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error("a read-only mount must be a non-empty string");
    }

    if (entry.startsWith("/")) {
      throw new Error(
        `a read-only mount must be relative to the project: ${entry}`,
      );
    }

    if (entry.includes(":")) {
      throw new Error(
        `a read-only mount may not contain a colon, which docker reads as a spec separator: ${entry}`,
      );
    }

    if (entry.split("/").includes("..")) {
      throw new Error(
        `a read-only mount may not climb out of the project: ${entry}`,
      );
    }

    if (seen.has(entry)) {
      throw new Error(`a read-only mount is declared twice: ${entry}`);
    }

    seen.add(entry);
  }

  return [...value] as string[];
}

/**
 * 🛑 NO LEADING DASH AND NO WHITESPACE, WHICH IS THE POINT. A value starting
 * `-` is a docker flag, and a value containing a space becomes two argv
 * entries. The character class is otherwise permissive, because a registry
 * reference carries hosts, ports, tags and digests.
 */
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._:/@-]*$/;

/** Docker's own memory forms: digits, optionally one unit suffix. */
const MEMORY = /^\d+[bkmg]?$/i;

/** Docker's own `--cpus` form: a decimal number. */
const CPUS = /^\d+(\.\d+)?$/;

function checkPattern(
  key: "image" | "memory" | "cpus",
  value: unknown,
  pattern: RegExp,
): string {
  if (typeof value !== "string") {
    throw new Error(`\`${key}\` must be a string`);
  }

  if (!pattern.test(value)) {
    throw new Error(
      `\`${key}\` is not a legal value: ${JSON.stringify(value)}`,
    );
  }

  return value;
}

function isAllowed(key: string): key is AllowedOverrideKey {
  return (ALLOWED_OVERRIDE_KEYS as readonly string[]).includes(key);
}

/**
 * Validate one override file's parsed contents, or throw naming the key.
 *
 * 🛑 REFUSES THE WHOLE FILE, NOT THE KEY. A partial parse would let an
 * escalation sit beside a legal key and apply the legal half, so the human
 * would see a spawn that worked and a flag that silently did not.
 */
export function parseHandleOverride(raw: unknown): HandleOverride {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("an override must be a JSON object");
  }

  const out: HandleOverride = {};

  for (const [key, value] of Object.entries(raw)) {
    const explained = EXPLAINED_REFUSALS.get(key);

    if (explained) throw new Error(explained);

    if (!isAllowed(key)) {
      throw new Error(
        `unknown key ${JSON.stringify(key)}; an override may set only ` +
          ALLOWED_OVERRIDE_KEYS.join(", "),
      );
    }

    if (key === "env") out.env = checkEnv(value);
    else if (key === "readOnlyMounts")
      out.readOnlyMounts = checkReadOnlyMounts(value);
    else if (key === "image") out.image = checkPattern(key, value, IMAGE_REF);
    else if (key === "memory") out.memory = checkPattern(key, value, MEMORY);
    else out.cpus = checkPattern(key, value, CPUS);
  }

  return out;
}
