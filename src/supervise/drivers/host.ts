import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { AgentChild, SpawnOptions } from "../child.js";
import type { VendorSpawn } from "../vendor.js";
import {
  assertDeclaresProcessLifetime,
  assertHostGrantReachesBus,
  wireAgentChild,
} from "./wiring.js";
import { wirePerTurnChild } from "./per-turn.js";
import { approveHostGrantServer, deliverHostGrantFile } from "./host-grant.js";
import { missingVendorTokenMessage, readVendorToken } from "../auth.js";

/** Spawn a vendor's CLI as a bare host process. */
export function spawnOnHost(
  vendor: VendorSpawn,
  opts: SpawnOptions = {},
): AgentChild {
  assertDeclaresProcessLifetime(vendor);
  // 🛑 BEFORE THE SPAWN, BECAUSE THE SPAWN IS THE FAILURE. A granted child
  // whose CLI cannot be pointed at the config starts cleanly and answers
  // nothing, so there is no later point at which this is still detectable.
  assertHostGrantReachesBus(vendor, opts.grant);

  // 🛑 THE CREDENTIAL, BEFORE ANYTHING IS WRITTEN OR APPROVED. A host child
  // was never given its API key: `spawn` passed `cwd` and `stdio` and no
  // `env`, so it inherited a `process.env` the token has never been in — the
  // store is a file under the state dir. The child exited code 1 after the
  // prompt was already delivered, and the operator saw a clean start. #396.
  //
  // 🛑 IT REFUSES RATHER THAN STARTING, RULED BY lee 2026-11-22. The prompt is
  // lost either way, and only the refusal names the cause; a clean start that
  // answers nothing is indistinguishable from #348 and from a model that chose
  // not to reply.
  //
  // ⚠️ BEFORE THE GRANT BLOCK, NOT AFTER. A refusal that came later would
  // leave `.cursor/mcp.json` in the operator's project directory for a child
  // that never ran.
  const token = readVendorToken(vendor);

  if (!token) {
    throw new Error(missingVendorTokenMessage(vendor));
  }

  // 🛑 THE DELIVERY ITSELF, FOR A CLI WITH NO CONFIG-PATH FLAG. The guard
  // above only refuses `"none"`; `"file"` passes it by not being that, so
  // this call is the difference between a declaration and a wired child.
  //
  // ⚠️ THE CWD DEFAULT IS THE CHILD'S, VIA `opts.cwd`, AND `spawn` BELOW USES
  // THE SAME ONE. A second expression of "where the child runs" would let the
  // file land in a directory the agent never opens.
  if (vendor.hostGrantDelivery === "file" && opts.grant) {
    const cwd = opts.cwd ?? process.cwd();

    deliverHostGrantFile(vendor, opts.grant, cwd);

    // 🛑 SEEN IS NOT LOADED, AND THE WRITE ONLY BUYS SEEN. Without this the
    // granted child has no `send`, and #348's silence returns with an extra
    // file in the project.
    //
    // ⚠️ THE SAME `cwd` AS THE WRITE AND AS `spawn` BELOW. The approval is
    // recorded per project directory, so a second expression of "where the
    // child runs" would approve one directory and start the child in another.
    approveHostGrantServer(vendor, cwd);
  }

  const launch = (turnOpts: SpawnOptions): ChildProcessWithoutNullStreams =>
    spawn(turnOpts.binary ?? vendor.binary, vendor.argsFor(turnOpts, "host"), {
      cwd: turnOpts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      // 🛑 THIS VENDOR'S OWN CREDENTIAL, UNDER ITS OWN NAME. One shared token
      // injected under whatever name a vendor declared sent a Claude
      // subscription credential to Cursor's servers, #347 — so the name and
      // the value come from the same vendor.
      //
      // 🛑 IN THE CHILD'S ENVIRONMENT, NEVER IN ARGV. `ps` exposes an argv for
      // the life of the process, which AGENTS.md forbids for a secret.
      //
      // ⚠️ NOT WRITTEN INTO `process.env`. That would reach every later child
      // of every vendor, which is #347 arriving by a second route.
      env: { ...process.env, [vendor.authEnvVar]: token },
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
