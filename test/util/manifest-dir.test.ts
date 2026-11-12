import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 🛑 BEFORE any import that resolves a state path.
process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-manifest-dir-'));

const { ensureManifestDir, ensureNotifyDir, manifestDir, manifestPathFor, notifyDir, stateDir } =
  await import('../../src/util/paths.js');
const { realContains } = await import('../../src/supervise/containment.js');

/**
 * 🛑 THE WHOLE POINT OF THIS DIRECTORY IS THAT A CONTAINER CANNOT REACH IT.
 *
 * `dockerArgsForVendor` mounts `stateDir()` whole and read-write, so a manifest
 * anywhere under it is one an agent can edit — and editing it widens the
 * agent's own authorization. A sibling is outside that mount.
 *
 * ⚠️ `realContains`, not a string compare. `${stateDir()}-manifests` LOOKS
 * outside by prefix while a symlink could still land it inside.
 */
test('🛑 the manifest dir is NOT inside the state dir, which is mounted into every container', () => {
  ensureManifestDir();

  // 🛑 POSITIVE CONTROL, AND IT ALREADY EARNED ITS PLACE. `realContains`
  // answers false for anything it cannot resolve, so without this the refusal
  // below would read the same whether the instrument worked or was blind.
  //
  // ⚠️ BOTH SIDES MUST EXIST. It realpaths the base but leaves a MISSING
  // target unresolved, and on macOS `tmpdir()` is a symlink — so a contained
  // path that is merely absent compares as outside.
  ensureNotifyDir();
  assert.equal(
    realContains(stateDir(), notifyDir()),
    true,
    'realContains cannot see inside the state dir, so the refusal below proves nothing',
  );

  assert.equal(
    realContains(stateDir(), manifestDir()),
    false,
    `${manifestDir()} is inside the mounted state dir, so an agent can edit its own manifest`,
  );
});

test('a handle’s manifest is inside the manifest dir', () => {
  const path = manifestPathFor('claude2');

  // The file must EXIST — see the symlink note on the control above.
  ensureManifestDir();
  writeFileSync(path, '{"projectDir":"/tmp","commands":[]}');

  assert.equal(realContains(manifestDir(), path), true);
});

/**
 * ⚠️ IT MUST FOLLOW `CHAT_MCP_HOME`, or a test writes to the operator's real
 * tree. `stateDir()` already refuses the default under the test runner; a
 * manifest dir derived from `homedir()` instead would bypass that refusal.
 */
test('🛑 it follows CHAT_MCP_HOME, so a test cannot reach the real one', () => {
  assert.ok(
    manifestDir().startsWith(process.env.CHAT_MCP_HOME as string),
    `${manifestDir()} does not follow CHAT_MCP_HOME`,
  );
});

/**
 * 🛑 THE HANDLE BECOMES A FILENAME, SO IT IS VALIDATED HERE.
 *
 * `notifyPathFor` and `socketPathFor` interpolate a handle without this, and
 * for them a traversal writes a file in the wrong place. For THIS file it
 * READS a different handle's authorization, which is worse — so the one
 * existing validator (`assertHandle`) is reused rather than a second rule
 * written.
 */
test('🛑 a traversing handle is refused rather than reaching another manifest', () => {
  assert.throws(() => manifestPathFor('../claude1'), /Invalid handle/);
  assert.throws(() => manifestPathFor('a/b'), /Invalid handle/);
  assert.throws(() => manifestPathFor(''), /Invalid handle/);
});

/**
 * 🛑 A TRAILING SLASH ON `CHAT_MCP_HOME` PUT THE DIRECTORY INSIDE THE MOUNT.
 *
 * `${stateDir()}-manifests` with `CHAT_MCP_HOME=/x/` gives `/x/-manifests`,
 * which is a CHILD. Found by claude1 reviewing the slice, and the guards above
 * could not see it because they all run on one `mkdtempSync` path with no
 * trailing slash.
 *
 * ⚠️ THE SLASH IS PARAMETERISED ON PURPOSE. A guard hardcoding one spelling of
 * the state dir cannot fail on the other.
 */
for (const home of ['/tmp/chat-mcp-trailing', '/tmp/chat-mcp-trailing/']) {
  test(`🛑 the manifest dir stays outside the mount for CHAT_MCP_HOME "${home}"`, (t) => {
    const saved = process.env.CHAT_MCP_HOME;
    t.after(() => {
      process.env.CHAT_MCP_HOME = saved;
    });
    process.env.CHAT_MCP_HOME = home;

    assert.equal(
      manifestDir().startsWith(`${home.replace(/\/$/, '')}/`),
      false,
      `${manifestDir()} is inside the mounted state dir ${stateDir()}`,
    );
  });
}
