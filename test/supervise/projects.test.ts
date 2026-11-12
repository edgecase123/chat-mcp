import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-projects-'));

const { registerProject, readProjects, dirsFor, projectsPath } = await import(
  '../../src/supervise/projects.js'
);
const { stateDir } = await import('../../src/util/paths.js');
const { realContains } = await import('../../src/supervise/containment.js');

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

/**
 * 🛑 #183. A project directory ABOVE the state directory puts the whole sandbox
 * back inside the container, read-write. `-v $HOME:/work` carries
 * `~/.chat-mcp`, `~/.chat-mcp-manifests` and `chat.db` straight in — and the
 * manifest is the authorization surface the broker executes from.
 *
 * Refused at REGISTRATION as well as at spawn, so the operator finds out when
 * they type it rather than when an agent starts.
 */
test('registering a directory ABOVE the state directory is refused', () => {
  assert.throws(() => registerProject('claude1', dirname(stateDir())), /state directory/);
});

/**
 * 🛑 THE MANIFEST CHECK IS NOT REDUNDANT, AND A SYMLINK IS WHAT SEPARATES THEM.
 *
 * `manifestDir()` is `${stateDir()}-manifests`, a SIBLING, so an ancestor of one
 * is normally an ancestor of the other. But `realContains` resolves its target,
 * while `manifestDir()` is built from the UNRESOLVED path:
 *
 *   CHAT_MCP_HOME=/a/b/state -> /x/y/real     realContains(/a/b, state) FALSE
 *   manifestDir()             = /a/b/state-manifests   under /a/b      TRUE
 *
 * So the state check alone passes and the manifest still goes in.
 */
test('and so is one above the MANIFEST directory when the state dir is a symlink', () => {
  const outside = mkdtempSync(join(tmpdir(), 'chat-mcp-183-real-'));
  const parent = mkdtempSync(join(tmpdir(), 'chat-mcp-183-parent-'));
  const link = join(parent, 'state');
  symlinkSync(outside, link);

  const previous = process.env.CHAT_MCP_HOME;
  process.env.CHAT_MCP_HOME = link;

  try {
    // Positive control: the state dir really does resolve OUTSIDE `parent`,
    // so the refusal below cannot be the state-directory check firing.
    assert.equal(
      realContains(parent, stateDir()),
      false,
      'the symlink did not escape, so this test proves nothing about the manifest check',
    );

    assert.throws(() => registerProject('claude1', parent), /manifest directory/);
  } finally {
    process.env.CHAT_MCP_HOME = previous;
  }
});

/** A control: an ordinary sibling directory still registers. */
test('a project directory that contains neither still registers', () => {
  assert.deepEqual(registerProject('claude9', HOST_DIR), [resolve(HOST_DIR)]);
});
