import type { ContainerPlan } from "../../src/supervise/container.js";

/**
 * A `ContainerPlan` for a test that needs one as DATA rather than as the
 * supervisor's own output.
 *
 * 🛑 USE `confirmHandle` INSTEAD WHEN THE GATE IS THE SUBJECT. The gate
 * compares a stored plan to `buildConfirmPlan`'s output, so a hand-written
 * plan confirms a handle the supervisor then refuses.
 *
 * ⚠️ `envVarNames` AND `envValuesDigest` ARE THE TWO FIELDS CALLERS OVERRIDE,
 * and all three callers pass them EXPLICITLY rather than inheriting a default.
 * Those were the only two lines that differed between the three copies this
 * replaced, because each is one of those tests' own subject (#356). A shared
 * default for either would silence the detector that test exists to be.
 */
export function containerPlan(
  over: Partial<ContainerPlan> = {},
): ContainerPlan {
  return {
    mountPaths: ["/work"],
    envVarNames: ["CLAUDE_CODE_OAUTH_TOKEN"],
    envValuesDigest: "0".repeat(64),
    binary: "claude",
    networkMode: "bridge",
    image: "chat-mcp-agent:local",
    memory: null,
    cpus: null,
    installMemory: null,
    installCpus: null,
    ...over,
  };
}
