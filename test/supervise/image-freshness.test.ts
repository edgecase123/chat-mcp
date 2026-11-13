import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  utimesSync,
  symlinkSync,
} from 'node:fs';
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
/**
 * Every path a Dockerfile reads OUT OF THE BUILD CONTEXT.
 *
 * 🛑 `ADD` COUNTS AND LINE CONTINUATIONS MUST BE JOINED FIRST. The first
 * version matched `COPY` on a raw line and FAILED OPEN on both — an added
 * `ADD entrypoint.sh` parsed clean while being completely unhashed. A guard
 * that fails open is worse than no guard, because it is read as a promise.
 * Measured and raised by claude2 on PR 211.
 *
 * ⚠️ `--from=` IS EXCLUDED ON PURPOSE. It copies from an earlier build
 * STAGE, not from the context, so there is no local file to hash.
 */
export function contextSources(dockerfile: string): string[] {
  const joined = dockerfile.replace(/\\\r?\n/g, ' ');
  const sources: string[] = [];

  for (const raw of joined.split('\n')) {
    const line = raw.trim();

    if (line.startsWith('#')) continue;
    if (!/^(COPY|ADD)\s/i.test(line)) continue;

    // 🛑 A REGEX, NOT `indexOf(' ')`. A TAB after the instruction word made
    // `indexOf` find the space before the DESTINATION instead, so
    // `COPY\tsecrets.env ./` parsed to [] — a fail-open on one character.
    // Measured and raised by claude2 on PR 211.
    let rest = line.replace(/^(COPY|ADD)\s+/i, '').trim();
    let fromStage = false;

    while (rest.startsWith('--')) {
      const flag = /^(\S+)\s*/.exec(rest);

      if (!flag) break;
      if (flag[1]!.startsWith('--from=')) fromStage = true;

      rest = rest.slice(flag[0].length);
    }

    if (fromStage) continue;

    // The JSON-array form is as legal as the shell form.
    const tokens: string[] = rest.startsWith('[')
      ? (JSON.parse(rest) as string[])
      : rest.split(/\s+/);

    // ⚠️ PER LINE. The first version sliced the FLATTENED list, so it
    // dropped one token in total and a third COPY leaked its destination
    // through as a phantom source.
    sources.push(...tokens.slice(0, -1).filter((t) => t !== '.' && t !== './'));
  }

  return sources;
}

/**
 * 🛑 THE GUARD FOR THE WHOLE CLASS, NOT THE INSTANCES WE FOUND.
 *
 * `dist` was missed, then both manifests were missed in the fix for `dist`.
 * Same defect each time: the Dockerfile reads something the hash does not.
 * This fails the moment a `COPY` or `ADD` names a context source that
 * `BUILD_INPUT_PATHS` does not cover.
 */
test('🛑 EVERY source the Dockerfile reads from the context is a hashed build input', () => {
  const sources = contextSources(readFileSync(dockerfilePath(), 'utf8'));

  // ⚠️ AN EXACT COUNT, NOT `> 0`. A parser that finds 1 of 3 would
  // otherwise pass while seeing almost nothing. Raised by claude2.
  assert.equal(
    sources.length,
    BUILD_INPUT_PATHS.length,
    `parsed ${sources.length} context source(s) (${sources.join(', ')}); the guard is stale`,
  );

  const unhashed = sources.filter(
    (src) => !(BUILD_INPUT_PATHS as readonly string[]).includes(src),
  );

  assert.deepEqual(
    unhashed,
    [],
    `the Dockerfile reads ${unhashed.join(', ')}, which the freshness hash never sees`,
  );
});

/**
 * ⚠️ THE GUARD'S OWN PAIRED CONTROLS. Each row is a shape that the first
 * parser got wrong, and three of them FAILED OPEN.
 */
test('⚠️ the Dockerfile parser sees ADD, continuations and the JSON form', () => {
  const cases: [string, string, string[]][] = [
    ['plain COPY', 'COPY dist ./dist', ['dist']],
    ['ADD, which was invisible', 'ADD entrypoint.sh /entrypoint.sh', ['entrypoint.sh']],
    ['two sources on one line', 'COPY package.json package-lock.json ./', ['package.json', 'package-lock.json']],
    ['a line continuation', 'COPY \\\n  tsconfig.json \\\n  ./', ['tsconfig.json']],
    ['the JSON-array form', 'COPY ["src.js", "dest.js"]', ['src.js']],
    ['a comment, not an instruction', '# COPY secrets.env ./', []],
    ['--chown does not eat the source', 'COPY --chown=agent:agent dist ./dist', ['dist']],
    ['--from reads a STAGE, not the context', 'COPY --from=build /app/dist ./dist', []],

    // 🛑 EVERY ROW BELOW FAILED OPEN OR MISPARSED BEFORE. A tab is the
    // one-character version of the whole defect.
    ['a TAB after the instruction', 'COPY\tsecrets.env ./', ['secrets.env']],
    ['a TAB after ADD', 'ADD\tentrypoint.sh /entrypoint.sh', ['entrypoint.sh']],
    ['lowercase add', 'add entrypoint.sh /x', ['entrypoint.sh']],
    ['runs of spaces', 'COPY   dist   ./dist', ['dist']],
    ['a CRLF line ending', 'COPY dist ./dist\r', ['dist']],
  ];

  for (const [label, line, expected] of cases) {
    assert.deepEqual(contextSources(line), expected, label);
  }
});

/**
 * ⚠️ A HEREDOC IS NOT SUPPORTED, AND IT FAILS CLOSED ON PURPOSE.
 *
 * `COPY <<EOF /app/f` writes inline content rather than reading a context
 * file, so there is nothing to hash. The parser does not understand it and
 * reports `<<EOF` as a source — which makes the class guard FAIL rather than
 * pass. That is the correct direction: a shape nobody has thought about stops
 * the build instead of being silently waved through.
 */
test('⚠️ an unsupported heredoc COPY fails the guard rather than passing it', () => {
  const parsed = contextSources('COPY <<EOF /app/f');

  assert.notDeepEqual(parsed, [], 'a heredoc parsed to nothing, which is a fail-open');
  assert.ok(!(BUILD_INPUT_PATHS as readonly string[]).includes(parsed[0]!));
});

/**
 * ⚠️ THE DESTINATION-LEAK CONTROL. The first parser sliced the FLATTENED
 * token list, so with three instructions a destination leaked through as a
 * phantom source and the guard failed for the wrong reason.
 */
test('⚠️ a third COPY does not leak its destination as a source', () => {
  const dockerfile = ['COPY a ./a', 'COPY b ./b', 'COPY c ./c'].join('\n');

  assert.deepEqual(contextSources(dockerfile), ['a', 'b', 'c']);
});

/**
 * 🛑 A BROKEN SYMLINK UNDER dist TOOK THE SUPERVISOR DOWN. `statSync`
 * throws on one, so `supervise --container` died with an opaque ENOENT
 * instead of rebuilding the image. Raised by claude2 on PR 211.
 */
test('🛑 a broken symlink under dist does not throw, and still moves the hash', () => {
  const intact = dist({ 'index.js': 'x' });

  const dangling = dist({ 'index.js': 'x' });
  symlinkSync(join(dangling, 'dist', 'nowhere'), join(dangling, 'dist', 'link.js'));

  const hashed = buildInputsHash(dangling);

  assert.equal(typeof hashed, 'string');
  assert.notEqual(
    hashed,
    buildInputsHash(intact),
    'a dangling link hashed the same as no link, so swapping a real file for one would not rebuild',
  );
});

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
