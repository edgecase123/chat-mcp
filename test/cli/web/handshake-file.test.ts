import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Point CHAT_MCP_HOME at a scratch dir BEFORE importing anything that reads it.
process.env.CHAT_MCP_HOME = join(mkdtempSync(join(tmpdir(), 'chat-mcp-handshake-')), 'state');

const { ensureStateDir, stateDir, webHandshakeFile, writePrivateFileSync, STATE_FILE_MODE } =
  await import('../../../src/util/paths.js');

const SERVER_SRC = readFileSync(
  new URL('../../../src/cli/web/server.ts', import.meta.url),
  'utf8',
);

const modeOf = (p: string) => statSync(p).mode & 0o777;

/**
 * 🛑 THE OPERATOR SCRIPTS USED TO SCRAPE THE TOKEN OUT OF A LOG FILE.
 *
 * `scripts/web` detaches the server, so the startup banner — the only place the
 * token-bearing url is published — went to `logs/web.log`. That put an
 * admin-capability credential at rest in a log that `pc_log_tail` reprints into
 * a terminal transcript on any startup failure, and that outlives the server it
 * belonged to.
 *
 * This file is the replacement route: one private file, written 0600, removed
 * on shutdown.
 */

test('the handshake file lives under the state directory', () => {
  assert.ok(
    webHandshakeFile().startsWith(stateDir()),
    `expected ${webHandshakeFile()} to be under ${stateDir()}`,
  );
});

/**
 * ⚠️ `credential.ts` SAYS THE TOKEN IS NEVER WRITTEN UNDER `stateDir()`, ON THE
 * GROUNDS THAT THE WHOLE STATE DIR IS MOUNTED INTO EVERY CONTAINER. That was
 * true when #162 measured it. **Re-measured 2026-11-14 against the real mount
 * set** that `dockerRunPlan` builds — `/work` plus one configured extra mount
 * at `/mnt/<key>`, nothing else:
 *
 *   ls /Users/leejenkins/.chat-mcp   ->  No such file or directory
 *   mount | grep chat-mcp            ->  (none)
 *   ls /host_mark                    ->  No such file or directory
 *   ls /work/..                      ->  the CONTAINER root, not the host
 *   find / -maxdepth 6 -name .chat-mcp  ->  (nothing)
 *
 * `assertProjectDirOutsideState` refuses any registered mount that overlaps the
 * state dir, which is what closed it. So a 0600 file here is NOT reachable from
 * a sandboxed agent, and `web-url` staying tokenless is still correct for its
 * own reason: external readers expect a plain url there.
 */
test('🛑 the handshake file is written 0600 even under a permissive umask', () => {
  ensureStateDir();
  const previous = process.umask(0o000);
  try {
    writePrivateFileSync(webHandshakeFile(), 'http://127.0.0.1:3737/?t=secret\n');
  } finally {
    process.umask(previous);
  }
  assert.equal(modeOf(webHandshakeFile()), STATE_FILE_MODE);
  assert.equal(STATE_FILE_MODE, 0o600, 'the private file mode is 0600');
});

test('🛑 the server writes the handshake url ONLY through writePrivateFileSync', () => {
  const writes = SERVER_SRC.split('\n').filter((l) => l.includes('webHandshakeFile()'));

  assert.ok(writes.length > 0, 'server.ts must write the handshake file at all');

  const writeLines = writes.filter((l) => /writeFile|appendFile|createWriteStream/.test(l));
  assert.deepEqual(
    writeLines.filter((l) => !l.includes('writePrivateFileSync')),
    [],
    'a plain writeFile would create the credential file at the umask, not 0600',
  );
});

test('🛑 the handshake file is removed on shutdown, so a token never outlives its server', () => {
  const shutdown = SERVER_SRC.slice(SERVER_SRC.indexOf('const shutdown ='));
  const body = shutdown.slice(0, shutdown.indexOf('process.on('));

  assert.match(
    body,
    /unlink\(webHandshakeFile\(\)\)/,
    'shutdown unlinks webUrlFile(); it must unlink the handshake file too',
  );
});

test('⚠️ control — the tokenless well-known file is still a SEPARATE file', () => {
  assert.notEqual(
    webHandshakeFile(),
    join(stateDir(), 'web-url'),
    'collapsing the two would put the token in the file external readers expect plain',
  );
  assert.ok(existsSync(stateDir()));
});
