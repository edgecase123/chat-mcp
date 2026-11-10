import type { VendorSpawn } from '../supervise/vendor.js';

export interface AdapterInstallOptions {
  handle: string;
  scope?: string;
  cwd?: string;
  force?: boolean;
  /**
   * Total context-window size for this agent's model, used by adapters
   * that generate hook scripts calling `chat-mcp report-context`. Adapters
   * that don't consume this ignore it; adapters that require it should
   * throw a clear error on missing value.
   */
  contextTotal?: number;
}

export interface AdapterResult {
  changed: boolean;
  paths: string[];
  message: string;
}

export interface Adapter {
  name: string;
  /** Which CLI this adapter is for. Several adapters may share one vendor. */
  vendor: string;
  description: string;
  scopes: readonly string[];
  defaultScope: string;
  install(opts: AdapterInstallOptions): Promise<AdapterResult>;
  uninstall(opts: AdapterInstallOptions): Promise<AdapterResult>;
  /**
   * How to spawn this vendor's CLI. Present on at most ONE adapter per
   * vendor, asserted by `test/adapters/spawn-contract.test.ts`. A wake-only
   * adapter omits it.
   *
   * 🛑 DEFINED IN `supervise/vendor.ts`, NOT HERE, so that the generic
   * spawners can read it without `supervise/` importing `adapters/`.
   */
  spawn?: VendorSpawn;
}
