import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-projects-'));

const { registerProject, readProjects, dirsFor, projectsPath } = await import(
  '../../src/supervise/projects.js'
);

const HOST_DIR = mkdtempSync(join(tmpdir(), 'chat-mcp-proj-src-'));

/**
 * 🛑 THIS POLICY IS CITED BY `commands.ts` AS THE REASON ITS OWN READER THROWS
 * INSTEAD. It had no test, so "fixing" `readProjects` to throw would have left
 * that comparison silently wrong.
 */
test('a malformed projects.json reads as EMPTY rather than throwing', () => {
  registerProject('claude1', HOST_DIR);
  writeFileSync(projectsPath(), '{ "agents": {,} }');

  assert.deepEqual(readProjects(), { agents: {} });
});

test('and the loud error comes from dirsFor, not from the read', () => {
  assert.throws(() => dirsFor('claude1'), /no project directory registered/);
});
