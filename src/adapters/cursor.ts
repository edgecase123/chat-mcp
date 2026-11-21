import type { Adapter, AdapterInstallOptions, AdapterResult } from "./types.js";
import { cursorSpawn } from "./cursor-spawn.js";

const ADAPTER_NAME = "cursor";

/**
 * Cursor as a SPAWNABLE vendor, not yet an installable framework.
 *
 * 🛑 `spawnFor("cursor")` NEEDS AN ADAPTER TO HANG THE SPAWN BLOCK ON, which
 * is the only reason this file exists. The wake-adapter half — writing the
 * hooks that let a Cursor session be woken by an inbound message — is NOT
 * built.
 *
 * ⚠️ `install` AND `uninstall` THROW RATHER THAN NO-OP. A no-op returning
 * `changed: false` reads as "already installed", and the operator would wire a
 * handle that can never be woken. Failing names the gap instead.
 */
function notInstallable(): Promise<AdapterResult> {
  return Promise.reject(
    new Error(
      `the "${ADAPTER_NAME}" adapter can spawn this CLI but cannot install its wake hooks yet; ` +
        `supervise a Cursor handle with --driver cursor instead`,
    ),
  );
}

export const cursorAdapter: Adapter = {
  name: ADAPTER_NAME,
  vendor: "cursor",
  description:
    "Cursor CLI (cursor-agent) — supervised spawn only; wake hooks not implemented",
  scopes: ["project"],
  defaultScope: "project",

  install: (_opts: AdapterInstallOptions): Promise<AdapterResult> =>
    notInstallable(),
  uninstall: (_opts: AdapterInstallOptions): Promise<AdapterResult> =>
    notInstallable(),

  spawn: cursorSpawn,
};
