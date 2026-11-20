import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CHAT_MCP_HOME = mkdtempSync(
  join(tmpdir(), "chat-mcp-confirm-image-"),
);

const { describePlan } = await import("../../src/supervise/container.js");
const { effectiveImage } =
  await import("../../src/supervise/drivers/containerized.js");

import type { VendorSpawn } from "../../src/supervise/vendor.js";

const vendor = { image: "chat-mcp-agent:local" } as unknown as VendorSpawn;

test("the confirm banner names the image the container will run", () => {
  const plan = describePlan({
    mountPaths: ["/work"],
    envVarNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
    binary: "claude",
    networkMode: "bridge",
    image: "chat-mcp-agent:local",
  });

  assert.match(
    plan,
    /chat-mcp-agent:local/,
    "an operator confirming a container must be told WHICH image it is",
  );
});

test("🔴 control — an override's image is what effectiveImage returns, not the vendor tag", () => {
  assert.equal(
    effectiveImage(vendor, { image: "someone-elses/agent:latest" }),
    "someone-elses/agent:latest",
  );

  assert.equal(
    effectiveImage(vendor, null),
    "chat-mcp-agent:local",
    "with no override the vendor's own tag is the answer",
  );
});

test("🔴 control — the banner call site does NOT read vendor.image directly", () => {
  // The whole point of the fix: three consumers already route through
  // `effectiveImage` so they cannot disagree about which image is in play. A
  // banner that read `vendor.image` would print the vendor tag while an
  // override ran a different image — the operator confirms one container and
  // a different one starts.
  const source = readFileSync(
    new URL("../../src/index.ts", import.meta.url),
    "utf8",
  );
  const bannerBlock = source.slice(
    source.indexOf("describePlan({"),
    source.indexOf("Proceed? [y/N]"),
  );

  assert.ok(bannerBlock.length > 0, "the banner block must still be findable");

  // 🛑 COMMENTS STRIPPED FIRST. The first version of this guard matched the
  // comment that explains it — a guard a comment can trip tells you nothing
  // about the code. Only `//` to end-of-line is removed, so code sharing a
  // line with a comment is still read.
  const code = bannerBlock.replace(/\/\/[^\n]*/g, "");

  assert.doesNotMatch(
    code,
    /vendor\.image/,
    "the banner must resolve its image through effectiveImage, not vendor.image",
  );
  assert.match(
    code,
    /effectiveImage/,
    "the banner must name the image the spawn will actually run",
  );

  // 🔴 NON-VACUITY. A stripper that ate the whole block would pass both
  // assertions above while reading nothing.
  assert.match(
    code,
    /describePlan\(\{/,
    "the stripper must not have consumed the block it was given",
  );
});
