/**
 * Per-handle container overrides: the KEY allowlist and its refusals.
 *
 * 🛑 AN ALLOWLIST, NOT A DENYLIST. Accepting raw `docker run` arguments would
 * make every future container flag reachable from a config file, including the
 * ones this module exists to refuse.
 *
 * ⚠️ KEYS ONLY. Nothing here checks what is INSIDE `env` or `readOnlyMounts`.
 * That is #222 unit 2, and until it lands an override is trusted input from
 * the human who wrote the file.
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

    out[key] = value;
  }

  return out;
}
