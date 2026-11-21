/**
 * Reading `Dockerfile` as the SELECTED BUILD, not as text.
 *
 * #317 made the image multi-stage: one `base`, one stage per agent vendor, and
 * a final stage whose own base is `cli-${AGENT_VENDOR}`. Three test files
 * asserted ordering with `findIndex` over the file's lines, and that stopped
 * being sound the moment stages existed.
 *
 * 🛑 MEASURED, NOT REASONED. Moving `git config --system --add safe.directory`
 * out of `base` and into `cli-cursor` alone leaves the default (claude) image
 * with no safe.directory at all, which is #212 returning — and 3 of 3 of
 * `dockerfile-safe-directory.test.ts`'s assertions still passed. The line was
 * present, and textually above `USER agent`, so every index comparison held.
 *
 * So a Dockerfile assertion has to ask two questions text cannot answer:
 *
 *   1. is this instruction in a stage the build actually REACHES?
 *   2. does it run BEFORE that one, in build order rather than file order?
 *
 * `stageDirectives` answers both by flattening one vendor's lineage.
 *
 * 🛑 TEST INFRASTRUCTURE. Never import it from `src/`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every vendor the image can be built for.
 *
 * 🛑 EVERY ORDERING ASSERTION RUNS ONCE PER ENTRY. A vendor added here with no
 * matching `cli-<vendor>` stage fails loudly in `stageDirectives`, which is the
 * intended direction — the alternative is a vendor nothing asserts on.
 */
export const AGENT_VENDORS = ["claude", "cursor"] as const;

export type AgentVendor = (typeof AGENT_VENDORS)[number];

/** The repo's own Dockerfile, read from the working directory the suite runs in. */
export function dockerfileText(): string {
  return readFileSync(join(process.cwd(), "Dockerfile"), "utf8");
}

/**
 * 🛑 COMMENTS STRIPPED FIRST, AND THAT IS NOT TIDYING. The comment above each
 * instruction in this Dockerfile names every string these assertions look for,
 * so matching the raw bytes passes with the instruction deleted. That exact
 * vacuity shipped once — see `dockerfile-github-tooling.test.ts`.
 *
 * `\`-continuations are joined, so one directive is one string however it is
 * wrapped. Order WITHIN a joined chain is therefore invisible, which is why the
 * #242 assertion requires the chown to be its own directive.
 */
function directivesOf(dockerfile: string): string[] {
  return dockerfile
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\\\n\s*/g, " ")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

interface Stage {
  /** `AS <name>`, lowercased — docker treats stage names case-insensitively. */
  readonly name: string | null;
  /** The `FROM` argument, before any ARG substitution. */
  readonly base: string;
  readonly directives: string[];
}

const FROM = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?\s*$/i;

function parseStages(dockerfile: string): Stage[] {
  const stages: Stage[] = [];

  for (const directive of directivesOf(dockerfile)) {
    const from = FROM.exec(directive);

    if (from) {
      stages.push({
        name: from[2]?.toLowerCase() ?? null,
        base: from[1]!,
        directives: [],
      });
      continue;
    }

    // A directive before the first FROM is a global ARG. It declares the
    // variable the dynamic FROM below interpolates and runs in no stage.
    stages.at(-1)?.directives.push(directive);
  }

  return stages;
}

/**
 * The directives the build runs for `vendor`, ancestor stage first.
 *
 * 🛑 A STAGE THE LINEAGE DOES NOT REACH IS ABSENT FROM THE RESULT. That is the
 * whole point: `cli-cursor`'s instructions must not be able to satisfy an
 * assertion about the claude image.
 *
 * 🛑 THROWS RATHER THAN RETURNING A SHORT LIST. An unresolvable base means the
 * Dockerfile and `AGENT_VENDORS` disagree, and the failure mode of returning
 * what it could resolve is a suite that asserts over three directives and
 * passes.
 */
export function stageDirectives(
  dockerfile: string,
  vendor: AgentVendor,
): string[] {
  const stages = parseStages(dockerfile);
  const last = stages.at(-1);

  if (!last) throw new Error("Dockerfile declares no FROM at all");

  const byName = new Map(
    stages.flatMap((stage) =>
      stage.name ? [[stage.name, stage] as const] : [],
    ),
  );

  const lineage: Stage[] = [];
  let current: Stage | undefined = last;

  while (current) {
    lineage.unshift(current);

    const base = current.base
      .replace(/\$\{AGENT_VENDOR\}/g, vendor)
      .replace(/\$AGENT_VENDOR\b/g, vendor)
      .toLowerCase();

    // 🛑 AN UNRESOLVED `$` IS A BASE THIS HELPER CANNOT REASON ABOUT, not an
    // external image. Treating it as one would silently truncate the lineage
    // at the dynamic FROM — the single most important edge in the file.
    if (base.includes("$")) {
      throw new Error(
        `Dockerfile stage base "${current.base}" interpolates a variable this ` +
          `helper does not substitute. Only AGENT_VENDOR is supported.`,
      );
    }

    if (lineage.length > stages.length) {
      throw new Error(`Dockerfile stage bases form a cycle at "${base}"`);
    }

    const next = byName.get(base);

    // 🛑 A SUBSTITUTED BASE THAT NAMES NO STAGE IS A MISSING VENDOR, NOT AN
    // EXTERNAL IMAGE. `FROM cli-${AGENT_VENDOR}` with a vendor nothing declares
    // would otherwise end the walk at `final`, and every assertion would then
    // run over `final`'s three directives and pass.
    if (!next && base !== current.base.toLowerCase()) {
      throw new Error(
        `Dockerfile declares no stage "${base}", so AGENT_VENDOR="${vendor}" ` +
          `builds nothing. Does \`cli-${vendor}\` exist?`,
      );
    }

    current = next;
  }

  return lineage.flatMap((stage) => stage.directives);
}

/**
 * The stage names the build for `vendor` passes through, ancestor first.
 * Exposed so a test can assert the lineage DIFFERS between vendors — without
 * that, every per-vendor assertion could be running twice over one image.
 */
export function stageLineage(
  dockerfile: string,
  vendor: AgentVendor,
): string[] {
  const stages = parseStages(dockerfile);
  const reached = new Set(stageDirectives(dockerfile, vendor));

  return stages
    .filter((stage) => stage.directives.some((d) => reached.has(d)))
    .map((stage) => stage.name ?? "(unnamed)");
}
