import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point CHAT_MCP_HOME at a scratch dir BEFORE importing anything that reads it.
process.env.CHAT_MCP_HOME = join(mkdtempSync(join(tmpdir(), 'chat-mcp-kids-')), 'state');

const {
  ensureAdaptersDir,
  ensureMcpConfigDir,
  ensureNotifyDir,
  adaptersDir,
  mcpConfigDir,
  mcpConfigPathFor,
  notifyDir,
  STATE_DIR_MODE,
  STATE_FILE_MODE,
} = await import('../../src/util/paths.js');
const { registerProject, projectsPath } = await import('../../src/supervise/projects.js');
const { writeClaudeMcpConfig } = await import('../../src/supervise/drivers/claude.js');

// registerProject refuses a directory that does not exist, so give it a real one.
const PROBE_DIR = mkdtempSync(join(tmpdir(), 'chat-mcp-probe-'));

const modeOf = (p: string) => statSync(p).mode & 0o777;

/**
 * 🚨 ONLY THE 0700 PARENT MADE THESE MODES UNREACHABLE. Each child was born at
 * the launching shell's umask, so the whole guarantee sat in one place and
 * nothing said so at the point of writing.
 *
 * ⚠️ EVERY CASE BELOW RE-LOOSENS ITS TARGET FIRST. A fixture that creates the
 * target fresh passes with the fix deleted, because `mkdir`/`writeFile` take a
 * `mode` that 0700 and 0600 are already immune to under any umask. The
 * `chmod` only earns its place on something that ALREADY exists loose, which
 * is every install predating the guard.
 */

const DIRS: ReadonlyArray<[string, () => string, () => string]> = [
  ['mcp config', ensureMcpConfigDir, mcpConfigDir],
  ['notify', ensureNotifyDir, notifyDir],
  ['adapters', ensureAdaptersDir, adaptersDir],
];

for (const [label, ensure, path] of DIRS) {
  test(`🚨 an ALREADY EXISTING wide-open ${label} directory is tightened`, () => {
    mkdirSync(path(), { recursive: true });
    chmodSync(path(), 0o755);
    assert.equal(modeOf(path()), 0o755, 'the fixture is actually loose before the call');

    ensure();

    assert.equal(modeOf(path()), STATE_DIR_MODE);
  });
}

/**
 * `projects.json` names every directory an agent is registered against, so it
 * maps handles to paths on this machine.
 */
test('🚨 an ALREADY EXISTING world-readable projects.json is tightened', () => {
  ensureMcpConfigDir();
  writeFileSync(projectsPath(), '{"agents":{}}\n');
  chmodSync(projectsPath(), 0o644);
  assert.equal(modeOf(projectsPath()), 0o644, 'the fixture is actually loose before the call');

  registerProject('probe', PROBE_DIR);

  assert.equal(modeOf(projectsPath()), STATE_FILE_MODE);
});

test("🚨 an ALREADY EXISTING world-readable mcp/<handle>.json is tightened", () => {
  ensureMcpConfigDir();
  const path = mcpConfigPathFor('probe');
  writeFileSync(path, '{}\n');
  chmodSync(path, 0o644);
  assert.equal(modeOf(path), 0o644, 'the fixture is actually loose before the call');

  writeClaudeMcpConfig('probe');

  assert.equal(modeOf(path), STATE_FILE_MODE);
});

/**
 * 🛑 NOT TESTED, DELIBERATELY: the `mode` argument on each `mkdirSync`.
 *
 * Measured — deleting it from all four call sites leaves every test here
 * green, because the `chmodVerified` that follows repairs the mode before
 * anything can observe it. It is kept for the window between the two calls,
 * and no assertion can see that window without racing it. Four tests that
 * asserted a fresh create under `umask 000` were removed for exactly the
 * reason this file exists: they passed with the fix reverted.
 */
