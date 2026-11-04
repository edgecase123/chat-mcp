import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../../src/storage/db.js';
import * as dao from '../../src/storage/dao.js';

/**
 * #92 — a room or a peer can state the conversation style agents must follow.
 *
 * 🛑 THE UNSET PATH IS THE ONE MOST WORTH PINNING. Every room on every existing
 * database has no style, so `resolveStyle` returning undefined is what keeps
 * this change invisible until somebody opts in.
 */

function freshDb() {
  const db = new DatabaseSync(':memory:');
  migrate(db);
  db.prepare('INSERT INTO rooms (name, created_at, created_by) VALUES (?, ?, ?)').run('#gate', 1, 'lee');
  db.prepare(
    'INSERT INTO agents (handle, session_id, registered_at, last_seen_at) VALUES (?, ?, ?, ?)',
  ).run('claude2', 's1', 1, 1);
  return db;
}

test('migration 12 adds the style columns to both tables', () => {
  const db = freshDb();

  for (const table of ['rooms', 'agents']) {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).map(
      (c) => c.name,
    );
    assert.ok(cols.includes('style'), `${table} is missing style`);
    assert.ok(cols.includes('style_custom'), `${table} is missing style_custom`);
  }
});

test('a room with no style pushes nothing', () => {
  const db = freshDb();

  assert.equal(dao.resolveStyle(db, 'rooms', '#gate'), undefined);
});

test('a preset resolves to its own text', () => {
  const db = freshDb();
  dao.setRoomStyle(db, '#gate', 'succinct');

  const resolved = dao.resolveStyle(db, 'rooms', '#gate');

  assert.equal(resolved?.style, 'succinct');
  assert.equal(resolved?.text, dao.STYLE_PRESETS.succinct);
});

/**
 * The replace-not-layer decision, asserted rather than left to the docblock.
 * If custom ever layered, this text would arrive with a preset bolted on.
 */
test('custom replaces the preset rather than layering on it', () => {
  const db = freshDb();
  dao.setRoomStyle(db, '#gate', 'custom', '# Rules\n\nLead with the sha.');

  const resolved = dao.resolveStyle(db, 'rooms', '#gate');

  assert.equal(resolved?.style, 'custom');
  assert.equal(resolved?.text, '# Rules\n\nLead with the sha.');
  assert.ok(!resolved?.text.includes(dao.STYLE_PRESETS.normal!));
  assert.ok(!resolved?.text.includes(dao.STYLE_PRESETS.succinct!));
});

/**
 * 🛑 A HALF-WRITTEN SETTING IS WORSE THAN NO SETTING. The row says a style is
 * configured and the instruction is empty, so an agent reads "no preference"
 * from a room that claims to have one.
 */
test('custom with blank markdown pushes nothing', () => {
  const db = freshDb();
  db.prepare('UPDATE rooms SET style = ?, style_custom = ? WHERE name = ?').run('custom', '   ', '#gate');

  assert.equal(dao.resolveStyle(db, 'rooms', '#gate'), undefined);
});

test('switching away from custom drops the markdown', () => {
  const db = freshDb();
  dao.setRoomStyle(db, '#gate', 'custom', 'keep it short');
  dao.setRoomStyle(db, '#gate', 'normal');

  const row = db.prepare('SELECT style_custom FROM rooms WHERE name = ?').get('#gate') as unknown as {
    style_custom: string | null;
  };

  assert.equal(row.style_custom, null, 'stale custom markdown survived a preset switch');
});

test('a peer style resolves the same way as a room style', () => {
  const db = freshDb();
  dao.setAgentStyle(db, 'claude2', 'succinct');

  assert.equal(dao.resolveStyle(db, 'agents', 'claude2')?.text, dao.STYLE_PRESETS.succinct);
});

test('an unknown style name is refused', () => {
  assert.throws(() => dao.assertStyleName('terse'), /Unknown style "terse"/);
  assert.doesNotThrow(() => dao.assertStyleName('custom'));
  assert.doesNotThrow(() => dao.assertStyleName('normal'));
});

test('custom demands markdown, and an oversized one is refused', () => {
  assert.throws(() => dao.assertStyleCustom('custom', undefined), /requires non-empty markdown/);
  assert.throws(() => dao.assertStyleCustom('custom', '  '), /requires non-empty markdown/);
  assert.throws(
    () => dao.assertStyleCustom('custom', 'x'.repeat(dao.STYLE_CUSTOM_MAX_BYTES + 1)),
    /exceeds 65536 bytes/,
  );
  assert.doesNotThrow(() => dao.assertStyleCustom('custom', 'fine'));

  // A preset carries no markdown, so the cap must not fire on it.
  assert.doesNotThrow(() => dao.assertStyleCustom('succinct', undefined));
});

/**
 * The PUSH half. The style only works if it arrives with the messages, so
 * these pin the blocks room_inbox prepends.
 */
test('a room with no style contributes no block, so the response is unchanged', () => {
  const db = freshDb();

  assert.deepEqual(dao.styleBlocksForRooms(db, ['#gate']), []);
});

test('a styled room contributes one block naming the room and the style', () => {
  const db = freshDb();
  dao.setRoomStyle(db, '#gate', 'succinct');

  const blocks = dao.styleBlocksForRooms(db, ['#gate']);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.type, 'text');
  assert.match(blocks[0]!.text, /#gate/);
  assert.match(blocks[0]!.text, /succinct/);
  assert.ok(blocks[0]!.text.includes(dao.STYLE_PRESETS.succinct!), 'the preset text itself is missing');
});

test('an unscoped read pushes one block per styled room and skips the rest', () => {
  const db = freshDb();
  db.prepare('INSERT INTO rooms (name, created_at, created_by) VALUES (?, ?, ?)').run('#leagues', 1, 'lee');
  dao.setRoomStyle(db, '#gate', 'succinct');

  const blocks = dao.styleBlocksForRooms(db, ['#gate', '#leagues']);

  assert.equal(blocks.length, 1, '#leagues has no style and must contribute nothing');
  assert.match(blocks[0]!.text, /#gate/);
});

test('a custom style pushes the operator markdown verbatim', () => {
  const db = freshDb();
  dao.setRoomStyle(db, '#gate', 'custom', '# House rules\n\n- Lead with the sha.');

  const blocks = dao.styleBlocksForRooms(db, ['#gate']);

  assert.ok(blocks[0]!.text.includes('# House rules'));
  assert.ok(blocks[0]!.text.includes('- Lead with the sha.'));
});
