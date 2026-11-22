import type { SpawnOptions } from "../child.js";
import { type RateLimitSnapshot } from "../rate-limit.js";
import {
  parseClaudeRateLimit,
  claudeContextSnapshot,
} from "./claude-events.js";
import { denialFromClaude, rememberClaudeToolUse } from "./claude-events.js";
import type { Denial } from "../denial.js";
import type { ContextSnapshot } from "../context-gauge.js";
import {
  ensureMcpConfigDir,
  mcpConfigPathFor,
  writePrivateFileSync,
} from "../../util/paths.js";
import { chatMcpServerConfig } from "./chat-mcp-server.js";

/**
 * The Claude Code driver: the ONLY file that knows this CLI's flags and event
 * shapes.
 *
 * 🛑 A SECOND DRIVER IS A SIBLING OF THIS FILE AND CHANGES NOTHING ELSE. The
 * queue, the gate, the socket and the held-message release all speak the
 * semantic `AgentChild` callbacks.
 */
/**
 * Build the argv for a supervised `claude` child.
 *
 * Exported separately from the spawn so the flag set is assertable without
 * launching a process or spending anything.
 *
 * ⚠️ `--verbose` is NOT optional. Measured on 2026-10-16: without it the
 * process exits 1 with
 *   `When using --print, --output-format=stream-json requires --verbose`
 * and that requirement appears in no `--help` text for either flag.
 */
/**
 * The flags that continue an existing Claude Code session.
 *
 * 🛑 ONE SPELLING, ASKABLE BY THE RELAY, for the reason written on
 * `VendorSpawn.resumeFlags`. Claude Code is not per-turn today, so no relay
 * calls this — but the contract is per-vendor, not per-vendor-that-needs-it.
 */
export function claudeResumeFlags(sessionId: string): readonly string[] {
  return ["--resume", sessionId];
}

export function claudeArgs(opts: SpawnOptions = {}): string[] {
  const args = [
    "-p",
    "--verbose",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--permission-mode",
    // 🛑 `plan` DENIES every tool, measured on chat-mcp#33 — a child in plan
    // mode wakes, understands it is on the bus, tries to answer and is
    // refused. So a working child needs a mode that permits an allowlisted
    // tool.
    //
    // 🚨 `acceptEdits` WAS THAT MODE AND IT DID NOT ENFORCE THE ALLOWLIST.
    // Measured 2026-10-31, cwd and allowlist held constant, only the mode
    // changing:
    //
    //   acceptEdits + allowlist WITHOUT Bash  -> the rm RAN
    //   manual      + allowlist WITHOUT Bash  -> the rm was DENIED
    //
    // It auto-approves inside the allowed directories and never consults
    // the list, so lee's narrow allowlist was decorative and the approval
    // path could never fire — nothing was ever blocked.
    //
    // `manual` enforces it, and an allowlisted MCP tool still works:
    // measured, a `mcp__chat__send` landed on the bus under both modes.
    //
    // ⚠️ AN EARLIER VERSION OF THIS COMMENT SAID acceptEdits "widens nothing,
    // because `--tools ''` means there is no Edit tool to accept". THAT
    // PREMISE WAS DELETED when Write and Edit became available, and the
    // comment outlived it. What actually contains the mode now is that NO
    // bare `Write` or `Edit` is allowlisted — only `Edit(<glob>)` scopes.
    // Found by claude1 reviewing PR 34.
    //
    // An explicit --permission-mode always wins over both defaults.
    opts.permissionMode ?? (opts.grant ? "manual" : "plan"),
    "--permission-prompts",
    opts.permissionPrompts ?? "none",
  ];

  if (opts.model) args.push("--model", opts.model);
  if (opts.resumeSessionId) {
    args.push(...claudeResumeFlags(opts.resumeSessionId));
  }

  // 🛑 ALL FOUR OR NONE. `--mcp-config` ADDS to whatever the cwd already
  // configures, so without `--strict-mcp-config` the child also loads the
  // project's `.mcp.json` and registers under the handle hardcoded there —
  // the handle a live session is already using. `--tools ''` removes every
  // built-in, which is what makes the allowlist a least-privilege grant
  // rather than a wider permission mode.
  if (opts.grant) {
    args.push(
      "--mcp-config",
      opts.grant.configPath,
      "--strict-mcp-config",
      "--tools",
      // 🛑 SPACE-SEPARATED, because `--tools <tools...>` is variadic.
      //
      // ⚠️ AN EMPTY LIST WOULD EMIT A VALUELESS FLAG and the next argument
      // would be swallowed as its value. Fail CLOSED with an explicit empty
      // string instead, which disables every built-in — the reply-only
      // behaviour. Raised by claude1 reviewing PR 34.
      ...(opts.grant.available.length > 0 ? opts.grant.available : [""]),
      "--allowedTools",
      opts.grant.allowed.join(","),
    );

    // 🛑 WHERE the child may write, which the allowlist does NOT control.
    // Measured 2026-10-31: the same `Edit(<glob>)` allowlist entry is denied
    // under one cwd and permitted under another, because file writes are
    // confined to the working directory. This flag is the only thing that
    // widens it. Claude Code's spelling; another driver uses its own.
    if (opts.grant.extraDirs.length > 0) {
      args.push("--add-dir", ...opts.grant.extraDirs);
    }
  }

  return args;
}

/**
 * Write the child's own MCP config into the STATE DIR and return its path.
 *
 * 🛑 THIS PATH IS NAMED ON THE ARGV, WHICH IS WHY IT MAY LIVE ANYWHERE. Claude
 * Code is pointed at it by `--mcp-config`. A CLI with no such flag reads a
 * fixed project-local location instead and is served by
 * `deliverHostGrantFile`, not by this function.
 *
 * The server block itself is `chatMcpServerConfig`'s, shared with that writer.
 */
export function writeClaudeMcpConfig(handle: string, entry?: string): string {
  ensureMcpConfigDir();

  const path = mcpConfigPathFor(handle);

  writePrivateFileSync(
    path,
    `${JSON.stringify(chatMcpServerConfig(handle, entry), null, 2)}\n`,
  );

  return path;
}

/**
 * Map ONE parsed Claude Code event onto the semantic callbacks.
 *
 * 🛑 EXPORTED SO IT CAN BE TESTED WITHOUT SPAWNING. A negative control that
 * deleted this mapping from inside `spawnClaude` broke NOTHING, because every
 * supervisor test drives a fake child that signals turn-end directly. The
 * fake bypassed the only Claude-specific logic left in the system.
 *
 * ⚠️ A second driver writes its own version of this function and nothing else
 * changes. That is the seam.
 */
export function routeClaudeEvent(
  event: Record<string, unknown>,
  on: {
    turnEnd(): void;
    usage(snapshot: RateLimitSnapshot): void;
    context?(snapshot: ContextSnapshot): void;
    denial?(denial: Denial): void;
    session?(id: string): void;
  },
): void {
  const usage = parseClaudeRateLimit(event);

  if (usage) on.usage(usage);

  // 🛑 THE PRODUCER FOR THE APPROVAL PATH. Without this the detector was
  // imported and never called, `insertApproval` had no caller, and the whole
  // relay started one step after the break — which is exactly how the live
  // test passed while the feature did not exist. Found by claude1.
  // 🛑 BEFORE the denial check. The call arrives in an earlier event than
  // its refusal, so the recorder must see every assistant event first.
  rememberClaudeToolUse(event);

  const denial = denialFromClaude(event);
  if (denial && on.denial) on.denial(denial);

  // The session id arrives on the `system` init event and is what makes a
  // grant resumable instead of a restart.
  const id = event.session_id;
  if (typeof id === "string" && on.session) on.session(id);

  // ⚠️ A DIFFERENT WINDOW FROM `usage` AT THE TOP. That one is the
  // subscription rate limit and gates dispatch; this one is the context window
  // and only feeds the gauge. The raw stream calls both "usage".
  //
  // 🛑 LAST ON PURPOSE. The gauge handler does real I/O — a row write plus a
  // notify per room member — and a throw here would abort the whole event,
  // taking `rememberClaudeToolUse` with it. A later denial could then not name
  // the invocation, which is the bug the ordering note above exists to stop.
  // Nothing load-bearing may sit downstream of it. Raised by the dry-solid
  // reviewer.
  const context = claudeContextSnapshot(event);

  if (context && on.context) on.context(context);

  // `result` is Claude Code's terminal event. An `assistant` event with no
  // following `result` is a turn still in flight.
  if (event.type === "result") on.turnEnd();
}

/** The documented streaming-input shape: one JSON user message per line. */
export function claudeEncodeInput(text: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  })}\n`;
}
