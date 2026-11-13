import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-freshness-'));

const { buildInputsHash } = await import('../../src/supervise/container.js');

/**
 * 🛑 THE FRESHNESS CHECK HASHED THE DOCKERFILE AND NOTHING ELSE, AND THE
 * DOCKERFILE SAYS `COPY dist ./dist`.
 *
 * So the image is mostly BUILT CODE whose bytes the Dockerfile never
 * mentions. An image built on 2026-11-10 was reported current after three
 * merges, and the container ran a `dist` with no HTTP bus in it — the agent
 * came up and answered nothing. Nobody could have seen it from the check,
 * because the check could only ever have said "fresh".
 *
 * Found by claude2. Their fix landed as a `wip` commit with no test; this is
 * the test it was waiting for.
 */

function dist(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'chat-mcp-dist-'));

  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }

  return root;
}

test('🛑 a CHANGED file in dist forces a rebuild', () => {
  const before = dist({ 'supervise/mcp-http.js': 'export const bus = 1;' });
  const after = dist({ 'supervise/mcp-http.js': 'export const bus = 2;' });

  assert.notEqual(
    buildInputsHash(before),
    buildInputsHash(after),
    'the image would be reported current while running code that no longer exists',
  );
});

test('⚠️ the PAIRED CONTROL — identical bytes do NOT force a rebuild', () => {
  const a = dist({ 'supervise/mcp-http.js': 'export const bus = 1;' });
  const b = dist({ 'supervise/mcp-http.js': 'export const bus = 1;' });

  assert.equal(buildInputsHash(a), buildInputsHash(b));
});

/**
 * 🛑 CONTENT, NOT MTIME. `npm run build` rewrites every file on every run, so
 * an mtime check would rebuild the image on each build even when nothing
 * changed — and a stale dist restored from a backup would pass.
 */
test('🛑 a fresh mtime over IDENTICAL bytes does not force a rebuild', () => {
  const root = dist({ 'supervise/mcp-http.js': 'export const bus = 1;' });
  const first = buildInputsHash(root);

  const future = new Date(Date.now() + 60_000);
  utimesSync(join(root, 'supervise/mcp-http.js'), future, future);

  assert.equal(buildInputsHash(root), first, 'the hash moved on an mtime alone');
});

/**
 * ⚠️ THE SEPARATOR EARNS ITS KEEP HERE. Without `\0<rel>\0` between entries,
 * two trees whose concatenated bytes happen to match would hash the same —
 * so RENAMING a file would be invisible.
 */
test('⚠️ moving a file without changing its bytes forces a rebuild', () => {
  const before = dist({ 'supervise/mcp-http.js': 'bus' });
  const after = dist({ 'supervise/mcp-listener.js': 'bus' });

  assert.notEqual(buildInputsHash(before), buildInputsHash(after));
});

test('🛑 a MISSING dist is distinct from an empty one, and from any built state', () => {
  const missing = join(tmpdir(), `chat-mcp-absent-${process.pid}`);
  rmSync(missing, { recursive: true, force: true });

  const empty = dist({});
  const built = dist({ 'index.js': '' });

  assert.notEqual(buildInputsHash(missing), buildInputsHash(empty));
  assert.notEqual(buildInputsHash(missing), buildInputsHash(built));
});

/**
 * 🛑 THE REGRESSION ITSELF, STATED AS THE ORIGINAL SYMPTOM. Before the fix
 * these two trees hashed IDENTICALLY, because only the Dockerfile was read.
 */
test('🛑 a dist WITHOUT the HTTP bus hashes differently from one WITH it', () => {
  const stale = dist({ 'supervise/index.js': 'x' });
  const current = dist({
    'supervise/index.js': 'x',
    'supervise/mcp-http.js': 'y',
    'supervise/mcp-listener.js': 'z',
  });

  assert.notEqual(
    buildInputsHash(stale),
    buildInputsHash(current),
    'this is the exact pair that reported a bus-less image as current',
  );
});
