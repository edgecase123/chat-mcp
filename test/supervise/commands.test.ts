import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-commands-'));

const {
  parseManifest: parseRaw,
  readManifest,
  listCommands,
  resolveArgv,
} = await import('../../src/supervise/commands.js');
type CommandParam = import('../../src/supervise/commands.js').CommandParam;

/** Absolute, because `projectDir` must be. Never touched on disk here. */
const PROJECT_DIR = '/srv/project';

/**
 * `parseManifest` with the required `projectDir` filled in.
 *
 * 🛑 THE CASES THAT ARE ABOUT `projectDir` ITSELF CALL `parseRaw` DIRECTLY, or
 * this helper would supply the very field they assert is required. A manifest
 * that names its own `projectDir` still wins — the spread comes second.
 */
function parseManifest(raw: unknown): ReturnType<typeof parseRaw> {
  const withDir =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? { projectDir: PROJECT_DIR, ...raw }
      : raw;

  return parseRaw(withDir);
}

/**
 * The sample the ticket names: one enumerated positional with a default,
 * matching a script whose body is `MODE="${1:-all}"`.
 */
const GATE = {
  projectDir: PROJECT_DIR,
  commands: [
    {
      name: 'run-gate',
      script: 'scripts/reset-and-test.sh',
      params: [{ name: 'mode', type: 'enum', values: ['all', 'php', 'e2e'], default: 'all' }],
    },
    { name: 'run-deploy', script: 'scripts/deploy-manual.sh' },
  ],
};

test('the ticket’s sample command parses', () => {
  const m = parseManifest(GATE);
  assert.equal(m.commands.length, 2);
  assert.equal(m.commands[0]?.name, 'run-gate');
});

test('a single enumerated positional with a default resolves to one argv entry', () => {
  const resolved = resolveArgv(parseManifest(GATE), 'run-gate', {});
  assert.deepEqual(resolved.argv, ['all']);
  assert.equal(resolved.script.relative, 'scripts/reset-and-test.sh');
});

test('an explicit enum value overrides the default', () => {
  assert.deepEqual(resolveArgv(parseManifest(GATE), 'run-gate', { mode: 'e2e' }).argv, ['e2e']);
});

test('a command with no params resolves to an empty argv', () => {
  assert.deepEqual(resolveArgv(parseManifest(GATE), 'run-deploy', {}).argv, []);
});

// ── listCommands must not leak the script path ───────────────────────────────

test('🛑 listCommands never discloses a script path', () => {
  const listed = listCommands(parseManifest(GATE));
  const serialized = JSON.stringify(listed);

  assert.ok(!serialized.includes('scripts/'), `script path leaked: ${serialized}`);
  assert.ok(!serialized.includes('reset-and-test'), `script path leaked: ${serialized}`);
  // The guard above is only meaningful if the field it looks for is absent by
  // NAME too, not just by this manifest's spelling.
  for (const entry of listed) {
    assert.ok(!('script' in entry), 'a listed command carried a script field');
  }
});

test('listCommands still reports the names and the param schema', () => {
  const listed = listCommands(parseManifest(GATE));
  assert.deepEqual(
    listed.map((c) => c.name),
    ['run-gate', 'run-deploy'],
  );
  assert.deepEqual(listed[0]?.params, [
    { name: 'mode', type: 'enum', values: ['all', 'php', 'e2e'], default: 'all' },
  ]);
});

// ── the script path is the privilege boundary ────────────────────────────────

test('🛑 an absolute script path is refused', () => {
  assert.throws(
    () => parseManifest({ commands: [{ name: 'shell', script: '/bin/sh' }] }),
    /must be a relative path/,
  );
});

test('🛑 a script path escaping the project dir is refused', () => {
  assert.throws(
    () => parseManifest({ commands: [{ name: 'up', script: '../../bin/sh' }] }),
    /must stay inside the project/,
  );
});

test('🛑 a script path escaping VIA A MIDDLE SEGMENT is refused', () => {
  // `scripts/../../bin/sh` normalises OUT of the project, and a naive
  // startsWith('..') check reads it as contained.
  assert.throws(
    () => parseManifest({ commands: [{ name: 'sneaky', script: 'scripts/../../bin/sh' }] }),
    /must stay inside the project/,
  );
});

test('a normalising-but-contained script path is allowed', () => {
  const m = parseManifest({ commands: [{ name: 'ok', script: 'scripts/../scripts/go.sh' }] });
  assert.equal(m.commands[0]?.script, 'scripts/go.sh');
});

// ── manifest-shape validation ────────────────────────────────────────────────

test('a manifest that is not an object is refused', () => {
  for (const bad of [null, 42, 'commands', []]) {
    assert.throws(() => parseManifest(bad), /manifest must be an object/, `accepted ${JSON.stringify(bad)}`);
  }
});

test('a manifest with no commands array is refused', () => {
  assert.throws(() => parseManifest({}), /needs a "commands" array/);
});

test('duplicate command names are refused', () => {
  assert.throws(
    () =>
      parseManifest({
        commands: [
          { name: 'run-gate', script: 'a.sh' },
          { name: 'run-gate', script: 'b.sh' },
        ],
      }),
    /duplicate command/,
  );
});

test('an enum param with no values is refused', () => {
  assert.throws(
    () =>
      parseManifest({
        commands: [{ name: 'g', script: 'a.sh', params: [{ name: 'mode', type: 'enum' }] }],
      }),
    /needs a non-empty "values"/,
  );
});

test('a default outside the enum values is refused', () => {
  assert.throws(
    () =>
      parseManifest({
        commands: [
          {
            name: 'g',
            script: 'a.sh',
            params: [{ name: 'mode', type: 'enum', values: ['all'], default: 'nope' }],
          },
        ],
      }),
    /default "nope" is not one of/,
  );
});

test('an unknown param type is refused', () => {
  assert.throws(
    () =>
      parseManifest({
        commands: [{ name: 'g', script: 'a.sh', params: [{ name: 'n', type: 'string' }] }],
      }),
    /unknown param type/,
  );
});

test('duplicate param names within one command are refused', () => {
  assert.throws(
    () =>
      parseManifest({
        commands: [
          {
            name: 'g',
            script: 'a.sh',
            params: [
              { name: 'mode', type: 'enum', values: ['a'] },
              { name: 'mode', type: 'enum', values: ['a'] },
            ],
          },
        ],
      }),
    /duplicate param/,
  );
});

// ── resolveArgv rejects what the schema does not describe ────────────────────

test('an unknown command is refused', () => {
  assert.throws(() => resolveArgv(parseManifest(GATE), 'rm-rf', {}), /no command "rm-rf"/);
});

test('🛑 a param the schema does not declare is refused, not ignored', () => {
  assert.throws(
    () => resolveArgv(parseManifest(GATE), 'run-gate', { mode: 'all', extra: '; rm -rf /' }),
    /unknown param "extra"/,
  );
});

test('🛑 an enum value outside the declared set is refused', () => {
  assert.throws(
    () => resolveArgv(parseManifest(GATE), 'run-gate', { mode: 'all; rm -rf /' }),
    /not one of/,
  );
});

test('a required param with no default cannot be omitted', () => {
  const m = parseManifest({
    commands: [{ name: 'g', script: 'a.sh', params: [{ name: 'target', type: 'enum', values: ['x'] }] }],
  });
  assert.throws(() => resolveArgv(m, 'g', {}), /needs a value for "target"/);
});

test('a non-string param value is refused', () => {
  assert.throws(
    () => resolveArgv(parseManifest(GATE), 'run-gate', { mode: 7 as unknown as string }),
    /must be a string/,
  );
});

test('argv order follows the declared param order, not the caller’s key order', () => {
  const m = parseManifest({
    commands: [
      {
        name: 'g',
        script: 'a.sh',
        params: [
          { name: 'first', type: 'enum', values: ['A'] },
          { name: 'second', type: 'enum', values: ['B'] },
        ],
      },
    ],
  });
  assert.deepEqual(resolveArgv(m, 'g', { second: 'B', first: 'A' }).argv, ['A', 'B']);
});

// ── readManifest ─────────────────────────────────────────────────────────────

test('readManifest parses a file from disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-mcp-manifest-'));
  const path = join(dir, 'commands.json');
  writeFileSync(path, JSON.stringify(GATE));

  assert.equal(readManifest(path).commands.length, 2);
});

test('🛑 readManifest THROWS on a malformed file rather than reading as empty', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-mcp-manifest-bad-'));
  const path = join(dir, 'commands.json');
  writeFileSync(path, '{ "commands": [,] }');

  assert.throws(() => readManifest(path), /is not valid JSON/);
});

test('readManifest throws a path-naming error when the file is absent', () => {
  assert.throws(() => readManifest(join(tmpdir(), 'definitely-not-here-1337', 'commands.json')), /no command manifest at/);
});

// ── the resolved script is not a runnable path ───────────────────────────────

test('🛑 resolveArgv hands back an UncheckedScript, not a path', () => {
  const resolved = resolveArgv(parseManifest(GATE), 'run-gate', {});

  // A bare string here would be assignable to execFile's first argument, which
  // is exactly the lexical-containment mistake `checkedScriptPath` exists to
  // stop. The object shape is the compile-time guard.
  assert.equal(typeof resolved.script, 'object');
  assert.equal(resolved.script.relative, 'scripts/reset-and-test.sh');
});

// ── the fixes from the security review ───────────────────────────────────────

test('🛑 a free-form "string" param type no longer exists', () => {
  assert.throws(
    () =>
      parseManifest({
        commands: [{ name: 'g', script: 'a.sh', params: [{ name: 'n', type: 'string' }] }],
      }),
    /unknown param type/,
  );
});

test('🛑 an enum value that starts with "-" is refused', () => {
  // `-e/bin/sh` and `--upload-pack=…` are flags to whatever the script execs.
  // execFile without a shell does not neutralise that.
  assert.throws(
    () =>
      parseManifest({
        commands: [
          { name: 'g', script: 'a.sh', params: [{ name: 'm', type: 'enum', values: ['-rf'] }] },
        ],
      }),
    /must not start with "-"/,
  );
});

test('🛑 a NUL in a script path is refused BEFORE normalize hides it', () => {
  // normalize('scripts/gate.sh\0../../bin/sh') returns the innocent-looking
  // 'scripts/bin/sh'.
  assert.throws(
    () => parseManifest({ commands: [{ name: 'g', script: 'scripts/gate.sh\u0000../../bin/sh' }] }),
    /control character/,
  );
});

test('a newline in a script path is refused', () => {
  assert.throws(
    () => parseManifest({ commands: [{ name: 'g', script: 'scripts/a.sh\nrm -rf /' }] }),
    /control character/,
  );
});

test('🛑 a script path segment starting with "-" is refused', () => {
  assert.throws(
    () => parseManifest({ commands: [{ name: 'g', script: '-rf' }] }),
    /must not have a path segment starting with "-"/,
  );
  assert.throws(
    () => parseManifest({ commands: [{ name: 'g', script: 'scripts/-rf' }] }),
    /must not have a path segment starting with "-"/,
  );
});

test('a filename that merely begins with dots is still allowed', () => {
  const m = parseManifest({ commands: [{ name: 'g', script: '..foo/bar.sh' }] });
  assert.equal(m.commands[0]?.script, '..foo/bar.sh');
});

test('🛑 mutating listCommands output cannot widen the manifest', () => {
  const m = parseManifest(GATE);
  const listed = listCommands(m);

  assert.notEqual(listed[0]?.params, m.commands[0]?.params);
  (listed[0]?.params as CommandParam[]).push({ name: 'injected', type: 'enum', values: ['x'] });

  assert.throws(() => resolveArgv(m, 'run-gate', { injected: 'x' }), /unknown param "injected"/);
});

test('🛑 the enum values array is copied too, not shared', () => {
  const m = parseManifest(GATE);
  const listed = listCommands(m);

  assert.notEqual(listed[0]?.params[0]?.values, m.commands[0]?.params?.[0]?.values);
  (listed[0]?.params[0]?.values as string[]).push('injected');

  assert.throws(() => resolveArgv(m, 'run-gate', { mode: 'injected' }), /not one of/);
});

test('a param name outside the allowed charset is refused', () => {
  for (const bad of ['__proto__', '-flag', 'has space', '', 'a.b', 'a/b']) {
    assert.throws(
      () =>
        parseManifest({
          commands: [
            { name: 'g', script: 'a.sh', params: [{ name: bad, type: 'enum', values: ['x'] }] },
          ],
        }),
      undefined,
      `accepted param name ${JSON.stringify(bad)}`,
    );
  }
});

test('a param NAMED constructor is allowed, and hasOwn is what makes it safe', () => {
  // `constructor` matches the name charset. It is harmless because the lookup
  // is `Object.hasOwn`, not `params[name]` — so the inherited function is
  // never mistaken for a supplied value.
  const m = parseManifest({
    commands: [
      { name: 'g', script: 'a.sh', params: [{ name: 'constructor', type: 'enum', values: ['x'] }] },
    ],
  });

  assert.throws(() => resolveArgv(m, 'g', {}), /needs a value for "constructor"/);
  assert.deepEqual(resolveArgv(m, 'g', { constructor: 'x' }).argv, ['x']);
});

test('🛑 a prototype key cannot stand in for a supplied value', () => {
  const m = parseManifest({
    commands: [{ name: 'g', script: 'a.sh', params: [{ name: 'mode', type: 'enum', values: ['x'] }] }],
  });

  // `{}.toString` is truthy, so a plain `params[name]` lookup would have found
  // a function here rather than reporting the param as missing.
  assert.throws(() => resolveArgv(m, 'g', Object.create({ mode: 'x' })), /needs a value for "mode"/);
});


// ── #133 slice 3a: the manifest declares its own project directory ──────────

test('the manifest carries its own projectDir, so nothing reads projects.json', () => {
  const m = parseRaw({ projectDir: '/srv/project', commands: [] });

  assert.equal(m.projectDir, '/srv/project');
});

test('🛑 projectDir is REQUIRED, because there is no safe place to fall back to', () => {
  // Falling back to `dirsFor(handle)` reads `projects.json`, which sits inside
  // the state directory every container mounts read-write.
  assert.throws(() => parseRaw({ commands: [] }), /needs a non-empty "projectDir"/);
  assert.throws(() => parseRaw({ projectDir: '', commands: [] }), /needs a non-empty "projectDir"/);
  assert.throws(() => parseRaw({ projectDir: 7, commands: [] }), /needs a non-empty "projectDir"/);
});

test('🛑 projectDir must be ABSOLUTE, unlike every other path in the manifest', () => {
  // A relative one would resolve against the supervisor's cwd, which is not
  // the project and is not even stable.
  assert.throws(
    () => parseRaw({ projectDir: 'srv/project', commands: [] }),
    /must be an absolute path/,
  );
  assert.throws(() => parseRaw({ projectDir: './project', commands: [] }), /must be an absolute path/);
});

test('projectDir with a control character in it refuses', () => {
  assert.throws(
    () => parseRaw({ projectDir: '/srv/pro\u0000ject', commands: [] }),
    /control character/,
  );
});

test('projectDir is normalised, so one directory has one spelling', () => {
  assert.equal(parseRaw({ projectDir: '/srv//project/', commands: [] }).projectDir, '/srv/project/');
  assert.equal(parseRaw({ projectDir: '/srv/./project', commands: [] }).projectDir, '/srv/project');
});

// ── #133 slice 3a: the declared read-only paths ─────────────────────────────

test('readOnlyPaths parses and keeps the declared order', () => {
  const m = parseManifest({ readOnlyPaths: ['scripts', 'bin'], commands: [] });

  assert.deepEqual(m.readOnlyPaths, ['scripts', 'bin']);
});

test('🛑 chat-mcp SHIPS NO DEFAULT: absent readOnlyPaths stays absent', () => {
  // Deriving `dirname(spec.script)` would encode one consumer's layout.
  const m = parseManifest({ commands: [{ name: 'g', script: 'scripts/gate.sh' }] });

  assert.equal(m.readOnlyPaths, undefined);
  assert.ok(!('readOnlyPaths' in m), 'the key itself must be absent, not undefined');
});

test('an empty readOnlyPaths array is kept as empty, not dropped', () => {
  // Declaring none and declaring nothing are the same to the spawn, but an
  // operator who wrote `[]` deliberately should see it round-trip.
  assert.deepEqual(parseManifest({ readOnlyPaths: [], commands: [] }).readOnlyPaths, []);
});

test('a readOnlyPaths that is not an array refuses', () => {
  assert.throws(() => parseManifest({ readOnlyPaths: 'scripts', commands: [] }), /must be an array/);
});

test('🛑 a read-only path gets the SAME containment check as a script path', () => {
  // One shared `containedRelative`, so there is no second copy to drift.
  for (const [entry, pattern] of [
    ['/etc', /must be a relative path/],
    ['../../etc', /must stay inside the project/],
    ['scripts/../../etc', /must stay inside the project/],
    ['scripts/\u0000x', /control character/],
    ['-rf', /starting with "-"/],
    ['', /must be a non-empty string/],
  ] as const) {
    assert.throws(
      () => parseManifest({ readOnlyPaths: [entry], commands: [] }),
      pattern,
      `accepted ${JSON.stringify(entry)}`,
    );
  }
});

test('🛑 EVERY spelling of the project root refuses, or the agent cannot edit its own repo', () => {
  for (const entry of ['.', './', 'scripts/..', 'scripts/../.']) {
    assert.throws(
      () => parseManifest({ readOnlyPaths: [entry], commands: [] }),
      /may not be the project root/,
      `accepted ${JSON.stringify(entry)}`,
    );
  }
});

test('a read-only path is canonicalised, so the stored value is the one that gets mounted', () => {
  const m = parseManifest({
    readOnlyPaths: ['scripts/', 'bin///', './lib', 'a/./b'],
    commands: [],
  });

  assert.deepEqual(m.readOnlyPaths, ['scripts', 'bin', 'lib', 'a/b']);
});

test('🛑 a DUPLICATE read-only path refuses, including two spellings of one directory', () => {
  // Silently de-duplicating hides an author's mistake, and `scripts` plus
  // `scripts/` is the shape that mistake takes.
  assert.throws(
    () => parseManifest({ readOnlyPaths: ['scripts', 'scripts/'], commands: [] }),
    /duplicate read-only path "scripts"/,
  );
});

test('readManifest reads projectDir and readOnlyPaths off disk too', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chat-mcp-manifest-fields-'));
  const path = join(dir, 'commands.json');
  writeFileSync(
    path,
    JSON.stringify({ projectDir: '/srv/project', readOnlyPaths: ['scripts'], commands: [] }),
  );

  const m = readManifest(path);

  assert.equal(m.projectDir, '/srv/project');
  assert.deepEqual(m.readOnlyPaths, ['scripts']);
});
