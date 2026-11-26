import type { ContainerPlan } from "../../src/supervise/container.js";

/**
 * A `ContainerPlan` for a test that needs one as DATA rather than as the
 * supervisor's own output.
 *
 * 🛑 USE `confirmHandle` INSTEAD WHEN THE GATE IS THE SUBJECT. The gate
 * compares a stored plan to `buildConfirmPlan`'s output, so a hand-written
 * plan confirms a handle the supervisor then refuses.
 *
 * ⚠️ `envVarNames` AND `envValuesDigest` ARE THE FIELDS A CALLER IS LIKELY
 * TO SET. They were the only two that differed between the copies this
 * replaced, because each is the subject of one of those tests (#356).
 *
 * 🛑 THE DEFAULTS HERE ARE NOT LOAD-BEARING, AND THAT IS MEASURED, NOT
 * ASSUMED. Mutating `binary` left every caller GREEN: these tests assert
 * diffing, digesting and locking, never a field's value. So inheriting a
 * default weakens nothing — but a test whose SUBJECT is one of these fields
 * must still set it, because then the value IS the claim.
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
