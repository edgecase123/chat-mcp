import { readMounts } from "./mounts.js";
import { hasGhToken } from "./auth.js";
import { resolveOverrideFor } from "./overrideStore.js";
import {
  CONTAINER_GH_TOKEN_ENV,
  effectiveImage,
} from "./drivers/containerized.js";
import type { ContainerPlan } from "./container.js";
import type { VendorSpawn } from "./vendor.js";

/** Egress is unrestricted today; narrowing it is #134. */
const NETWORK_MODE = "bridge (default, full outbound — narrowing is #134)";

/**
 * The plan an operator is asked to approve before a containerized spawn.
 *
 * 🛑 EXTRACTED SO A TEST CAN CALL IT. Built inline in the commander action,
 * the only reachable instrument was a grep over the call site's source text —
 * which greens on a call that passes the wrong argument.
 */
export function buildConfirmPlan(
  vendor: VendorSpawn,
  handle: string,
): ContainerPlan {
  const extra = Object.keys(readMounts().agents[handle] ?? {}).map(
    (k) => `/mnt/${k}`,
  );

  const override = resolveOverrideFor(handle);

  // Listed only when one is on file, because that is exactly when
  // `dockerRunPlan` passes it. Naming a credential the container will not
  // receive is the misleading-operator class #136 was about.
  const ghEnvVar = hasGhToken() ? [CONTAINER_GH_TOKEN_ENV] : [];

  return {
    mountPaths: ["/work", ...extra],
    envVarNames: [vendor.authEnvVar, ...ghEnvVar],
    binary: vendor.binary,
    networkMode: NETWORK_MODE,
    // 🛑 THE EFFECTIVE IMAGE, NEVER `vendor.image`. The agent container, the
    // install container and the inspect guard all resolve it here too, so
    // they cannot disagree about which image is in play.
    image: effectiveImage(vendor, override),
    // 🛑 READ OFF THE SAME RESOLVED OVERRIDE AS THE IMAGE. Resolving twice is
    // how the banner and the spawn come to describe different files.
    memory: override?.memory ?? null,
    cpus: override?.cpus ?? null,
  };
}
