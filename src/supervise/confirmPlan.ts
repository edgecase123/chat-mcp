import { readMounts } from "./mounts.js";
import { hasGhToken } from "./auth.js";
import { resolveOverrideFor } from "./overrideStore.js";
import {
  CONTAINER_GH_TOKEN_ENV,
  effectiveImage,
} from "./drivers/containerized.js";
import { installCpusFor, installMemoryFor } from "./installResources.js";
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
    // 🛑 THE OVERRIDE'S MOUNTS BELONG HERE, OR THE SPAWN GRANTS A DIRECTORY
    // THE OPERATOR WAS NEVER SHOWN. `readMounts()` covers the `/mnt/<key>`
    // registrations only; `readOnlyMounts` is a second source and reaches the
    // same container.
    //
    // ⚠️ THE CONTAINER PATH, NOT THE DECLARED ONE. `dockerRunPlan` emits
    // `/work/<entry>`, so a banner printing the bare relative string would
    // describe a destination the container does not have.
    mountPaths: [
      "/work",
      ...extra,
      ...(override?.readOnlyMounts ?? []).map((entry) => `/work/${entry}`),
    ],
    // 🛑 NAMES ONLY, AND THE OVERRIDE'S NAMES COUNT. `assertEnv` refuses every
    // reserved credential, so nothing here can collide with the two above —
    // and an operator reads this line to learn what the container is handed.
    envVarNames: [
      vendor.authEnvVar,
      ...ghEnvVar,
      ...Object.keys(override?.env ?? {}),
    ],
    // 🛑 THE CONTAINER BINARY, NEVER `vendor.binary`. Both callers gate on the
    // docker mode, so this banner only ever describes a container — and a
    // banner naming the host path asks the operator to approve a file that is
    // not in the image.
    binary: vendor.containerBinary,
    networkMode: NETWORK_MODE,
    // 🛑 THE EFFECTIVE IMAGE, NEVER `vendor.image`. The agent container, the
    // install container and the inspect guard all resolve it here too, so
    // they cannot disagree about which image is in play.
    image: effectiveImage(vendor, override),
    // 🛑 READ OFF THE SAME RESOLVED OVERRIDE AS THE IMAGE. Resolving twice is
    // how the banner and the spawn come to describe different files.
    memory: override?.memory ?? null,
    cpus: override?.cpus ?? null,
    // 🛑 THE SAME FUNCTIONS THE INSTALL ARGV READS, not a second copy of the
    // floor. Two literals that happen to agree is how the banner came to say
    // `512m` about a container that ran with `1g`.
    installMemory: installMemoryFor(override),
    installCpus: installCpusFor(override),
  };
}
