import { execSync } from "node:child_process";
import {
  imageNeedsBuild,
  prepareAgentImage,
} from "../../src/supervise/container.ts";

/**
 * Build the image this acceptance run is about to test, then PROVE it is current.
 *
 * 🛑 AN ACCEPTANCE SCRIPT REACHES `startSupervisor` DIRECTLY, AND NOTHING ON
 * THAT PATH BUILDS AN IMAGE. `prepareAgentImage` has exactly one production
 * caller, `src/index.ts`, so a run started from a script tested whatever image
 * was last on the disk. Measured 2026-11-22: a 4/4 green against a
 * `chat-mcp-cursor-agent:local` built the previous evening, with no
 * `builtHashes` entry for that tag at all.
 *
 * 🛑 THE RECORDED CHECK IS THE POINT, NOT THE BUILD. A build that silently
 * does nothing leaves the same false green, so staleness has to FAIL a named
 * check rather than be absent from the log.
 *
 * `plan.image` rather than `vendor.image`, so the build and the later inspect
 * agree on an operator override — the same pairing `src/index.ts` makes.
 */
export function ensureFreshVendorImage(plan, vendor, record) {
  prepareAgentImage(() => execSync("npm run build", { stdio: "inherit" }), {
    image: plan.image,
    ...(plan.image === vendor.image ? { buildVendor: vendor.vendor } : {}),
  });

  record(
    "🛑 the image under test is NOT older than the code under test",
    !imageNeedsBuild(undefined, plan.image),
    plan.image,
  );
}
