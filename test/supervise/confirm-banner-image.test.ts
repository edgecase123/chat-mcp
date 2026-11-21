import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
    memory: null,
    cpus: null,
    installMemory: null,
    installCpus: null,
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
