import { claudeSpawn } from '../../src/adapters/claude-spawn.js';
import type { SupervisorOptions } from '../../src/supervise/index.js';
import type { VendorSpawn } from '../../src/supervise/vendor.js';

/**
 * `SupervisorOptions` with `vendor` filled in, for a test that does not care
 * which vendor it is.
 *
 * 🛑 `vendor` STAYS REQUIRED IN PRODUCTION. It is resolved by the caller and
 * there is no runtime default, so loosening the production type to quiet a
 * test would move the defect into production. lee ruled this is a test-side
 * factory for exactly that reason.
 *
 * 🛑 IT DEFAULTS ONE FIELD. `handle` and the rest stay the caller's, so a test
 * that forgets one is still a compile error rather than a pass against a
 * default it never chose.
 */
export function supervisorOptions(
  overrides: Omit<SupervisorOptions, 'vendor'> & { readonly vendor?: VendorSpawn },
): SupervisorOptions {
  // `??` rather than a spread order, so an explicit `vendor: undefined` cannot
  // make the return type a lie.
  return { ...overrides, vendor: overrides.vendor ?? claudeSpawn };
}
