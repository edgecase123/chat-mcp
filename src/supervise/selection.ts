import { resolveDriver, type DriverSelection } from "./drivers/index.js";
import { registrationFor } from "./registrations.js";

/**
 * How `agents.json` and the command-line flags together decide which (vendor,
 * mode) pair a handle starts on — the reader half of #132.
 *
 * 🛑 NOT FOLDED INTO `resolveDriver`. That function turns a NAME into a pair
 * and its own header protects that: it is imported by code which must not
 * touch the state directory, and a file read there would make every caller
 * depend on `stateDir()`. Composing the two here keeps the file read on one
 * seam that both spawn call sites share.
 *
 * 🛑 BOTH CALL SITES MUST USE THIS, NOT ONE. `src/index.ts` resolves the pair
 * to pick a `VendorSpawn` and to decide whether to run the container consent
 * gate; `startSupervisor` resolves it again for the spawn. Reading the file at
 * only one of them means the CLI builds a `claude` image while the supervisor
 * drives `cursor`.
 */

/**
 * The pair `handle` starts on, given whatever the operator named explicitly.
 *
 * Precedence is PER AXIS, because `--container` says nothing about which CLI
 * to drive and `--driver` says nothing conclusive about containment:
 *
 * | axis   | the flag wins when                       | otherwise |
 * |--------|------------------------------------------|-----------|
 * | vendor | `--driver <name>` was given              | the file  |
 * | mode   | the flags resolve to `docker`            | the file  |
 *
 * 🛑 A FLAG MAY TIGHTEN THE MODE AND MAY NEVER LOOSEN IT. `resolveDriver`
 * returns `host` both for `--driver claude`, which names that mode, and for a
 * bare invocation that names nothing — the two are indistinguishable by the
 * time they reach here. Reading that `host` as an override would start an
 * UNCONTAINED agent for a handle whose `agents.json` says `docker`, which is
 * the same silent-widening failure `registrations.ts` refuses an unknown mode
 * to avoid. Tightening is the safe direction, and `resolveDriver` already
 * applies the identical rule to `--container` over an alias.
 *
 * ⚠️ A HANDLE WITH NO REGISTRATION IS THE NORMAL CASE. It resolves exactly as
 * it did before this reader existed.
 */
export function selectionFor(
  handle: string,
  flags: { driver?: string; container?: boolean },
): DriverSelection {
  const fromFlags = resolveDriver(flags);

  // 🛑 NOT WRAPPED IN A try/catch. `readRegistrations` throws on a malformed
  // document on purpose, and swallowing that here would start every handle on
  // the default pair over one stray comma while the operator's file — and the
  // web card reading it — both said something else.
  const stored = registrationFor(handle);

  if (!stored) return fromFlags;

  const driverNamed =
    typeof flags.driver === "string" && flags.driver.length > 0;

  return {
    vendor: driverNamed ? fromFlags.vendor : stored.vendor,
    mode: fromFlags.mode === "docker" ? "docker" : stored.mode,
  };
}
