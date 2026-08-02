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
  description: string;
  scopes: readonly string[];
  defaultScope: string;
  install(opts: AdapterInstallOptions): Promise<AdapterResult>;
  uninstall(opts: AdapterInstallOptions): Promise<AdapterResult>;
}
