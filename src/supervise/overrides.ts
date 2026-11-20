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

import { assertProfileName } from "../util/naming.js";

/** Every key a human may write in an override file. */
export const ALLOWED_OVERRIDE_KEYS = [
  "env",
  "readOnlyMounts",
  "image",
  "memory",
  "cpus",
] as const;

export type AllowedOverrideKey = (typeof ALLOWED_OVERRIDE_KEYS)[number];

/**
 * Every key a human may write in a HANDLE file: the five, plus the pointer.
 *
 * 🛑 `profile` IS NOT A SIXTH CONTAINER KEY. It names a second file whose
 * contents are the five. Putting it in `ALLOWED_OVERRIDE_KEYS` would read as
 * another thing docker can be told, and a profile file would then accept it.
 */
export const ALLOWED_HANDLE_KEYS = [
  ...ALLOWED_OVERRIDE_KEYS,
  "profile",
] as const;

export type AllowedHandleKey = (typeof ALLOWED_HANDLE_KEYS)[number];

/** What reaches a spawn: the five keys, each already checked. */
export type ContainerOverride = {
  env?: Record<string, string>;
  readOnlyMounts?: string[];
  image?: string;
  memory?: string;
  cpus?: string;
};

export type HandleOverride = ContainerOverride & { profile?: string };

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

    // 🛑 `docker run -e` IS IMMUNE AND `--env-file` IS NOT. The flag sets one
    // multi-line variable; the file is parsed by line, so a newline here
    // declares a SECOND variable, which may name a reserved credential.
    if (/[\n\r\u0000]/.test(raw)) {
      throw new Error(
        `\`env\` value for ${name} may not contain a newline or a NUL: ` +
          "a line break declares a second variable in an env file",
      );
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

    const segments = entry.split("/");

    if (segments.includes("..")) {
      throw new Error(
        `a read-only mount may not climb out of the project: ${entry}`,
      );
    }

    // 🛑 ONE PATH, ONE SPELLING. The duplicate check below compares STRINGS,
    // so `docs` and `./docs` were two mounts of one directory — and the merge
    // unions two files, which doubles the chance of a second spelling.
    // Refused rather than normalised, for the reason in this docblock.
    // Case is NOT folded: `Docs` is a different directory where the
    // filesystem is case-sensitive, so the pair is legal.
    if (segments.includes(".") || segments.includes("")) {
      throw new Error(
        "a read-only mount must be in canonical form, with no `.` segment, " +
          `no doubled slash and no trailing slash: ${entry}`,
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

/** What a legal value of each patterned key looks like, for the refusal. */
function exampleFor(key: "image" | "memory" | "cpus"): string {
  if (key === "image") return "node:22-slim";
  if (key === "memory") return "512m";

  return "2";
}

/**
 * 🛑 ZERO IS NOT A SMALL LIMIT, IT IS NO LIMIT. Measured on this host,
 * docker 24.0.7: `--memory 0` leaves `memory.max` at `max`, and `--cpus 0`
 * leaves `cpu.max` with no quota.
 *
 * ⚠️ THE ADD-ONLY RULING CANNOT REACH THIS. The ruling protects a NAME, and
 * for these two keys the value is the only thing there is — so a handle file
 * writing `"memory": "0"` would nullify a profile's cap and obey the letter
 * of the ruling. Found by `security-scanner` on PR 333.
 */
function refuseNoLimit(key: "memory" | "cpus", value: string): void {
  const digits = key === "memory" ? value.replace(/[bkmg]$/i, "") : value;

  if (Number(digits) === 0) {
    throw new Error(
      `\`${key}\` may not be zero: docker reads zero as no limit, so the ` +
        "override would widen the container rather than narrow it",
    );
  }
}

function checkPattern(
  key: "image" | "memory" | "cpus",
  value: unknown,
  pattern: RegExp,
): string {
  // 🛑 THE MESSAGE TEACHES THE QUOTES, because a human writes this file and a
  // human writes `2`, not `"2"`. String-only is correct: docker's own forms
  // are `512m` and `1.5`, which are not numbers.
  if (typeof value !== "string") {
    throw new Error(
      `\`${key}\` must be a quoted string: write ` +
        `${JSON.stringify(String(exampleFor(key)))}, not ${JSON.stringify(value)}`,
    );
  }

  if (!pattern.test(value)) {
    throw new Error(
      `\`${key}\` is not a legal value: ${JSON.stringify(value)}`,
    );
  }

  if (key !== "image") refuseNoLimit(key, value);

  return value;
}

/**
 * A profile name, which is deliberately narrower than a filename.
 *
 * 🛑 THE NAME BECOMES A PATH SEGMENT. Refusing the dot and the slash outright
 * is narrower than resolving the path and checking where it landed, and it
 * cannot disagree with whatever the reader of the profiles directory does.
 *
 * 🛑 THE PATTERN MOVED TO `util/naming.ts` TO KEEP THAT TRUE. `profilePathFor`
 * is the reader's path builder, and `src/util` cannot import from
 * `src/supervise` without a cycle — so a local regex here was the second copy
 * the sentence above forbids.
 */
function checkProfileName(value: unknown): string {
  assertProfileName(value);

  return value;
}

/**
 * Validate one override file's parsed contents, or throw naming the key.
 *
 * 🛑 REFUSES THE WHOLE FILE, NOT THE KEY. A partial parse would let an
 * escalation sit beside a legal key and apply the legal half, so the human
 * would see a spawn that worked and a flag that silently did not.
 */
/**
 * The value check for every key a handle may set.
 *
 * 🛑 `Record<AllowedHandleKey, …>` IS THE GUARD. A key added to
 * `ALLOWED_HANDLE_KEYS` with no check here does not compile, so an unchecked
 * value can never reach a spawn. Found by `dry-solid-reviewer` on PR 333.
 */
const VALUE_CHECKS: Record<AllowedHandleKey, (value: unknown) => unknown> = {
  env: checkEnv,
  readOnlyMounts: checkReadOnlyMounts,
  image: (value) => checkPattern("image", value, IMAGE_REF),
  memory: (value) => checkPattern("memory", value, MEMORY),
  cpus: (value) => checkPattern("cpus", value, CPUS),
  profile: checkProfileName,
};

/**
 * The container keys whose values UNION on a merge rather than replace.
 *
 * 🛑 `satisfies` IS THE GUARD. `SCALAR_KEYS` is the complement of this list,
 * so a misspelled entry here would not fail: it would quietly move a real key
 * into the replacing half, and a handle file could then drop what a profile
 * set. A spelling that is not a container key does not compile. Found by
 * claude2 on PR 333.
 */
export const UNION_KEYS = [
  "env",
  "readOnlyMounts",
] as const satisfies readonly AllowedOverrideKey[];

/**
 * The container keys a later value simply replaces.
 *
 * 🛑 DERIVED, NOT A THIRD COPY OF THE LIST. A hand-kept copy that missed a
 * sixth container key would drop that key from BOTH sides of the merge, and
 * the spawn would run without it with nothing printed. Found by
 * `dry-solid-reviewer` on PR 333.
 */
export const SCALAR_KEYS = ALLOWED_OVERRIDE_KEYS.filter(
  (key): key is Exclude<AllowedOverrideKey, (typeof UNION_KEYS)[number]> =>
    !(UNION_KEYS as readonly string[]).includes(key),
);

function parseAgainst(
  raw: unknown,
  allowed: readonly string[],
): HandleOverride {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("an override must be a JSON object");
  }

  const out: HandleOverride = {};

  for (const [key, value] of Object.entries(raw)) {
    const explained = EXPLAINED_REFUSALS.get(key);

    if (explained) throw new Error(explained);

    if (!allowed.includes(key)) {
      throw new Error(
        `unknown key ${JSON.stringify(key)}; an override may set only ` +
          allowed.join(", "),
      );
    }

    // 🛑 THE TABLE IS EXHAUSTIVE BY TYPE, which an if/else chain was not. Its
    // terminal `else` meant `profile`, so a sixth allowed key with no branch
    // of its own was read AS a profile name — a guard that failed open.
    (out as Record<string, unknown>)[key] =
      VALUE_CHECKS[key as AllowedHandleKey](value);
  }

  return out;
}

export function parseHandleOverride(raw: unknown): HandleOverride {
  return parseAgainst(raw, ALLOWED_HANDLE_KEYS);
}

/**
 * Validate one profile file, or throw naming the key.
 *
 * 🛑 A PROFILE MAY NOT NAME A PROFILE. A pointer inside a profile makes the
 * files a graph, and resolving a graph needs cycle detection that lee's
 * ruling of 2026-11-19 never asked for. Two layers, profile then handle.
 */
export function parseProfile(raw: unknown): ContainerOverride {
  if (raw !== null && typeof raw === "object" && "profile" in raw) {
    throw new Error(
      "a profile may not set a profile name: only a handle points at a " +
        "profile, so the files stay two layers rather than a graph",
    );
  }

  // ⚠️ DESTRUCTURED, NOT CAST. The pre-check above carries the message a
  // human can act on; this line is what makes the narrowed return type true
  // rather than merely assignable.
  const { profile: _pointer, ...container } = parseAgainst(
    raw,
    ALLOWED_OVERRIDE_KEYS,
  );

  return container;
}

/**
 * Apply a handle's override on top of its profile's, ADD-only.
 *
 * 🛑 ADD-ONLY IS lee's RULING OF 2026-11-19 (`#mcp` 15889). A handle may
 * change what a name is SET TO. No handle file can express dropping a name
 * the profile contributed, which is why this unions rather than replaces.
 *
 * 🛑 THE TWO LAYERS ARE NAMED RATHER THAN ORDERED. Positionally, `profile`
 * is optional on a handle, so the transposed call type-checked and silently
 * inverted the ruling. Found by `security-scanner` on PR 333.
 */
export function mergeOverrides({
  profile,
  handle,
}: {
  profile: ContainerOverride;
  handle: HandleOverride;
}): ContainerOverride {
  const merged: ContainerOverride = {};

  if (profile.env || handle.env) {
    merged.env = { ...profile.env, ...handle.env };
  }

  if (profile.readOnlyMounts || handle.readOnlyMounts) {
    // 🛑 DEDUPED. A repeated `-v` puts one directory at one destination twice,
    // and docker's own error for that names neither mount.
    merged.readOnlyMounts = [
      ...new Set([
        ...(profile.readOnlyMounts ?? []),
        ...(handle.readOnlyMounts ?? []),
      ]),
    ];
  }

  for (const key of SCALAR_KEYS) {
    const value = handle[key] ?? profile[key];

    if (value !== undefined) merged[key] = value;
  }

  return merged;
}
