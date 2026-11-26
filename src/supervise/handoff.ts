import { join } from "node:path";
import type { SandboxMode } from "./vendor.js";
import { CONTAINER_PROJECT_DIR } from "./drivers/containerized.js";

/**
 * Where a supervised agent reads and writes its own handoff, and the prompt
 * that tells it to.
 *
 * lee, 2026-11-26, after rejecting two earlier designs:
 *
 * > *"have it LOOK for a file in its own /tmp directory, not a mounted
 * > directory. If it is present, then read it"*, then
 * > *"it needs a place to both read and write a hand off file"*, settling on
 * > *"\"/work/HANDOFF.md\" works for me"*.
 *
 * 🛑 BOTH REJECTED DESIGNS FAILED FOR A REASON WORTH KEEPING. A mounted
 * `local-context` directory was unreachable from inside the container at all.
 * The container's own `/tmp` is reachable and writable, but `dockerRunPlan`
 * runs with `--rm`, so that filesystem is destroyed when the supervisor stops
 * — losing the handoff exactly when a restart makes somebody want it.
 *
 * 🛑 THE AGENT IS THE ROUTINE WRITER, NOT THE EXCLUSIVE ONE, AND AN EARLIER
 * VERSION OF THIS FILE GOT THAT WRONG. It argued from "`docker cp` has zero
 * hits in this codebase" to "nothing else can write it". The premise is true
 * and the conclusion does not follow: `/work` is a READ-WRITE bind of the host
 * project directory, so anything on the host writing `<projectDir>/HANDOFF.md`
 * appears to the container immediately, with no `docker cp` involved. The
 * `:ro` mounts elsewhere in `dockerRunPlan` show the read-write bind is a
 * choice. Caught by claude2 on PR 469.
 *
 * ⚠️ SO THE PROMPT MUST NOT CLAIM EXCLUSIVITY. An agent told it is the only
 * writer has no reason to expect the file to have changed under it — and
 * operator seeding, which is what #463's own item 2 wanted, is exactly the
 * capability that sentence talked out of existence.
 */

/** The one spelling of the file's name, in both modes. */
export const HANDOFF_FILENAME = "HANDOFF.md";

/**
 * The handoff path as the AGENT will see it.
 *
 * 🛑 THE CONTAINER ARM IS DERIVED FROM THE MOUNT, NEVER SPELLED OUT. The
 * project bind is `CONTAINER_PROJECT_DIR`, and a second literal `/work` here
 * would drift from it silently: the agent would be told to read a path nothing
 * is mounted at, and the only symptom is a handoff that never appears.
 *
 * 🛑 AND IT IS NOT `join`. The container is Linux whatever the host is, so
 * `join` would answer a Windows host with a backslash the container cannot
 * resolve. The host arm uses `join` because there the host IS the filesystem.
 */
export function handoffPathFor(mode: SandboxMode, projectDir: string): string {
  if (mode === "docker") return `${CONTAINER_PROJECT_DIR}/${HANDOFF_FILENAME}`;

  return join(projectDir, HANDOFF_FILENAME);
}

/**
 * The prompt that hands an agent its own handoff file.
 *
 * ⚠️ IT MUST NOT CLAIM THE FILE EXISTS. A first start has none, and that is
 * the common case — telling an agent to read a missing file earns a tool error
 * on turn one and an agent that reports a fault instead of starting work.
 *
 * 🛑 `[chat-mcp]` MARKS IT, AS EVERY SUPERVISOR-AUTHORED PROMPT IS MARKED.
 * Unmarked, it reads as a message from a peer, and the agent answers it to
 * somebody instead of acting on it.
 */
export function handoffPreamble(path: string): string {
  return (
    `[chat-mcp] your handoff file is \`${path}\`. ` +
    `Read it first if it is there, and treat it as where you left off; ` +
    `if it is not there, this is a fresh start and that is normal. ` +
    `Write your own state back to that same path before you stop, ` +
    `because nothing will do that for you. ` +
    `It is an ordinary file in your project directory, so an operator may ` +
    `have left it for you and it can change between your turns.`
  );
}
