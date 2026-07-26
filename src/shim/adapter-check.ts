import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '../util/paths.js';

/**
 * Framework identifiers match the adapter installer names in
 * `src/adapters/` (e.g. `claude-code` → `src/adapters/claude-code.ts`).
 * Extend this union as new adapters ship.
 */
export type Framework = 'claude-code';

/**
 * Detect the framework hosting this shim via environment variables the
 * client sets on the subprocess it spawns. Returns null when detection is
 * inconclusive — we deliberately don't warn in that case to avoid false
 * positives on frameworks that don't have an adapter yet (cursor, codex).
 */
export function detectFramework(): Framework | null {
  if (process.env.CLAUDECODE === '1') return 'claude-code';
  return null;
}

export function adapterScriptPath(framework: Framework, handle: string): string {
  return join(stateDir(), 'adapters', `${framework}-${handle}.sh`);
}

export interface AdapterStatus {
  installed: boolean;
  framework: Framework | null;
  hint: string | null;
}

/**
 * Check whether a wake adapter is installed for this handle under the
 * detected framework. Result is used both to prepend a warning to the MCP
 * `instructions` preamble and to populate `wake_adapter` in `chat.whoami`.
 */
export function checkWakeAdapter(handle: string): AdapterStatus {
  const framework = detectFramework();
  if (!framework) {
    return {
      installed: false,
      framework: null,
      hint: null,
    };
  }
  const path = adapterScriptPath(framework, handle);
  if (existsSync(path)) {
    return { installed: true, framework, hint: null };
  }
  const hint = [
    `No ${framework} wake adapter installed for handle "${handle}" (expected: ${path}).`,
    `Install once — auto-arms the wake watch on every session:`,
    `  npx -y github:edgecase123/chat-mcp install ${framework} --handle ${handle}`,
    `Then restart the client. Until installed, use the Manual Fallback below.`,
  ].join('\n');
  return { installed: false, framework, hint };
}

/**
 * Prepend a warning banner to the MCP instructions text when the adapter
 * is missing. Kept short + high-signal so it lands even under context
 * pressure.
 */
export function prependAdapterWarning(instructions: string, status: AdapterStatus): string {
  if (status.installed || !status.hint) return instructions;
  const banner = [
    '⚠️  WAKE ADAPTER NOT INSTALLED',
    '',
    status.hint,
    '',
    '───────────────────────────────────────────────────────────────',
    '',
  ].join('\n');
  return banner + instructions;
}
