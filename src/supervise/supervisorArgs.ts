import type { SupervisorOptions } from "./index.js";
import type { VendorSpawn } from "./vendor.js";

/**
 * `supervise`'s options exactly as commander hands them over.
 *
 * 🛑 TYPED SO THE THREE `as unknown as` CASTS CAN GO. The action received
 * `Record<string, string>`, so `auto`, `reply` and `container` — all three
 * booleans — had to be cast through `unknown` to be read at all, and
 * TypeScript then guarded none of the fields they fed.
 */
export interface SuperviseCliOptions {
  readonly model?: string;
  readonly binary?: string;
  readonly driver?: string;
  readonly cwd?: string;
  readonly resume?: string;
  readonly permissionMode?: string;
  readonly auto?: boolean;
  readonly permissionPrompts?: string;
  readonly reply?: boolean;
  readonly allowedTools?: string;
  readonly container?: boolean;
}

/**
 * Turn `supervise <handle>`'s flags into `startSupervisor`'s arguments.
 *
 * 🛑 EXTRACTED SO A TEST CAN REACH THE RETURN VALUE (#471). Inline in the
 * commander action, the only assertion that named the permission-mode ternary
 * was a regex over `src/index.ts` — so inverting it, or making `--auto`
 * unconditional, kept every test green.
 *
 * `vendor` is resolved by the caller, which owns the (vendor, mode) selection
 * and the `adapters/` import this layer must not take.
 */
export function supervisorArgsFrom(
  handle: string,
  vendor: VendorSpawn,
  o: SuperviseCliOptions,
): SupervisorOptions {
  return {
    handle,
    vendor,
    model: o.model,
    binary: o.binary,
    driver: o.driver,
    cwd: o.cwd,
    resumeSessionId: o.resume,
    // 🛑 EXPLICIT --permission-mode STILL WINS. `--auto` is a shorthand, not
    // an override, so a mode named on the command line is never silently
    // replaced.
    permissionMode: o.permissionMode ?? (o.auto ? "auto" : undefined),
    permissionPrompts: o.permissionPrompts === "host" ? "host" : "none",
    // commander turns --no-reply into reply:false and omits it otherwise.
    reply: o.reply,
    allowedTools:
      typeof o.allowedTools === "string"
        ? o.allowedTools.split(",")
        : undefined,
    container: o.container,
  };
}
