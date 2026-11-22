import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  imageNeedsBuild,
  prepareAgentImage,
} from "../../src/supervise/container.ts";

/** The repo root, so the compile does not depend on how the script was invoked. */
const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Build the image an acceptance run is about to test, and say which of the two
 * things happened.
 *
 * 🛑 AN ACCEPTANCE SCRIPT REACHES `startSupervisor` DIRECTLY, AND NOTHING ON
 * THAT PATH BUILDS AN IMAGE. `prepareAgentImage` has one production caller,
 * `src/index.ts`, so a run started from a script tested whatever image was
 * last on the disk. Measured: 4/4 green against an image built the previous
 * evening, with no `builtHashes` entry for that tag at all.
 *
 * 🛑 THE `wasStale` LOG LINE IS WHAT A READER OF A GREEN RUN NEEDS, NOT THE
 * ASSERT. After a successful build the assert cannot fail, because
 * `buildImage` writes the very hash it then compares. Its one discriminating
 * case is the operator-override early return, where no build happens at all.
 * claude1's 🟡 on PR 408.
 *
 * `plan.image` rather than `vendor.image`, so the build and the later inspect
 * agree on an override — the same pairing `src/index.ts` makes.
 */
export function ensureFreshVendorImage(plan, vendor, record, deps = {}) {
  const needsBuild = deps.needsBuild ?? imageNeedsBuild;
  const prepare = deps.prepare ?? prepareAgentImage;
  const logLine = deps.logLine ?? ((line) => console.log(line));
  const compile =
    deps.compile ??
    (() => execSync("npm run build", { stdio: "inherit", cwd: REPO_ROOT }));

  const wasStale = needsBuild(deps.run, plan.image);

  prepare(compile, {
    image: plan.image,
    // 🛑 OMITTED, NOT undefined, FOR AN OVERRIDE. Its PRESENCE is what tells
    // `prepareAgentImage` the tag is one this project may build.
    ...(plan.image === vendor.image ? { buildVendor: vendor.vendor } : {}),
    ...(deps.run ? { run: deps.run } : {}),
    ...(deps.needsBuild ? { needsBuild } : {}),
    logLine,
  });

  logLine(
    wasStale
      ? `  ${plan.image} was STALE and was rebuilt`
      : `  ${plan.image} was already current`,
  );

  record(
    "🛑 the image under test is NOT older than the code under test",
    !needsBuild(deps.run, plan.image),
    plan.image,
  );
}
