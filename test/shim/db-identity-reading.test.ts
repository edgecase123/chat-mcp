import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityReading } from '../../src/shim/tools/health.js';

/**
 * #138 — the two id marks could not see the failure, because the write SUCCEEDED.
 *
 * 🛑 THE PATH IS NOT THE IDENTITY. `lsof` and `PRAGMA database_list` both
 * report the path a connection was opened on, so neither can tell a different
 * file at the same path from the same file. Measured: after a rename-and-
 * replace, `database_list` still returned the original path string while the
 * connection held inode 89743418 and the path resolved to 89743422.
 *
 * So the mark that CAN say no is the device and inode recorded at open,
 * compared against the path's identity now. Every branch is a claim.
 */

const id = (dev: number, ino: number) => ({ dev, ino });

test('identical device and inode says the connection holds the file at this path', () => {
  const { matches, reading } = identityReading(id(16777231, 89743418), id(16777231, 89743418));

  assert.equal(matches, true);
  assert.match(reading, /is the file at this path/i);
});

test('🛑 a DIFFERENT inode at the same path is #138, and it must not read as healthy', () => {
  // The whole point. A swap leaves the path string identical, so the reading
  // has to name the divergence rather than echo the path back.
  const { matches, reading } = identityReading(id(16777231, 89743418), id(16777231, 89743422));

  assert.equal(matches, false);
  assert.match(reading, /89743418/);
  assert.match(reading, /89743422/);
  assert.match(reading, /no other process can read|nobody else/i);
});

test('🛑 a different DEVICE diverges even when the inode number collides', () => {
  // Inode numbers are only unique per filesystem, so comparing ino alone
  // calls a cross-device swap healthy. A bind mount makes this reachable.
  const { matches } = identityReading(id(16777231, 89743418), id(16777232, 89743418));

  assert.equal(matches, false);
});

test('🛑 the file being GONE is a divergence, not an unknown', () => {
  // statSync throws ENOENT, which arrives here as null. An unlinked database
  // is the strongest form of the same fault: the writes have nowhere readable
  // to land, and the connection keeps reporting success.
  const { matches, reading } = identityReading(id(16777231, 89743418), null);

  assert.equal(matches, false);
  assert.match(reading, /no longer exists|deleted/i);
  assert.doesNotMatch(reading, /null/);
});

test('no identity recorded at open reports UNREADABLE, and never claims a match', () => {
  // A database that did not come from `openDb` has no mark. Reporting that as
  // a match would be the instrument that could not say no.
  const { matches, reading } = identityReading(null, id(16777231, 89743418));

  assert.equal(matches, false);
  assert.match(reading, /not recorded|unreadable/i);
  assert.doesNotMatch(reading, /null/);
});
