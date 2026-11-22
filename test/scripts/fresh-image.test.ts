import { test } from "node:test";
import assert from "node:assert/strict";

import { ensureFreshVendorImage } from "../../scripts/lib/fresh-image.mjs";

/**
 * 🛑 THE OVERRIDE BRANCH IS THE ONE THE ASSERT CAN ACTUALLY FAIL IN, and the
 * live acceptance scripts are the only callers — they need `CHAT_MCP_LIVE=1`
 * and real money, so nothing in the suite reached this file at all.
 *
 * The branch got wrong later is the conditional spread: `buildVendor` must be
 * ABSENT for an override, not present-and-undefined, because
 * `prepareAgentImage` keys on its presence.
 */

const VENDOR = { vendor: "cursor", image: "chat-mcp-cursor-agent:local" };

function harness(opts: { stale: boolean[]; prepareBuilds: boolean }) {
  const checks: { name: string; ok: boolean }[] = [];
  const lines: string[] = [];
  const staleAnswers = [...opts.stale];
  let prepareOpts: Record<string, unknown> | undefined;

  const deps = {
    needsBuild: () => staleAnswers.shift() ?? false,
    prepare: (_compile: () => void, o: Record<string, unknown>) => {
      prepareOpts = o;
      if (!opts.prepareBuilds) return;
    },
    logLine: (line: string) => lines.push(line),
    compile: () => {},
  };

  return {
    checks,
    lines,
    deps,
    record: (name: string, ok: boolean) => checks.push({ name, ok }),
    prepareOpts: () => prepareOpts,
  };
}

test("names the vendor when the plan runs the vendor's OWN image", () => {
  const h = harness({ stale: [true, false], prepareBuilds: true });

  ensureFreshVendorImage({ image: VENDOR.image }, VENDOR, h.record, h.deps);

  assert.equal(h.prepareOpts()?.buildVendor, "cursor");
  assert.equal(h.checks.at(-1)?.ok, true);
});

test("🛑 OMITS buildVendor entirely for an operator override, rather than passing undefined", () => {
  const h = harness({ stale: [true, true], prepareBuilds: false });

  ensureFreshVendorImage(
    { image: "someone-elses:tag" },
    VENDOR,
    h.record,
    h.deps,
  );

  // Present-and-undefined would read as "this project may build it" to a
  // caller testing the key rather than the value.
  assert.ok(
    !("buildVendor" in (h.prepareOpts() ?? {})),
    `buildVendor must be absent, got ${JSON.stringify(h.prepareOpts())}`,
  );
});

test("🛑 FAILS the run when the image is still stale after prepare — the override early return", () => {
  const h = harness({ stale: [true, true], prepareBuilds: false });

  ensureFreshVendorImage(
    { image: "someone-elses:tag" },
    VENDOR,
    h.record,
    h.deps,
  );

  assert.equal(
    h.checks.at(-1)?.ok,
    false,
    "a stale image must fail a named check, not be absent from the log",
  );
});

test("says WHICH of the two happened, because a green run cannot tell them apart", () => {
  const rebuilt = harness({ stale: [true, false], prepareBuilds: true });
  ensureFreshVendorImage(
    { image: VENDOR.image },
    VENDOR,
    rebuilt.record,
    rebuilt.deps,
  );

  const current = harness({ stale: [false, false], prepareBuilds: true });
  ensureFreshVendorImage(
    { image: VENDOR.image },
    VENDOR,
    current.record,
    current.deps,
  );

  assert.match(rebuilt.lines.join("\n"), /was STALE and was rebuilt/);
  assert.match(current.lines.join("\n"), /was already current/);

  // The control that makes the pair dispositive: the two runs differ ONLY in
  // the pre-build staleness answer, so a helper that logged a constant string
  // would fail one of them.
  assert.notEqual(rebuilt.lines.join(), current.lines.join());
});
