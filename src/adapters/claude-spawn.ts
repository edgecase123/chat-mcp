import type { SpawnOptions } from '../supervise/child.js';
import type { ChildGrant } from '../supervise/grant.js';
import type { SandboxMode, VendorSpawn } from '../supervise/vendor.js';
import { claudeArgs, routeClaudeEvent } from '../supervise/drivers/claude.js';
import { redispatchPrompt } from '../supervise/drivers/claude-redispatch.js';
import { writeContainerMcpConfig } from '../supervise/drivers/docker-claude.js';
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
    '--allow-dangerously-skip-permissions',
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
  // Docker: the file is rewritten with container-side command and args, and
  // the path handed to the CLI is the one that exists INSIDE the container.
  mcpConfigFor: (grant: ChildGrant, mode: SandboxMode): string =>
    mode === 'docker' ? writeContainerMcpConfig(grant.handle) : grant.configPath,

  routeEvent: routeClaudeEvent,

  encodeInput: (text: string): string =>
    `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
    })}\n`,

  redispatchPrompt,
};
