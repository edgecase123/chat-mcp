import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * 🛑 `--handle Alice` PRINTED A RAW STACK TRACE, AND AN MCP CLIENT SHOWS THAT
 * AS "the server failed to start".
 *
 * The handle became lowercase-only to close #200, where APFS handed `alice`
 * the handle `Alice` and then served the wrong agent's DMs. The refusal is
 * correct; it was only reaching the operator as a crash.
 *
 * `runShimEntry` already does this for a claimed handle, and the reason in its
 * comment is this same one. An invalid handle took the uncaught path instead,
 * through `NotifyBus` -> `notifyPathFor` -> `assertHandle`.
 */

const ENTRY = new URL('../../src/index.ts', import.meta.url).pathname;

function runEntry(t: TestContext, handle: string, timeout: number) {
  // A scratch root: a legal handle really does start a shim, and it must not
  // bind a socket in the operator's live state directory to do it.
  const home = mkdtempSync(join(tmpdir(), 'cm-handle-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  return spawnSync(process.execPath, ['--import', 'tsx', ENTRY, '--handle', handle], {
    encoding: 'utf8',
    timeout,
    env: { ...process.env, CHAT_MCP_HOME: home },
  });
}

/**
 * ⚠️ THE STACK FRAME IS THE ASSERTION, NOT THE EXIT CODE. `EXIT 1` was already
 * true of the crash, so a test reading only the code passes either way.
 */
test('🚨 an invalid handle is refused in one line, with no stack trace', (t) => {
  const r = runEntry(t, 'Alice', 20_000);

  assert.equal(r.status, 1, `expected a clean refusal exit, got ${r.status}`);
  assert.match(r.stderr, /invalid handle "Alice"/i, 'the refusal does not name the handle');
  assert.match(r.stderr, /lowercase/i, 'the refusal does not say what is wrong with it');

  assert.doesNotMatch(r.stderr, /^\s+at /m, `a stack frame reached stderr:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /Node\.js v/, 'node printed its own crash footer');
  assert.doesNotMatch(r.stderr, /naming\.ts:/, 'the throw site leaked into the message');
});

/**
 * 🛑 THE PAIRED CONTROL. A guard that refuses every handle passes the test
 * above, so a LEGAL handle must be shown to boot.
 *
 * 🛑 THE EXIT CODE IS HALF OF THIS TEST, AND LEAVING IT OUT COST A REVIEW
 * ROUND. A legal handle writes NOTHING to stderr, so the absence of the
 * refusal is true however badly the shim broke. Measured by claude2 with an
 * unrelated `throw` at the top of `runShim`: both tests stayed green.
 *
 * `spawnSync` sends no input, so the stdio transport sees EOF immediately and
 * the shim exits 0 in about 0.2s. ⚠️ The timeout is a backstop against a hang
 * regression, NOT the thing that ends this run.
 */
test('🚨 a legal handle boots and is not refused', (t) => {
  const r = runEntry(t, 'alice', 8_000);

  assert.equal(r.status, 0, `a legal handle did not boot cleanly:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /invalid handle/i, `a legal handle was refused:\n${r.stderr}`);
});
