import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listAdapters } from '../../src/adapters/index.js';

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
