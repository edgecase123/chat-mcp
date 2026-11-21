import { test } from "node:test";
import assert from "node:assert/strict";

import { vendorsWithSpawn } from "../../src/adapters/index.js";
import {
  AGENT_VENDORS,
  dockerfileText,
  stageDirectives,
  stageLineage,
} from "../support/dockerfile-stages.js";

/**
 * #317: one Dockerfile builds two images, selected by `--build-arg
 * AGENT_VENDOR=`. These pin the vendor switch itself — the things that make the
 * second image exist at all, and that no other suite would notice losing.
 *
 * ⚠️ WHAT THESE PROVE. They read the Dockerfile. The images were both BUILT on
 * 2026-11-21 and the binaries run inside them; that evidence is in the PR body,
 * because the suite must not need a docker daemon.
 */

const DOCKERFILE = dockerfileText();

/**
 * 🛑 BEFORE THE FIRST `FROM`, OR THE DYNAMIC BASE RESOLVES TO NOTHING. Docker
 * scopes an `ARG` declared inside a stage to that stage, so `ARG AGENT_VENDOR`
 * written below the first `FROM` leaves `FROM cli-${AGENT_VENDOR}` interpolating
 * an empty string. The build then fails on a base image named `cli-`, which is
 * loud — but only for whoever builds. Nothing else here would catch the move.
 */
test("🛑 AGENT_VENDOR is declared above the first FROM, where a dynamic base can read it", () => {
  const firstFrom = DOCKERFILE.split("\n").findIndex((l) => /^FROM\b/i.test(l));
  const argAt = DOCKERFILE.split("\n").findIndex((l) =>
    /^ARG\s+AGENT_VENDOR\b/.test(l),
  );

  assert.notEqual(argAt, -1, "no global `ARG AGENT_VENDOR` declaration at all");
  assert.notEqual(firstFrom, -1, "no FROM instruction at all");
  assert.ok(
    argAt < firstFrom,
    `ARG AGENT_VENDOR is on line ${argAt + 1} and the first FROM on line ${firstFrom + 1}; an ARG inside a stage is scoped to that stage`,
  );
});

/**
 * 🛑 THE DEFAULT IS `claude`, AND IT IS A COMPATIBILITY CONTRACT. `buildImage`
 * runs a bare `docker build` with no `--build-arg`, so every existing caller
 * gets the claude image only while this default holds.
 */
test("🛑 the default vendor is claude, because a bare `docker build` must still produce the claude image", () => {
  assert.match(DOCKERFILE, /^ARG\s+AGENT_VENDOR=claude\s*$/m);
});

/**
 * 🛑 THE SWITCH MUST STAY LOAD-BEARING. A refactor that pointed the final stage
 * at `cli-claude` directly would leave every per-vendor assertion in the other
 * suites running twice over one image, all green, with the cursor image gone.
 */
test("🛑 the final stage's base interpolates AGENT_VENDOR, so the two lineages really differ", () => {
  const lineages = AGENT_VENDORS.map((v) => stageLineage(DOCKERFILE, v));

  assert.match(DOCKERFILE, /^FROM\s+cli-\$\{AGENT_VENDOR\}\s/m);
  assert.notDeepEqual(
    lineages[0],
    lineages[1],
    `both vendors reach the same stages (${lineages[0]!.join(" -> ")}); the vendor arg selects nothing`,
  );
});

/**
 * 🛑 ONE CLI PER IMAGE, AND THE ABSENCE IS THE POINT. Both installs landing in
 * the shared base would build, run, and pass every other test in this repo —
 * while shipping a 175 MB Cursor bundle inside the claude image and handing
 * each vendor's adapter a binary it must not use.
 */
const VENDOR_CLI: Record<string, RegExp> = {
  claude: /npm\s+install\s+-g\s+@anthropic-ai\/claude-code\b/,
  cursor: /agent-cli-package\.tar\.gz/,
};

/**
 * 🛑 THE DOCKERFILE'S VENDOR STAGES ARE THE PRODUCT'S SPAWNABLE VENDORS, AND
 * THE EQUALITY IS WHAT CLOSES THE QUIET DIRECTION. `AGENT_VENDORS` is derived
 * from the `cli-*` stages, so a stage added here is asserted on automatically —
 * but a vendor added to `src/adapters/index.ts` with no stage would simply not
 * be mentioned, and three suites would go on reporting green for two images
 * while the product had three.
 *
 * 🛑 `vendorsWithSpawn()` IS THE RIGHT SIDE TO COMPARE, because `VendorSpawn`
 * declares an `image` unconditionally. Every vendor this build can spawn names
 * a container image, so every one of them needs a stage that builds it.
 */
test("🛑 the Dockerfile's vendor stages are exactly the vendors this build can spawn", () => {
  assert.deepEqual(
    [...AGENT_VENDORS].sort(),
    [...vendorsWithSpawn()].sort(),
    "the Dockerfile's `cli-*` stages and `vendorsWithSpawn()` disagree; one of the two lists gained a vendor the other did not",
  );
});

/**
 * ⚠️ AND EVERY VENDOR NEEDS AN ENTRY IN `VENDOR_CLI` ABOVE, or the exclusivity
 * test below would match `undefined` and pass vacuously for the new vendor.
 */
test("⚠️ control — every vendor has a CLI pattern, so the exclusivity test cannot pass vacuously", () => {
  for (const vendor of AGENT_VENDORS) {
    assert.ok(
      VENDOR_CLI[vendor] instanceof RegExp,
      `no VENDOR_CLI pattern for "${vendor}"; add one or its image is asserted on by nothing`,
    );
  }
});

for (const vendor of AGENT_VENDORS) {
  test(`🛑 [${vendor}] the build installs its OWN CLI and NOT the other vendor's`, () => {
    const directives = stageDirectives(DOCKERFILE, vendor).join("\n");

    assert.match(
      directives,
      VENDOR_CLI[vendor]!,
      `the ${vendor} image installs no ${vendor} CLI`,
    );

    for (const other of AGENT_VENDORS) {
      if (other === vendor) continue;

      assert.doesNotMatch(
        directives,
        VENDOR_CLI[other]!,
        `the ${vendor} image also installs the ${other} CLI; the vendor stages are not exclusive`,
      );
    }
  });
}

/**
 * 🛑 BOTH ARCHES, BECAUSE THERE IS NO `--platform` IN THIS FILE. The image
 * follows the build host, so a single pinned digest breaks every build on the
 * other architecture — and the tempting fix is to drop the verification rather
 * than add the second hash.
 */
test("🛑 the cursor tarball is pinned for both architectures, and verified before use", () => {
  const cursor = stageDirectives(DOCKERFILE, "cursor").join("\n");

  assert.match(cursor, /sha256sum\s+-c\s+-/, "the tarball is not verified");

  const digests = DOCKERFILE.match(
    /^ARG\s+CURSOR_SHA256_(ARM64|AMD64)=[0-9a-f]{64}\s*$/gm,
  );

  assert.equal(
    digests?.length,
    2,
    `expected one pinned sha256 per architecture, found ${digests?.length ?? 0}`,
  );
});

/**
 * 🔴 ROOT-OWNED, AND THE CHOWNS ARE WHY THIS IS A TEST. `cursor-agent` checks
 * for updates with no documented opt-out — all 226 `CURSOR_` and `AGENT_CLI_` vars in
 * the bundle were scanned on 2026-11-21 and the two update-related ones only
 * override the check URL and the reported version string. So the pin describes
 * nothing unless `agent` cannot rewrite the install.
 *
 * 🛑 THE SHARED TAIL CHOWNS `/root` WHOLESALE, TWICE. An install under
 * `/root/.local` — which is where Cursor's own installer puts it — is inside
 * that, so it would be handed to `agent` with nothing failing and no log line.
 */
test("🔴 the cursor CLI is installed outside every path the shared tail chowns to agent", () => {
  const directives = stageDirectives(DOCKERFILE, "cursor");
  const extractTo = directives.find((d) => /tar\s+-xzf/.test(d));

  assert.ok(extractTo, "no tar extraction found in the cursor stage");

  const target = /-C\s+(\S+)/.exec(extractTo)?.[1];

  assert.ok(target, `no -C target in: ${extractTo}`);

  const chowned = directives
    .filter((d) => /chown\s+(-R\s+)?agent:agent/.test(d))
    .flatMap((d) => d.match(/\s(\/\S+)/g) ?? [])
    .map((p) => p.trim());

  for (const path of chowned) {
    assert.ok(
      !target.startsWith(path.endsWith("/") ? path : `${path}/`) &&
        target !== path,
      `the cursor CLI is extracted to ${target}, which \`chown -R agent:agent ${path}\` hands to the agent user — a self-update can then replace the pinned binary`,
    );
  }
});
