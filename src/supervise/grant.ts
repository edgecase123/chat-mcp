import { AVAILABLE_BUILTINS, DEFAULT_ALLOWLIST, EXTRA_DIRS } from './allowlist.js';

/**
 * What a supervised child is allowed to be and to do.
 *
 * 🛑 SEMANTIC, SO A SECOND DRIVER CAN EXPRESS IT ITS OWN WAY. Claude Code needs
 * argv flags and a generated MCP config file. Another CLI may need neither.
 * Nothing above the driver should know which.
 *
 * ⚠️ It is ONE decision, not a bag of flags. Measured on #33: `--mcp-config`
 * without `--strict-mcp-config` leaves the child reading the consuming
 * project's `.mcp.json`, which hardcodes a handle a live session already owns.
 * Half of this configuration is worse than none of it.
 *
 * 🛑 THIS REPLACED A REPLY-ONLY GRANT, on lee's decision of 2026-10-31. The old
 * shape passed `--tools ''` to disable every built-in, which was right for an
 * agent that only answered on the bus and is incompatible with one that edits
 * files and runs tests.
 */
export interface ChildGrant {
  /**
   * The handle the CHILD registers under.
   *
   * Never the supervisor's own. A child sharing the supervisor's handle
   * consumes the very messages the supervisor is delivering to it — `inbox`
   * marks messages read, so the loser of that race sees an empty array.
   */
  readonly handle: string;

  /** Where the driver wrote the child's private MCP config. */
  readonly configPath: string;

  /**
   * Everything the child may use without asking. Feeds `--allowedTools`.
   *
   * Includes `Name(spec)` entries and `mcp__*` tools.
   */
  readonly allowed: readonly string[];

  /**
   * Which BUILT-IN tools exist at all. Feeds `--tools`.
   *
   * 🛑 `--tools` GOVERNS BUILT-INS ONLY. Measured: with `--tools ''` a child
   * still reached `mcp__chat__send`, because MCP tools come from the connected
   * server rather than from this flag. So an MCP tool belongs in `allowed` and
   * never here.
   */
  readonly available: readonly string[];

  /**
   * Directories the child may touch beyond its working directory.
   *
   * 🛑 PATHS, NOT A FLAG. Claude Code spells this `--add-dir`; Cursor will
   * spell it something else or not at all. The driver renders it, and a
   * driver whose CLI has no equivalent simply ignores it — which is a
   * NARROWER agent, never a wider one.
   */
  readonly extraDirs: readonly string[];
}

/**
 * The built-in tools an allowlist implies.
 *
 * 🛑 DERIVED, NOT LISTED SEPARATELY. Two hand-maintained lists drift, and the
 * drift is silent: a `Bash(git commit:*)` entry with no `Bash` in `--tools`
 * yields an allowlist entry for a tool that does not exist, and the child
 * simply cannot run it.
 */
export function builtinsFrom(allowed: readonly string[]): string[] {
  const names = allowed
    .filter((t) => !t.startsWith('mcp__'))
    .map((t) => t.replace(/\(.*$/, '').trim())
    .filter((t) => t.length > 0);

  return [...new Set(names)];
}

/** The default grant's tool surface: lee's narrow allowlist. */
export const DEFAULT_ALLOWED = DEFAULT_ALLOWLIST;

/** Directories a default grant may reach beyond the child's cwd. */
export const DEFAULT_EXTRA_DIRS = EXTRA_DIRS;

/**
 * Which built-ins must EXIST for this allowlist to mean anything.
 *
 * 🛑 A UNION, NOT A DERIVATION, AND THE EXTRA ENTRIES ARE THE POINT. `Write`
 * and `Edit` are never allowlisted bare — only under `Edit(<glob>)` scopes —
 * but they must exist or the scopes have nothing to permit. Deriving this
 * from `allowed` alone would silently drop them and the agent could not edit
 * anything.
 *
 * Everything an allowlist entry names is still included, so a `Bash(git ...)`
 * entry cannot end up without `Bash`.
 */
export function availableBuiltins(allowed: readonly string[]): string[] {
  return [...new Set([...AVAILABLE_BUILTINS, ...builtinsFrom(allowed)])];
}

/**
 * The handle a supervised child registers under, derived from the supervisor's.
 *
 * Derived rather than configured so the two can never be made equal by
 * forgetting a flag.
 */
export function childHandleFor(supervisorHandle: string): string {
  return `${supervisorHandle}-agent`;
}
