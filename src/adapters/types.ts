import type { SpawnOptions } from '../supervise/child.js';
import type { ChildGrant } from '../supervise/grant.js';
import type { Denial } from '../supervise/denial.js';
import type { RateLimitSnapshot } from '../supervise/rate-limit.js';
import type { RedispatchInput } from '../supervise/drivers/claude-redispatch.js';

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

/** Where a supervised child runs. */
export type SandboxMode = 'host' | 'docker';

/**
 * Map ONE parsed CLI event onto the supervisor's semantic callbacks.
 *
 * Each vendor writes its own. `routeClaudeEvent` is the Claude Code one.
 */
export type EventRouter = (
  event: Record<string, unknown>,
  on: {
    turnEnd(): void;
    usage(snapshot: RateLimitSnapshot): void;
    denial?(denial: Denial): void;
    session?(id: string): void;
  },
) => void;

/**
 * Everything the supervisor needs in order to spawn one vendor's CLI, in
 * either sandbox mode.
 *
 * 🛑 `argsFor` TAKES THE MODE because the two flag sets are mutually
 * exclusive. The host path passes `--permission-mode` and `--allowedTools`;
 * the container path passes `--allow-dangerously-skip-permissions` and
 * neither of those, because the container boundary is the gate. A vendor owns
 * both sets, so no generic spawner has to know either.
 */
export interface VendorSpawn {
  readonly binary: string;
  readonly image: string;
  /**
   * The container's `HOME`. The bus resolves its state dir from it, so an
   * image whose HOME differs from this value loses the bus silently.
   */
  readonly containerHome: string;
  readonly authEnvVar: string;

  readonly argsFor: (opts: SpawnOptions, mode: SandboxMode) => string[];
  /** The config path to point the CLI at, written first if the mode needs it. */
  readonly mcpConfigFor: (grant: ChildGrant, mode: SandboxMode) => string;
  readonly routeEvent: EventRouter;
  readonly encodeInput: (text: string) => string;
  readonly redispatchPrompt: (input: RedispatchInput) => string;
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
   * Present on at most ONE adapter per vendor, asserted by
   * `test/adapters/spawn-contract.test.ts`. A wake-only adapter omits it.
   */
  spawn?: VendorSpawn;
}
