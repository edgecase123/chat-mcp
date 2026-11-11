import type { SandboxMode } from '../vendor.js';

/**
 * How a CLI name and a `--container` flag become a (vendor, mode) pair.
 *
 * 🛑 SANDBOX MODE IS AN AXIS, NOT A VENDOR. `docker-claude` used to be a
 * sibling of `claude` in a driver registry, so a second CLI meant two entries
 * and a pairing nobody could see. It is now an alias over (vendor, mode),
 * which is also why the confirm gate can read `mode === 'docker'` instead of
 * matching a driver-name string a new vendor would spell differently.
 *
 * 🛑 THIS FILE RESOLVES A NAME TO A (vendor, mode) PAIR AND NOTHING ELSE. It
 * does NOT resolve `vendor` to a `VendorSpawn` — that needs `adapters/`'s
 * `spawnFor`, and `supervise/` never imports `adapters/` (the layering rule
 * `test/adapters/spawn-contract.test.ts` guards). The caller that already
 * imports both (`src/index.ts`, or `supervise/index.ts` via an injected
 * `opts.vendor`) does that resolution.
 */
const ALIASES: Record<string, { vendor: string; mode: SandboxMode }> = {
  claude: { vendor: 'claude', mode: 'host' },
  'docker-claude': { vendor: 'claude', mode: 'docker' },
};

const DEFAULT_VENDOR = 'claude';

export interface DriverSelection {
  readonly vendor: string;
  readonly mode: SandboxMode;
}

export function resolveDriver(o: { driver?: string; container?: boolean }): DriverSelection {
  const mode: SandboxMode = o.container ? 'docker' : 'host';

  if (!o.driver) return { vendor: DEFAULT_VENDOR, mode };

  const alias = ALIASES[o.driver];
  // An alias names its own mode. `--container` can only tighten it, never
  // loosen it, so an explicit `--driver docker-claude` stays containerized.
  if (alias) return { vendor: alias.vendor, mode: alias.mode === 'docker' ? 'docker' : mode };

  return { vendor: o.driver, mode };
}
