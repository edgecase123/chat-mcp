import type { SpawnOptions } from '../supervise/child.js';
import type { ChildGrant } from '../supervise/grant.js';
import type { SandboxMode, VendorSpawn } from '../supervise/vendor.js';
import { claudeArgs, claudeEncodeInput, routeClaudeEvent } from '../supervise/drivers/claude.js';
import { redispatchPrompt } from '../supervise/drivers/claude-redispatch.js';
import { containerMcpConfigPath } from '../supervise/drivers/containerized.js';
import { IMAGE_TAG } from '../supervise/container.js';

/**
 * Claude Code's spawn contract: the only place this CLI's flag names live.
 *
 * The host flag set is `claudeArgs`, unchanged and still exported from the
 * driver so its existing tests keep passing. The container set is smaller on
 * purpose — a contained child gets full in-container permissions, because the
 * container is the boundary rather than the prompt.
 */
function containerArgs(opts: SpawnOptions): string[] {
  const args = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    // 🛑 THE ACTIVATOR, NOT THE ENABLER. Claude Code ships two flags that
    // read as synonyms and are not:
    //
    //   --allow-dangerously-skip-permissions
    //       "Enable bypassing all permission checks AS AN OPTION, without it
    //        being enabled by default."
    //   --dangerously-skip-permissions
    //       "Bypass all permission checks."
    //
    // The enabler alone was passed for a week. Permission checks still ran,
    // nothing in a container answers a prompt, and so every containerized
    // agent was DENIED the bus tool it was spawned to use.
    //
    // ⚠️ THE ENABLER IS NOT PASSED, AND THAT IS MEASURED RATHER THAN ASSUMED.
    // A live container with this flag ALONE answered on the bus. Carrying a
    // second flag that demonstrably changes nothing is noise in the one arg
    // list where a reader must be able to tell what is load-bearing.
    '--dangerously-skip-permissions',
  ];

  if (opts.model) args.push('--model', opts.model);
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);

  return args;
}

export const claudeSpawn: VendorSpawn = {
  binary: 'claude',
  image: IMAGE_TAG,
  containerHome: '/root',
  authEnvVar: 'CLAUDE_CODE_OAUTH_TOKEN',

  argsFor: (opts: SpawnOptions, mode: SandboxMode): string[] =>
    mode === 'docker' ? containerArgs(opts) : claudeArgs(opts),

  // Host: the grant already holds a host-side path, written at grant time.
  // Docker: a path that exists only INSIDE the container, written there by the
  // spawn prelude. Nothing is written on the host, and nothing is mounted.
  mcpConfigFor: (grant: ChildGrant, mode: SandboxMode): string =>
    mode === 'docker' ? containerMcpConfigPath(claudeSpawn) : grant.configPath,

  routeEvent: routeClaudeEvent,

  encodeInput: claudeEncodeInput,

  redispatchPrompt,
};
