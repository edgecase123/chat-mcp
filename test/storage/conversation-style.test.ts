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
  dao.setRoomStyle(db, '#gate', 'succinct');

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
  assert.throws(() => dao.assertStyleName('normal'), /Unknown style "normal"/);
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

// ── the peer half, #92 ───────────────────────────────────────────────────

test('an unstyled peer contributes nothing, so an existing inbox is unchanged', () => {
  const db = freshDb();

  assert.deepEqual(dao.styleBlocksForPeers(db, ['claude2']), []);
});

test('a styled peer contributes one block naming the peer and the style', () => {
  const db = freshDb();
  dao.setAgentStyle(db, 'claude2', 'succinct');

  const blocks = dao.styleBlocksForPeers(db, ['claude2']);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.type, 'text');
  assert.match(blocks[0]!.text, /claude2/);
  assert.match(blocks[0]!.text, /succinct/);
  assert.ok(blocks[0]!.text.includes(dao.STYLE_PRESETS.succinct!), 'the preset text itself is missing');
});

/**
 * The wording is the whole difference between the two halves. A room style
 * governs what you write IN a place; a peer style governs what you write TO
 * someone.
 */
test('the peer block says "when writing to them", not "in this room"', () => {
  const db = freshDb();
  dao.setAgentStyle(db, 'claude2', 'succinct');

  const text = dao.styleBlocksForPeers(db, ['claude2'])[0]!.text;

  assert.match(text, /when writing to them/);
  assert.doesNotMatch(text, /in this room/);
});

test('an unstyled peer among styled ones drops out', () => {
  const db = freshDb();
  db.prepare(
    'INSERT INTO agents (handle, session_id, registered_at, last_seen_at) VALUES (?, ?, ?, ?)',
  ).run('claude1', 's2', 1, 1);
  dao.setAgentStyle(db, 'claude2', 'succinct');

  const blocks = dao.styleBlocksForPeers(db, ['claude2', 'claude1']);

  assert.equal(blocks.length, 1, 'claude1 has no style and must contribute nothing');
  assert.match(blocks[0]!.text, /claude2/);
});

test('a peer custom style pushes the operator markdown verbatim', () => {
  const db = freshDb();
  dao.setAgentStyle(db, 'claude2', 'custom', '# DM rules\n\n- Name the file.');

  const blocks = dao.styleBlocksForPeers(db, ['claude2']);

  assert.ok(blocks[0]!.text.includes('# DM rules'));
  assert.ok(blocks[0]!.text.includes('- Name the file.'));
});

/**
 * A half-written `custom` row pushes nothing, same as the room half. Asserted
 * on the peer side too because the guard lives in `resolveStyle`, and a reader
 * checking one caller cannot tell the two share it.
 */
test('a peer on custom with no markdown pushes nothing', () => {
  const db = freshDb();
  dao.setAgentStyle(db, 'claude2', 'custom', '   ');

  assert.deepEqual(dao.styleBlocksForPeers(db, ['claude2']), []);
});

/**
 * A handle with no agent row — a sender who deregistered between writing and
 * being read. This is the no-crash case, not a style decision.
 */
test('an unknown handle contributes nothing rather than throwing', () => {
  const db = freshDb();

  assert.deepEqual(dao.styleBlocksForPeers(db, ['nobody']), []);
});

/**
 * 🛑 A SCOPED READ THAT RETURNED NOTHING MUST PUSH NOTHING. That is the polling
 * case, and the first version emitted the block anyway by passing `[room]`
 * unconditionally. claude1 caught it as a false COMMENT; the behaviour was
 * changed to match the comment rather than the reverse.
 */
test('no rooms returned means no blocks, however styled they are', () => {
  const db = freshDb();
  dao.setRoomStyle(db, '#gate', 'succinct');

  assert.deepEqual(dao.styleBlocksForRooms(db, []), []);
});

// ---------------------------------------------------------------------------
// The CLI cycle (#92 unit 2)
// ---------------------------------------------------------------------------

test('the cycle walks none -> succinct -> none when no custom exists', () => {
  assert.equal(dao.nextStyle(null, false), 'succinct');
  assert.equal(dao.nextStyle('succinct', false), null);
});

/**
 * 🛑 `custom` IS ONLY REACHABLE WHEN MARKDOWN ALREADY EXISTS. A terminal cannot
 * prompt for multi-line markdown mid-cycle, so cycling onto an empty custom
 * would set a style that pushes nothing — the half-written state resolveStyle
 * already refuses.
 */
test('the cycle includes custom only when markdown is already stored', () => {
  assert.equal(dao.nextStyle('succinct', true), 'custom');
  assert.equal(dao.nextStyle('custom', true), null);

  assert.equal(dao.nextStyle('succinct', false), null, 'custom was offered with no markdown behind it');
});

test('an unrecognised stored style is CLEARED rather than advanced', () => {
  // The docblock said "cycles to the start"; index 0 of the order is `null`.
  assert.equal(dao.nextStyle('terse', false), null);
});

/**
 * 🛑 `normal` IS NOW UNRECOGNISED, AND A LIVE ROOM HELD IT. Migration 13 clears
 * those rows so the column cannot read "normal" while resolveStyle pushes
 * nothing — a style configured and silently inert.
 *
 * ⚠️ THIS DOES NOT TEST THE MIGRATION'S UPDATE. `migrate()` runs every
 * migration, so a row planted afterwards is never swept, and my first version
 * of this test asserted exactly that and failed. What it pins is the
 * behaviour a legacy value gets if one ever survives.
 */
test('a legacy normal value is inert and clears on the next cycle', () => {
  const db = freshDb();
  db.prepare('UPDATE rooms SET style = ? WHERE name = ?').run('normal', '#gate');

  assert.equal(dao.resolveStyle(db, 'rooms', '#gate'), undefined, 'an unknown preset must push nothing');
  assert.equal(dao.nextStyle('normal', false), null, 'an unknown value clears rather than advancing');
});

test('the schema reaches version 13', () => {
  const db = freshDb();

  const v = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as unknown as { v: number };

  assert.equal(v.v, 13);
});

test('custom markdown is what makes custom reachable in the cycle', () => {
  const db = freshDb();

  assert.equal(dao.hasCustomStyle(db, '#gate'), false);

  dao.setRoomStyle(db, '#gate', 'custom', '# rules');
  assert.equal(dao.hasCustomStyle(db, '#gate'), true);

  // Whitespace-only is not markdown — the same rule resolveStyle applies.
  db.prepare('UPDATE rooms SET style_custom = ? WHERE name = ?').run('  \n ', '#gate');
  assert.equal(dao.hasCustomStyle(db, '#gate'), false);
});

test('a room row carries its style so the pane can render it', () => {
  const db = freshDb();
  dao.setRoomStyle(db, '#gate', 'succinct');

  const room = dao.allRooms(db).find((r) => r.name === '#gate');

  assert.equal(room?.style, 'succinct', 'Room.style did not survive the hydrator');
});

/**
 * 🛑 `myRooms` IS THE QUERY THE WEB UI READS, AND IT WAS THE ONE I MISSED.
 *
 * Three queries build a Room. I added `style` to the two that spell the columns
 * as `name, created_at, created_by`, and `myRooms` spells them `r.name,
 * r.created_at, r.created_by` — so my grep did not match it and my test used
 * `allRooms`.
 *
 * The visible symptom was the web dropdown never persisting: the POST wrote the
 * row, `/api/whoami` read it back through `myRooms` as undefined, and the
 * selector re-rendered as "none".
 */
test('myRooms carries the style, because that is what the web UI reads', () => {
  const db = freshDb();
  db.prepare('INSERT INTO room_members (room_name, handle, joined_at) VALUES (?, ?, ?)').run(
    '#gate',
    'claude2',
    1,
  );
  dao.setRoomStyle(db, '#gate', 'succinct');

  const mine = dao.myRooms(db, 'claude2').find((r) => r.name === '#gate');

  assert.equal(mine?.style, 'succinct', 'myRooms dropped the style the web UI needs');
});

/**
 * 🛑 THE WEB EDITOR PREFILLS FROM `style_custom`, SO ALL THREE QUERIES MUST
 * CARRY IT. I shipped `style` on two of the three and the web dropdown silently
 * read null — this is the same mistake one column over, so all three paths get
 * a test this time.
 */
test('all three Room queries carry style_custom', () => {
  const db = freshDb();
  db.prepare('INSERT INTO room_members (room_name, handle, joined_at) VALUES (?, ?, ?)').run(
    '#gate',
    'claude2',
    1,
  );
  dao.setRoomStyle(db, '#gate', 'custom', '# house rules');

  assert.equal(dao.allRooms(db).find((r) => r.name === '#gate')?.style_custom, '# house rules', 'allRooms');
  assert.equal(dao.myRooms(db, 'claude2').find((r) => r.name === '#gate')?.style_custom, '# house rules', 'myRooms');
  assert.equal(dao.joinRoom(db, '#gate', 'claude2').room.style_custom, '# house rules', 'hydrateRoom');
});
