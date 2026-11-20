import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentChild, SpawnOptions } from "../child.js";
import type { VendorSpawn } from "../vendor.js";
import { assertDeclaresProcessLifetime, wireAgentChild } from "./wiring.js";
import { wirePerTurnChild } from "./per-turn.js";

/** Spawn a vendor's CLI as a bare host process. */
export function spawnOnHost(
  vendor: VendorSpawn,
  opts: SpawnOptions = {},
): AgentChild {
  assertDeclaresProcessLifetime(vendor);

  const launch = (turnOpts: SpawnOptions): ChildProcessWithoutNullStreams =>
    spawn(turnOpts.binary ?? vendor.binary, vendor.argsFor(turnOpts, "host"), {
      cwd: turnOpts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

  if (vendor.processPerTurn) {
    return wirePerTurnChild(
      ({ resumeSessionId }) =>
        launch({
          ...opts,
          // 🛑 THE LAST TURN'S ID WINS, AND THE FALLBACK IS NOT DEAD CODE. On
          // turn one no result has arrived, so the only id available is the
          // one a restart was asked to resume — and dropping it there is how
          // a restarted agent loses the task it was working on.
          resumeSessionId: resumeSessionId ?? opts.resumeSessionId,
        }),
      vendor,
    );
  }

  return wireAgentChild(launch(opts), vendor);
}
