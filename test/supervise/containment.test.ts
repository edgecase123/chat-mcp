import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-containment-'));

const { realContains, checkedScriptPath } = await import('../../src/supervise/containment.js');

function project(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'chat-mcp-proj-')));
  mkdirSync(join(dir, 'scripts'));
  writeFileSync(join(dir, 'scripts', 'gate.sh'), '#!/bin/sh\n');

  return dir;
}

// ── realContains ─────────────────────────────────────────────────────────────

test('a directory contains itself', () => {
  const dir = project();
  assert.equal(realContains(dir, dir), true);
});

test('a directory contains something beneath it', () => {
  const dir = project();
  assert.equal(realContains(dir, join(dir, 'scripts', 'gate.sh')), true);
});

test('a sibling with the same prefix is NOT contained', () => {
  const dir = project();
  // `/tmp/proj-abc` must not contain `/tmp/proj-abc-evil`.
  assert.equal(realContains(dir, `${dir}-evil/x`), false);
});

test('a directory that is not on disk contains nothing', () => {
  assert.equal(realContains(join(tmpdir(), 'not-here-98765'), '/etc/passwd'), false);
});

test('realContains resolves the BASE through a symlink', () => {
  const real = project();
  const link = join(mkdtempSync(join(tmpdir(), 'chat-mcp-link-')), 'proj');
  symlinkSync(real, link);

  assert.equal(realContains(link, join(real, 'scripts', 'gate.sh')), true);
});

// ── checkedScriptPath — the symlink escape ───────────────────────────────────

test('a real script inside the project resolves to its absolute path', () => {
  const dir = project();
  assert.equal(
    checkedScriptPath(dir, { relative: 'scripts/gate.sh' }),
    join(dir, 'scripts', 'gate.sh'),
  );
});

test('🛑 a script that is a SYMLINK OUT of the project is refused', () => {
  const dir = project();
  symlinkSync('/bin/sh', join(dir, 'scripts', 'escape.sh'));

  assert.throws(
    () => checkedScriptPath(dir, { relative: 'scripts/escape.sh' }),
    /resolves to "\/bin\/sh", which is outside/,
  );
});

test('🛑 a script reached THROUGH a symlinked directory is refused', () => {
  const dir = project();
  symlinkSync('/usr/bin', join(dir, 'tools'));

  assert.throws(
    () => checkedScriptPath(dir, { relative: 'tools/env' }),
    /which is outside/,
  );
});

test('a missing script reads as MISSING, never as a containment refusal', () => {
  const dir = project();
  assert.throws(
    () => checkedScriptPath(dir, { relative: 'scripts/nope.sh' }),
    (err: Error) => {
      assert.match(err.message, /does not exist/);
      assert.doesNotMatch(err.message, /outside/);

      return true;
    },
  );
});

test('a project directory that is not on disk reads as MISSING', () => {
  assert.throws(
    () => checkedScriptPath(join(tmpdir(), 'no-project-54321'), { relative: 'a.sh' }),
    /does not exist/,
  );
});

// ── checkedProjectPath — the shared realpath check ───────────────────────────

test('a directory inside the project resolves to its absolute path', async () => {
  const { checkedProjectPath } = await import('../../src/supervise/containment.js');
  const dir = project();

  assert.equal(checkedProjectPath(dir, 'scripts', 'read-only path'), join(dir, 'scripts'));
});

test('🛑 a directory that is a SYMLINK OUT of the project is refused', async () => {
  const { checkedProjectPath } = await import('../../src/supervise/containment.js');
  const dir = project();
  symlinkSync('/etc', join(dir, 'conf'));

  assert.throws(
    () => checkedProjectPath(dir, 'conf', 'read-only path'),
    // macOS realpaths `/etc` to `/private/etc`, so anchor on the suffix.
    /resolves to "[^"]*\/etc", which is outside/,
  );
});

test('the NOUN names what was missing, so the message is not script-specific', async () => {
  const { checkedProjectPath } = await import('../../src/supervise/containment.js');
  const dir = project();

  assert.throws(
    () => checkedProjectPath(dir, 'nope', 'read-only path'),
    /read-only path does not exist/,
  );
});

test('🛑 a path containing a COLON is refused, because it is a field delimiter in a mount spec', async () => {
  const { containedRelative } = await import('../../src/supervise/containment.js');

  // `-v <host>:<dest>:ro` splits on `:`, so `evil:dir` makes a four-field spec.
  // Docker refuses it outright — one bad declared path denies the whole spawn.
  assert.throws(() => containedRelative('scripts/evil:dir', 'read-only path'), /colon/);
});
