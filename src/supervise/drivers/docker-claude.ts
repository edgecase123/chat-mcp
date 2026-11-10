import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AgentChild, SpawnOptions } from '../child.js';
import { createLineParser } from '../child.js';
import { type RateLimitSnapshot } from '../rate-limit.js';
import type { Denial } from '../denial.js';
import { routeClaudeEvent } from './claude.js';
import { mountsFor, containerPathFor } from '../mounts.js';
import { readToken } from '../auth.js';
import { IMAGE_TAG } from '../container.js';
import { stateDir, mcpConfigPathFor, ensureMcpConfigDir, writePrivateFileSync } from '../../util/paths.js';

/**
 * The container driver: the Claude Code CLI run inside `docker run` instead
 * of as a bare host process. #129.
 *
 * 🛑 A SECOND DRIVER OF drivers/claude.ts, NOT A FLAG ON IT. The flags this
 * driver passes are mutually exclusive with the host driver's
 * `--permission-mode`/`--allowedTools` family — decision 4 of the spec:
 * full in-container permissions, the container boundary is the gate.
 */

export const CONTAINER_PROJECT_DIR = '/work';
/** Same relative path `stateDir()` resolves to by default (`$HOME/.chat-mcp`) when the container's HOME is /root — no env var needed for the bus to resolve correctly in-container. */
export const CONTAINER_STATE_DIR = '/root/.chat-mcp';
const CONTAINER_CHAT_MCP_ENTRY = '/opt/chat-mcp/dist/index.js';

export { containerPathFor };

/**
 * Overwrite this handle's MCP config with CONTAINER-side command/args.
 *
 * The file itself is written to the HOST path (`mcpConfigPathFor`), which
 * lives under `stateDir()` and is therefore already bind-mounted into the
 * container — so the content just needs to point at paths that exist
 * INSIDE the container, not at this host process's own node binary.
 */
function writeContainerMcpConfig(childHandle: string): string {
  ensureMcpConfigDir();
  const hostPath = mcpConfigPathFor(childHandle);
  const config = {
    mcpServers: {
      chat: { command: 'node', args: [CONTAINER_CHAT_MCP_ENTRY, '--handle', childHandle] },
    },
  };
  writePrivateFileSync(hostPath, `${JSON.stringify(config, null, 2)}\n`);

  return `${CONTAINER_STATE_DIR}/mcp/${childHandle}.json`;
}

export function dockerArgsFor(opts: SpawnOptions): string[] {
  const token = readToken();
  if (!token) {
    throw new Error(
      'no Claude OAuth token on file; run `claude setup-token` on the host, then ' +
        '`chat-mcp auth set-token <token>`',
    );
  }

  if (!opts.supervisorHandle) {
    throw new Error('the docker-claude driver needs opts.supervisorHandle to find its mounts');
  }

  const projectDir = opts.cwd;
  if (!projectDir) {
    throw new Error('the docker-claude driver needs a resolved cwd');
  }

  const args = [
    'run',
    '-i',
    '--rm',
    '-e',
    `CLAUDE_CODE_OAUTH_TOKEN=${token}`,
    '-v',
    `${projectDir}:${CONTAINER_PROJECT_DIR}`,
    '-v',
    `${stateDir()}:${CONTAINER_STATE_DIR}`,
  ];

  for (const [key, hostDir] of Object.entries(mountsFor(opts.supervisorHandle))) {
    args.push('-v', `${hostDir}:${containerPathFor(key)}`);
  }

  args.push('-w', CONTAINER_PROJECT_DIR, IMAGE_TAG);

  args.push(
    'claude',
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--allow-dangerously-skip-permissions',
  );

  if (opts.model) args.push('--model', opts.model);
  if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);

  if (opts.grant) {
    args.push('--mcp-config', writeContainerMcpConfig(opts.grant.handle), '--strict-mcp-config');
  }

  return args;
}

export function spawnDockerClaude(opts: SpawnOptions = {}): AgentChild {
  const child: ChildProcessWithoutNullStreams = spawn(
    'docker',
    dockerArgsFor(opts),
    { stdio: ['pipe', 'pipe', 'pipe'] },
  ) as ChildProcessWithoutNullStreams;

  const eventCbs: ((e: Record<string, unknown>) => void)[] = [];
  const turnEndCbs: (() => void)[] = [];
  const usageCbs: ((s: RateLimitSnapshot) => void)[] = [];
  const denialCbs: ((d: Denial) => void)[] = [];
  const sessionCbs: ((id: string) => void)[] = [];
  let lastSession: string | null = null;

  const feed = createLineParser((parsed) => {
    for (const cb of eventCbs) cb(parsed);

    routeClaudeEvent(parsed, {
      turnEnd: () => {
        for (const cb of turnEndCbs) cb();
      },
      usage: (snapshot) => {
        for (const cb of usageCbs) cb(snapshot);
      },
      denial: (d) => {
        for (const cb of denialCbs) cb(d);
      },
      session: (id) => {
        if (lastSession === id) return;
        lastSession = id;
        for (const cb of sessionCbs) cb(id);
      },
    });
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', feed);

  return {
    reportsUsage: true,
    send(text: string): void {
      const message = {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text }] },
      };
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    onTurnEnd(cb): void {
      turnEndCbs.push(cb);
    },
    onUsage(cb): void {
      usageCbs.push(cb);
    },
    onDenial(cb): void {
      denialCbs.push(cb);
    },
    onSession(cb): void {
      sessionCbs.push(cb);
      if (lastSession) cb(lastSession);
    },
    onEvent(cb): void {
      eventCbs.push(cb);
    },
    onExit(cb): void {
      child.on('exit', (code, signal) => cb(code, signal));
    },
    kill(): void {
      // `docker run --rm` without `-d`: killing this process stops and
      // removes the container. No `docker exec`, ever — decision 8.
      child.kill();
    },
  };
}
