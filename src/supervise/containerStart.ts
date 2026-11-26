import type * as Container from "./container.js";
import type * as ConfirmPlan from "./confirmPlan.js";
import type { VendorSpawn } from "./vendor.js";

/**
 * Everything the containerized start sequence does to the OUTSIDE: it prints,
 * it reads a terminal, and it compiles.
 *
 * 🛑 `compile` IS PASSED ON TO `prepareAgentImage`, NEVER CALLED HERE. That
 * function decides whether a build is needed at all, and a caller that ran the
 * compile itself would pay for it on every start.
 */
export interface ContainerStartIo {
  readonly log: (line: string) => void;
  readonly isTty: () => boolean;
  readonly ask: (question: string) => Promise<string>;
  readonly compile: () => void;
}

/**
 * The collaborators this sequence wires together.
 *
 * 🛑 EACH FIELD IS `typeof` THE REAL FUNCTION, so a test fake cannot drift
 * from the signature it stands in for and `typecheck` catches it.
 */
export interface ContainerStartDeps {
  readonly buildConfirmPlan: typeof ConfirmPlan.buildConfirmPlan;
  readonly confirmVerdict: typeof Container.confirmVerdict;
  readonly markConfirmed: typeof Container.markConfirmed;
  readonly describePlan: typeof Container.describePlan;
  readonly describeChanges: typeof Container.describeChanges;
  readonly prepareAgentImage: typeof Container.prepareAgentImage;
}

/**
 * `aborted` means the operator declined at the prompt, and the caller must not
 * go on to start the supervisor.
 */
export type ContainerStartOutcome = "confirmed" | "aborted";

/**
 * Confirm `handle`'s container plan with its operator, then make sure the
 * image it approved exists.
 *
 * 🛑 EXTRACTED SO A TEST CAN CALL IT (#359). Inline in the commander action in
 * `src/index.ts`, nothing could reach the ARGUMENTS this passes — and every
 * function it calls is well tested on its own, which is exactly what made the
 * gap invisible. PR 354 and PR 358 both hit it and both deferred it.
 *
 * ⚠️ IT DOES NOT DECIDE WHETHER TO RUN. The caller keys that on the resolved
 * `selection.mode`, never on the `--container` flag: `--driver docker-claude`
 * is containerized without the flag.
 */
export async function prepareContainerStart(
  vendor: VendorSpawn,
  handle: string,
  io: ContainerStartIo,
  deps: ContainerStartDeps,
): Promise<ContainerStartOutcome> {
  // 🛑 CONSENT BEFORE THE BUILD. The build is minutes of docker, and spending
  // it before asking leaves an operator who answers "n" having paid for an
  // image they refused.
  const plan = deps.buildConfirmPlan(vendor, handle);
  const verdict = deps.confirmVerdict(handle, plan);

  if (verdict.kind !== "confirmed") {
    // 🛑 THE RE-PROMPT NAMES WHAT CHANGED. "the plan changed, approve it
    // again" makes the operator diff two banners by eye, and the field that
    // matters is the one they are least likely to spot.
    if (verdict.kind === "changed") {
      io.log(
        `the container plan for "${handle}" changed since you approved it:`,
      );
      io.log(deps.describeChanges(verdict.changes));
      io.log("");
    }
    if (verdict.kind === "legacy") {
      io.log(
        `"${handle}" was approved before the plan was recorded, so there ` +
          "is nothing to compare it against. Approving it again records it.",
      );
    }

    io.log(deps.describePlan(plan));

    // 🛑 REFUSES RATHER THAN READING EOF AS "no". `rl.question` resolves to
    // `''` with no terminal attached, which failed the `y` test and took the
    // abort path below — printing one word and exiting 0. A scripted start of
    // a new containerized agent reported success and started nothing.
    if (!io.isTty()) {
      throw new Error(
        `the container plan for "${handle}" needs a terminal to confirm, ` +
          `and this process has no stdin. Run this same command once from ` +
          `a terminal and answer the prompt, then start it from a script.`,
      );
    }

    const answer = await io.ask("Proceed? [y/N] ");
    if (!/^y(es)?$/i.test(answer.trim())) {
      io.log("aborted");
      return "aborted";
    }
    deps.markConfirmed(handle, plan);
  }

  // 🛑 THE PLAN'S IMAGE, SO THE BUILD AND THE LATER INSPECT AGREE.
  // `buildConfirmPlan` resolved it through `effectiveImage`, which is also
  // what `runDependencyInstall` inspects. Passing `vendor.image` here, or
  // resolving the override a second time, is how a handle came to pay for a
  // full build of an image it would then be refused for.
  // 🛑 THE VENDOR IS NAMED ONLY WHEN THE PLAN RUNS THE VENDOR'S OWN IMAGE. An
  // operator override resolves to a tag this project cannot build, and naming
  // a vendor for it would tag a build of THIS project with somebody else's
  // image name.
  deps.prepareAgentImage(io.compile, {
    image: plan.image,
    ...(plan.image === vendor.image ? { buildVendor: vendor.vendor } : {}),
  });

  return "confirmed";
}
