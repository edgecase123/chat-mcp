import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-freshness-'));

const { buildInputsHash, BUILD_INPUT_PATHS, dockerfilePath } = await import(
  '../../src/supervise/container.js'
);

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

/** A build context whose `dist/` holds `files`, plus the two manifests. */
function dist(files: Record<string, string>, manifests?: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'chat-mcp-ctx-'));

  writeFileSync(join(root, 'package.json'), manifests?.['package.json'] ?? '{"name":"x"}');
  writeFileSync(join(root, 'package-lock.json'), manifests?.['package-lock.json'] ?? '{"v":1}');

  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, 'dist', rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body);
  }

  if (Object.keys(files).length === 0) mkdirSync(join(root, 'dist'), { recursive: true });

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
  utimesSync(join(root, 'dist/supervise/mcp-http.js'), future, future);

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
  const missing = mkdtempSync(join(tmpdir(), 'chat-mcp-nodist-'));
  writeFileSync(join(missing, 'package.json'), '{"name":"x"}');
  writeFileSync(join(missing, 'package-lock.json'), '{"v":1}');

  const empty = dist({});
  const built = dist({ 'index.js': '' });

  assert.notEqual(buildInputsHash(missing), buildInputsHash(empty));
  assert.notEqual(buildInputsHash(missing), buildInputsHash(built));
});

/**
 * ⚠️ THE SECOND HALF OF THE SAME HOLE. The Dockerfile copies both manifests
 * and runs `npm ci`, so a dependency bump changes what the image contains
 * while the Dockerfile stays byte-identical. Raised by claude2 on PR 211.
 */
test('⚠️ a bumped package-lock.json forces a rebuild', () => {
  const before = dist({ 'index.js': 'x' }, { 'package-lock.json': '{"v":1}' });
  const after = dist({ 'index.js': 'x' }, { 'package-lock.json': '{"v":2}' });

  assert.notEqual(
    buildInputsHash(before),
    buildInputsHash(after),
    'a dependency change would ship an image built against the old tree',
  );
});

test('⚠️ a changed package.json forces a rebuild', () => {
  const before = dist({ 'index.js': 'x' }, { 'package.json': '{"name":"x"}' });
  const after = dist({ 'index.js': 'x' }, { 'package.json': '{"name":"y"}' });

  assert.notEqual(buildInputsHash(before), buildInputsHash(after));
});

/**
 * 🛑 THE GUARD FOR THE WHOLE CLASS, NOT THE TWO INSTANCES WE FOUND.
 *
 * `dist` was missed, then `package.json` and `package-lock.json` were missed
 * in the fix for `dist`. Both are the same defect: the Dockerfile copies
 * something the hash does not read. This fails the moment a `COPY` line names
 * a source that `BUILD_INPUT_PATHS` does not cover, so the third instance
 * cannot ship.
 */
test('🛑 EVERY source the Dockerfile copies is a hashed build input', () => {
  const dockerfile = readFileSync(dockerfilePath(), 'utf8');

  const copied = dockerfile
    .split('\n')
    .filter((line) => /^\s*COPY\s/i.test(line))
    .flatMap((line) => line.trim().split(/\s+/).slice(1))
    .filter((token) => !token.startsWith('--'))
    // The last token of a COPY is the DESTINATION, not a source.
    .slice(0, -1)
    .filter((token) => token !== '.' && token !== './');

  assert.ok(copied.length > 0, 'no COPY sources parsed; this guard is stale');

  const unhashed = copied.filter(
    (src) => !(BUILD_INPUT_PATHS as readonly string[]).includes(src),
  );

  assert.deepEqual(
    unhashed,
    [],
    `the Dockerfile copies ${unhashed.join(', ')}, which the freshness hash never reads`,
  );
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
