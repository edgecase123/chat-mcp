import { test } from 'node:test';
import assert from 'node:assert/strict';
import { healthResult } from '../../src/shim/tools/health.js';
import type { HealthResult } from '../../src/shim/tools/health.js';
import { SCHEMA_VERSION } from '../../src/storage/db.js';

/**
 * #138 — the ASSEMBLY, not the individual readings.
 *
 * 🛑 `warnings` IS A SHAPE AGENTS READ, and it replaced a singular `warning`
 * string. Two faults can be live at once, so the branch that matters is the
 * one where BOTH land — a single-key result would have hidden the second.
 */

const marks = (overrides: Partial<Parameters<typeof healthResult>[0]> = {}) =>
  healthResult({
    handle: 'claude1',
    db_path: '/tmp/x/chat.db',
    health: { max_id: 13504, autoincrement_seq: 13504, schema_version: SCHEMA_VERSION },
    atOpen: { dev: 16777231, ino: 89743418 },
    now: { dev: 16777231, ino: 89743418 },
    ...overrides,
  });

/** The typed `warnings`, asserted present so no test reads `undefined[0]` as a pass. */
function warningsOf(result: HealthResult): string[] {
  assert.ok(result.warnings, 'the result carries no warnings key');
  return result.warnings;
}

test('🛑 a clean bus OMITS the warnings key, so its PRESENCE is the signal', () => {
  const result = marks();

  assert.equal('warnings' in result, false);
  assert.equal(result.db_identity_matches, true);
  assert.equal(result.schema_matches, true);
});

test('a schema mismatch alone produces exactly one warning', () => {
  const result = marks({
    health: { max_id: 1, autoincrement_seq: 1, schema_version: SCHEMA_VERSION - 1 },
  });

  assert.equal(warningsOf(result).length, 1);
  assert.match(warningsOf(result)[0], /schema/);
  assert.equal(result.schema_matches, false);
});

test('an inode divergence alone produces exactly one warning', () => {
  const result = marks({ now: { dev: 16777231, ino: 89743422 } });

  assert.equal(warningsOf(result).length, 1);
  assert.match(warningsOf(result)[0], /89743422/);
  assert.equal(result.db_identity_matches, false);
});

test('🛑 BOTH faults at once report TWO warnings, not the first one found', () => {
  // The reason this is an array. A `warning` string would have carried the
  // schema mismatch and silently dropped the swapped file, which is the
  // graver of the two.
  const warnings = warningsOf(
    marks({
      health: { max_id: 1, autoincrement_seq: 1, schema_version: SCHEMA_VERSION - 1 },
      now: { dev: 16777231, ino: 89743422 },
    }),
  );

  assert.equal(warnings.length, 2);
  assert.ok(
    warnings.some((w) => /schema/.test(w)),
    'the schema mismatch went missing',
  );
  assert.ok(
    warnings.some((w) => /89743422/.test(w)),
    'the inode divergence went missing',
  );
});

test('a database with NO recorded mark reports null rather than inventing one', () => {
  const result = marks({ atOpen: undefined });

  assert.equal(result.db_identity_at_open, null);
  assert.equal(result.db_identity_matches, false);
  assert.match(warningsOf(result)[0], /not recorded|UNREADABLE/i);
});

test('a MISSING file is reported as a divergence, and db_identity_now is null', () => {
  const result = marks({ now: null });

  assert.equal(result.db_identity_now, null);
  assert.equal(result.db_identity_matches, false);
  assert.match(warningsOf(result)[0], /NO LONGER EXISTS/i);
});

test('🛑 db_path is reported VERBATIM, never re-resolved', () => {
  // The handler resolves `dbPath()` once and passes the same string to both
  // the report and the stat. A second resolution here would let the path
  // reported disagree with the path measured, which is this tool's own
  // failure class.
  assert.equal(marks({ db_path: '/tmp/somewhere/else/chat.db' }).db_path, '/tmp/somewhere/else/chat.db');
});
