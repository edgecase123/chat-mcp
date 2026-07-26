export interface AdapterInstallOptions {
  handle: string;
  scope?: string;
  cwd?: string;
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
