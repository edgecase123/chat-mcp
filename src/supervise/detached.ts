import { openSync } from "node:fs";
import { spawn } from "node:child_process";
import { ensureLogDir, logPathFor, stateDir } from "../util/paths.js";
import { resolveChatMcpEntry } from "./drivers/chat-mcp-server.js";

/**
 * Start a supervisor that outlives the process asking for it.
 *
 * 🛑 A DETACHED CHILD, NEVER AN IN-PROCESS `startSupervisor`. The web server
 * is restarted whenever the operator edits a credential or the port moves, and
 * an in-process supervisor would die with it — taking the agent's container
 * with it. Reparented to init, the supervisor's lifetime is its own.
 *
 * 🛑 THE PRECONDITIONS ARE THE CALLER'S. Nothing here answers "may this
 * handle start": a detached child's throw lands in its log file, not in the
 * caller's response, so a refusal discovered after this point is invisible to
 * the operator who clicked.
 */
/**
 * The handle's log, opened for the child to write.
 *
 * Separate from the spawn so it can be asserted without starting a supervisor
 * that outlives the assertion.
 *
 * Appended, so a restart keeps the run before it. 0600 because the first lines
 * carry the child's allowed-tool list and its socket path.
 */
export function openSupervisorLog(handle: string): {
  path: string;
  fd: number;
} {
  ensureLogDir();
  const path = logPathFor(handle);

  return { path, fd: openSync(path, "a", 0o600) };
}

export function startDetachedSupervisor(handle: string): string {
  const { path, fd: log } = openSupervisorLog(handle);
  const entry = resolveChatMcpEntry();

  const child = spawn(entry.command, [...entry.args, "supervise", handle], {
    detached: true,
    // stdin is closed rather than inherited: the terminal confirm prompt reads
    // it, and a child that blocks on a prompt nobody can answer looks hung.
    stdio: ["ignore", log, log],
    env: {
      ...process.env,
      // 🛑 RESOLVED AND PASSED, NEVER INHERITED BY ABSENCE. `stateDir()`
      // refuses its default under the test runner, and a child inherits
      // `NODE_TEST_CONTEXT` — so an unset variable makes the child refuse
      // with a message about a test, from a click in a browser.
      CHAT_MCP_HOME: stateDir(),
    },
  });

  child.unref();

  return path;
}
