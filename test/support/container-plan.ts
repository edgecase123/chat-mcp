import type { ContainerPlan } from "../../src/supervise/container.js";

/**
 * A `ContainerPlan` for a test that needs one as DATA rather than as the
 * supervisor's own output.
 *
 * 🛑 USE `confirmHandle` INSTEAD WHEN THE GATE IS THE SUBJECT. The gate
 * compares a stored plan to `buildConfirmPlan`'s output, so a hand-written
 * plan confirms a handle the supervisor then refuses.
 *
 * ⚠️ `envVarNames` AND `envValuesDigest` ARE THE TWO FIELDS CALLERS OVERRIDE.
 * Three test files carried their own copy of this factory and those were the
 * only two lines that differed between them, because they are each one of
 * those tests' subject (#356).
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
