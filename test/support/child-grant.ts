import type { ChildGrant } from "../../src/supervise/grant.js";

/**
 * A `ChildGrant` for a test that cares about the handle and the config path
 * and not about the tool surface.
 *
 * 🛑 THE PRODUCTION TYPE STAYS FULLY REQUIRED. Six containerized-driver tests
 * passed `{ handle, configPath, tools: [] }`, where `tools` is not a field of
 * `ChildGrant` and the three real list fields were absent. Loosening
 * `ChildGrant` to accept that would move the gap into production.
 *
 * ⚠️ IT DEFAULTS THE THREE LIST FIELDS TO EMPTY, AND EMPTY IS NOT WHAT
 * PRODUCTION PASSES. A test that asserts on `--allowedTools`, `--tools` or
 * `--add-dir` must name the field it is asserting about. The docker path
 * reads neither — only `grant.configPath` and whether a grant exists at all.
 */
export function childGrant(
  overrides: Pick<ChildGrant, "handle" | "configPath"> & Partial<ChildGrant>,
): ChildGrant {
  return { allowed: [], available: [], extraDirs: [], ...overrides };
}
