import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_VENDORS,
  dockerfileText,
  stageDirectives,
} from "../support/dockerfile-stages.js";

/**
 * #212: a containerized agent could not run ANY git command in the repo it was
 * given. The bind mount appears inside the container as `uid=0` while the
 * process is `uid=10001(agent)`, so git refused the repository.
 *
 * 🛑 lee RULED `safe.directory = *` ON 2026-11-14, over an enumerated list.
 * Enumeration cannot work from the Dockerfile: extra mounts come from
 * `mounts.json` at RUNTIME, so build time does not know their `/mnt/<key>`
 * paths and any fixed list is incomplete by construction. Do not "tighten"
 * this to a list — narrow it in the SUPERVISOR instead, which knows the mounts.
 *
 * ⚠️ WHAT THESE PROVE. They read the Dockerfile, so they prove the instruction
 * has not been deleted or reordered. They do NOT prove the built image behaves
 * — only a real `docker build` plus a `git` call inside it does that, and that
 * is recorded in the PR body, because the suite must not need a docker daemon.
 *
 * 🛑 ONCE PER VENDOR, OVER THAT VENDOR'S LINEAGE, AND THAT IS NOT THOROUGHNESS.
 * #317 made the image multi-stage. An earlier cut of this file indexed the
 * Dockerfile's LINES, and moving this instruction out of `base` into
 * `cli-cursor` alone — leaving the default claude image with no safe.directory
 * at all — passed 3 of 3. Measured, 2026-11-21.
 */

const DOCKERFILE = dockerfileText();

for (const vendor of AGENT_VENDORS) {
  /** The directives this vendor's build actually runs, in build order. */
  const DIRECTIVES = stageDirectives(DOCKERFILE, vendor);

  /** Comments are already stripped and `\`-continuations already joined. */
  const LOGICAL = DIRECTIVES.join("\n");

  test(`🛑 [${vendor}] the image trusts every directory for git, which is what lets an agent commit`, () => {
    assert.match(
      LOGICAL,
      /git\s+config\s+--system\s+(--add\s+)?safe\.directory\s+['"]?\*['"]?/,
      "without this, every git command in /work fails: dubious ownership",
    );
  });

  /**
   * 🛑 THE ORDERING IS THE GUARD, NOT THE PRESENCE. `git config --system` writes
   * `/etc/gitconfig`, which needs root. Placed after `USER agent` the instruction
   * is still present, still looks right in review, and the BUILD FAILS — or
   * worse, writes nothing useful. A reader reordering the Dockerfile has no other
   * signal that this line is position-dependent.
   */
  test(`🛑 [${vendor}] it is set BEFORE \`USER agent\`, because --system needs root`, () => {
    const safeAt = DIRECTIVES.findIndex((d) => /safe\.directory/.test(d));
    const userAt = DIRECTIVES.findIndex((d) => /^\s*USER\s+agent\b/.test(d));

    assert.notEqual(safeAt, -1, "no safe.directory instruction found at all");
    assert.notEqual(
      userAt,
      -1,
      "no `USER agent` line found — has the image stopped dropping root?",
    );
    assert.ok(
      safeAt < userAt,
      `safe.directory is directive ${safeAt + 1} and USER agent is ${userAt + 1}; --system cannot be written as a non-root user`,
    );
  });

  /**
   * ⚠️ CONTROL, AND IT IS NOT DECORATION. The image must still drop root. A fix
   * for #212 that ran the agent as root would make git work and silently undo the
   * thing the container is for.
   */
  test(`⚠️ [${vendor}] control — the image still drops to a non-root user`, () => {
    assert.match(
      LOGICAL,
      /^\s*USER\s+agent\b/m,
      "the agent must not run as root",
    );
    assert.doesNotMatch(
      LOGICAL.split("USER agent")[1] ?? "",
      /^\s*USER\s+root\b/m,
      "nothing may switch back to root after dropping privileges",
    );
  });
}
