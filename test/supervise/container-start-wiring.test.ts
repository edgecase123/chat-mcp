import { test } from "node:test";
import assert from "node:assert/strict";

import {
  prepareContainerStart,
  type ContainerStartDeps,
  type ContainerStartIo,
} from "../../src/supervise/containerStart.js";
import type {
  ConfirmVerdict,
  ContainerPlan,
} from "../../src/supervise/container.js";
import { claudeSpawn } from "../../src/adapters/claude-spawn.js";
import { containerPlan } from "../support/container-plan.js";

/**
 * #359 — the containerized start sequence used to live in the commander
 * action in `src/index.ts`, which runs the CLI as a side effect of being
 * imported, so no test could call it.
 *
 * 🛑 EVERY FUNCTION IT CALLS IS ALREADY TESTED IN ISOLATION. What nothing
 * tested is the ARGUMENTS it passes them, and a wrong argument there ships
 * green: `prepareAgentImage` handed `vendor.image` instead of `plan.image`
 * makes a handle pay for a build of an image it is then refused for.
 *
 * 🛑 A SOURCE-TEXT GREP OVER THE CALL SITE IS NOT AN INSTRUMENT. It greens on
 * a docblock written beside the call, which is how this gap survived PR 354
 * and PR 358. `confirmPlan.ts`'s own header says the same thing.
 *
 * ⚠️ THE COLLABORATORS ARE INJECTED, NOT `t.mock.module`'d. The mock reverts
 * with the test CONTEXT while the importer stays cached, so a second test in
 * one file meets an already-linked module — see the closing note in
 * `confirm-plan-floor-sourcing.test.ts`. Injection keeps these in one file.
 *
 * 🛑 EACH `deps` FIELD IS TYPED `typeof <the real function>`, so a signature
 * change breaks this file's COMPILE. That is what keeps the fakes honest, and
 * `typecheck` is a gate step.
 */

/** One recorded collaborator call, in the order it happened. */
interface Call {
  readonly name: string;
  readonly args: readonly unknown[];
}

interface Rig {
  readonly calls: readonly Call[];
  readonly io: ContainerStartIo;
  readonly deps: ContainerStartDeps;
  readonly plan: ContainerPlan;
}

/**
 * A `prepareContainerStart` under fakes that record every call.
 *
 * 🛑 `buildConfirmPlan` RETURNS ONE OBJECT AND THE TESTS COMPARE BY IDENTITY.
 * A structurally equal second plan would let a seam that rebuilt the plan
 * between the banner and the write pass, which is the drift the ticket names.
 */
function rig(
  opts: {
    verdict?: ConfirmVerdict;
    planImage?: string;
    answer?: string;
    isTty?: boolean;
  } = {},
): Rig {
  const calls: Call[] = [];
  const plan = containerPlan(
    opts.planImage === undefined ? {} : { image: opts.planImage },
  );
  const record = (name: string, args: readonly unknown[]): void => {
    calls.push({ name, args });
  };

  const io: ContainerStartIo = {
    log: (line) => record("log", [line]),
    isTty: () => opts.isTty ?? true,
    ask: async (question) => {
      record("ask", [question]);
      return opts.answer ?? "y";
    },
    compile: () => record("compile", []),
  };

  const deps: ContainerStartDeps = {
    buildConfirmPlan: (...args) => {
      record("buildConfirmPlan", args);
      return plan;
    },
    confirmVerdict: (...args) => {
      record("confirmVerdict", args);
      return opts.verdict ?? { kind: "unseen" };
    },
    markConfirmed: (...args) => record("markConfirmed", args),
    describePlan: (...args) => {
      record("describePlan", args);
      return "PLAN BANNER";
    },
    describeChanges: (...args) => {
      record("describeChanges", args);
      return "CHANGES";
    },
    prepareAgentImage: (...args) => record("prepareAgentImage", args),
  };

  return { calls, io, deps, plan };
}

/** The recorded call named `name`, asserting there was exactly one. */
function only(calls: readonly Call[], name: string): Call {
  const found = calls.filter((c) => c.name === name);
  assert.equal(found.length, 1, `expected exactly one ${name} call`);
  return found[0]!;
}

const names = (calls: readonly Call[]): string[] => calls.map((c) => c.name);

test("prepareAgentImage receives the PLAN's image, never the vendor's", async () => {
  const r = rig({ planImage: "operator/private:tag" });

  assert.equal(
    await prepareContainerStart(claudeSpawn, "a1", r.io, r.deps),
    "confirmed",
  );

  const call = only(r.calls, "prepareAgentImage");
  assert.equal(
    (call.args[1] as { image: string }).image,
    "operator/private:tag",
  );
  assert.notEqual(
    (call.args[1] as { image: string }).image,
    claudeSpawn.image,
    "an override's image must not be replaced by the vendor's",
  );
});

test("buildVendor is named ONLY when the plan runs the vendor's own image", async () => {
  const own = rig({ planImage: claudeSpawn.image });
  await prepareContainerStart(claudeSpawn, "a1", own.io, own.deps);
  assert.equal(
    (only(own.calls, "prepareAgentImage").args[1] as { buildVendor?: string })
      .buildVendor,
    claudeSpawn.vendor,
  );

  const override = rig({ planImage: "operator/private:tag" });
  await prepareContainerStart(claudeSpawn, "a1", override.io, override.deps);
  assert.equal(
    "buildVendor" in
      (only(override.calls, "prepareAgentImage").args[1] as object),
    false,
    "an override image tagged with a vendor name would tag a build of THIS project",
  );
});

test("the compile is PASSED to prepareAgentImage, not run by the seam", async () => {
  const r = rig();

  await prepareContainerStart(claudeSpawn, "a1", r.io, r.deps);

  assert.equal(
    only(r.calls, "prepareAgentImage").args[0],
    r.io.compile,
    "the compile is prepareAgentImage's first positional argument",
  );
  assert.equal(
    names(r.calls).includes("compile"),
    false,
    "a seam that RAN the compile would build before prepareAgentImage decides to",
  );
});

test("the plan markConfirmed stores is the plan that was PRINTED", async () => {
  const r = rig();

  await prepareContainerStart(claudeSpawn, "a1", r.io, r.deps);

  assert.equal(only(r.calls, "describePlan").args[0], r.plan);
  assert.equal(only(r.calls, "markConfirmed").args[1], r.plan);
  assert.equal(only(r.calls, "markConfirmed").args[0], "a1");
});

test("consent comes BEFORE the build, so a refused plan costs no docker", async () => {
  const r = rig();

  await prepareContainerStart(claudeSpawn, "a1", r.io, r.deps);

  const order = names(r.calls);
  assert.ok(
    order.indexOf("markConfirmed") < order.indexOf("prepareAgentImage"),
    `confirmation must precede the build, got ${order.join(" -> ")}`,
  );
  assert.ok(order.indexOf("ask") < order.indexOf("prepareAgentImage"));
});

test("answering anything but yes ABORTS, and nothing is built or confirmed", async () => {
  const r = rig({ answer: "" });

  assert.equal(
    await prepareContainerStart(claudeSpawn, "a1", r.io, r.deps),
    "aborted",
  );

  const order = names(r.calls);
  assert.equal(order.includes("markConfirmed"), false);
  assert.equal(order.includes("prepareAgentImage"), false);
});

test("no TTY REFUSES, and it refuses before the prompt is reached", async () => {
  const r = rig({ isTty: false });

  await assert.rejects(
    () => prepareContainerStart(claudeSpawn, "a1", r.io, r.deps),
    /needs a terminal to confirm/,
  );

  assert.equal(
    names(r.calls).includes("ask"),
    false,
    "rl.question resolves to '' with no terminal, which once took the abort path and reported success having started nothing",
  );
});

test("an already-confirmed handle is never re-prompted and still builds", async () => {
  const r = rig({ verdict: { kind: "confirmed" } });

  assert.equal(
    await prepareContainerStart(claudeSpawn, "a1", r.io, r.deps),
    "confirmed",
  );

  const order = names(r.calls);
  assert.equal(order.includes("ask"), false);
  assert.equal(order.includes("markConfirmed"), false);
  assert.equal(order.includes("describePlan"), false);
  assert.equal(order.includes("prepareAgentImage"), true);
});

test("a CHANGED plan names what changed, and an unseen one does not", async () => {
  const changed = rig({
    verdict: {
      kind: "changed",
      changes: [{ field: "image", from: "a", to: "b" }],
    },
  });
  await prepareContainerStart(claudeSpawn, "a1", changed.io, changed.deps);
  assert.deepEqual(only(changed.calls, "describeChanges").args[0], [
    { field: "image", from: "a", to: "b" },
  ]);

  const unseen = rig();
  await prepareContainerStart(claudeSpawn, "a1", unseen.io, unseen.deps);
  assert.equal(
    names(unseen.calls).includes("describeChanges"),
    false,
    "an operator diffing two banners by eye is the thing describeChanges exists to prevent",
  );
});

test("buildConfirmPlan is handed the vendor and the handle, and nothing else", async () => {
  const r = rig();

  await prepareContainerStart(claudeSpawn, "a1", r.io, r.deps);

  const call = only(r.calls, "buildConfirmPlan");
  assert.equal(call.args[0], claudeSpawn);
  assert.equal(call.args[1], "a1");
  assert.equal(
    call.args.length,
    2,
    "a third argument would be a second read of the override, which is the race PR 409 fixed",
  );
});
