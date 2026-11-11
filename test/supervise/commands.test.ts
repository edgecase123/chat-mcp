import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.CHAT_MCP_HOME = mkdtempSync(join(tmpdir(), 'chat-mcp-commands-'));

const { parseManifest, readManifest, listCommands, resolveArgv } = await import(
  '../../src/supervise/commands.js'
);

/**
 * The sample the ticket names: one enumerated positional with a default,
 * matching a script whose body is `MODE="${1:-all}"`.
 */
const GATE = {
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
  assert.equal(resolved.script, 'scripts/reset-and-test.sh');
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
        commands: [{ name: 'g', script: 'a.sh', params: [{ name: 'n', type: 'number' }] }],
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
              { name: 'mode', type: 'string' },
              { name: 'mode', type: 'string' },
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
    commands: [{ name: 'g', script: 'a.sh', params: [{ name: 'target', type: 'string' }] }],
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
          { name: 'first', type: 'string' },
          { name: 'second', type: 'string' },
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
