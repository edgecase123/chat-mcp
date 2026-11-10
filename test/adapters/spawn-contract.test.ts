import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { listAdapters, spawnFor, vendorsWithSpawn } from '../../src/adapters/index.js';

function tsFilesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return tsFilesUnder(path);

    return path.endsWith('.ts') ? [path] : [];
  });
}

test('every adapter declares which vendor CLI it is for', () => {
  for (const adapter of listAdapters()) {
    assert.equal(typeof adapter.vendor, 'string', `adapter "${adapter.name}" has no vendor`);
    assert.ok(adapter.vendor.length > 0, `adapter "${adapter.name}" has an empty vendor`);
  }
});

test('🛑 no vendor has two adapters carrying spawn config', () => {
  const owners = new Map<string, string[]>();

  for (const adapter of listAdapters()) {
    if (!adapter.spawn) continue;
    owners.set(adapter.vendor, [...(owners.get(adapter.vendor) ?? []), adapter.name]);
  }

  for (const [vendor, names] of owners) {
    assert.equal(
      names.length,
      1,
      `vendor "${vendor}" has ${names.length} adapters carrying spawn: ${names.join(', ')}`,
    );
  }
});

test('spawnFor resolves the claude vendor to a spawn block', () => {
  assert.equal(spawnFor('claude').binary, 'claude');
});

test('🛑 spawnFor throws and names what exists, rather than falling back', () => {
  // A silent fallback to claude would mean asking for cursor and getting
  // claude, which looks exactly like cursor working.
  assert.throws(() => spawnFor('cursor'), /cursor/);
  assert.throws(() => spawnFor('cursor'), /claude/);
});

test('vendorsWithSpawn lists every vendor that can be spawned', () => {
  assert.deepEqual([...vendorsWithSpawn()].sort(), ['claude']);
});

test('🛑 nothing under supervise/ imports adapters/, so the dependency stays one-way', () => {
  // The spawn contract lives in supervise/vendor.ts for exactly this reason.
  // Defining it beside Adapter reads as tidier and closes a cycle, because the
  // generic spawners would then import adapters/types.js. This test is the
  // only thing that notices.
  const root = fileURLToPath(new URL('../../src/supervise', import.meta.url));
  const offenders = tsFilesUnder(root).filter((path) =>
    /from '[^']*adapters\//.test(readFileSync(path, 'utf8')),
  );

  assert.deepEqual(
    offenders.map((p) => p.slice(root.length + 1)),
    [],
  );
});
