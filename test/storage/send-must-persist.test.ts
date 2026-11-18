import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { committableFiles } from "../support/committable-files.js";

// Point CHAT_MCP_HOME at a scratch dir BEFORE importing anything that reads it.
process.env.CHAT_MCP_HOME = join(
  mkdtempSync(join(tmpdir(), "chat-mcp-persist-")),
  "state",
);

const { migrate, openDb, verifierFor } =
  await import("../../src/storage/db.js");
const { dbPath } = await import("../../src/util/paths.js");
const dao = await import("../../src/storage/dao.js");

/**
 * #138 slice 2 — a send that persists nothing must THROW, not return an id.
 *
 * 🛑 `lastInsertRowid` IS PER-CONNECTION, NOT PER-TABLE. A statement that
 * inserts nothing still hands back the rowid of whatever that connection
 * inserted last, from any table. A reported id is the only signal a send
 * returns, so that receipt is fiction.
 *
 * Both fixtures are real SQLite triggers rather than stubs.
 */

/** A rowid no `messages` id can collide with, so a stale receipt is unmistakable. */
const FOREIGN_ROWID = 777;

function freshDb() {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  return db;
}

/**
 * Fixture A — the insert vanishes and `changes` is 0, with the connection's
 * last rowid pointing at another table.
 */
function swallowMessageInserts(db: DatabaseSync) {
  db.exec(
    "CREATE TRIGGER swallow BEFORE INSERT ON messages BEGIN SELECT RAISE(IGNORE); END",
  );
  db.prepare(
    "INSERT INTO claims (id, resource, holder, claimed_at, expires_at) VALUES (?, ?, ?, ?, ?)",
  ).run(FOREIGN_ROWID, "r", "a", 1, 2);
}

/** Fixture B — the insert COUNTS, so `changes` is 1, but the row does not survive it. */
function deleteMessagesOnInsert(db: DatabaseSync) {
  db.exec(
    "CREATE TRIGGER vanish AFTER INSERT ON messages BEGIN DELETE FROM messages WHERE id = NEW.id; END",
  );
}

test("🛑 a send that changes no rows throws instead of returning an id", () => {
  const db = freshDb();
  swallowMessageInserts(db);

  assert.throws(
    () => dao.insertMessage(db, { from: "a", to: "b", body: "vanishes" }),
    {
      name: "MessageNotPersistedError",
      reason: "no-rows-changed",
    },
  );

  assert.equal(
    dao.busHealth(db).max_id,
    null,
    "nothing was written, which is the premise",
  );
});

test("🛑 fixture A is NOT vacuous — the id it would have returned belongs to another table", () => {
  // Without the guard this send returns FOREIGN_ROWID, an id belonging to
  // `claims`. Asserting that number reaches the error is what proves the test
  // exercises the defect rather than an ordinary SQLite failure.
  const db = freshDb();
  swallowMessageInserts(db);

  assert.throws(
    () => dao.insertMessage(db, { from: "a", to: "b", body: "vanishes" }),
    {
      claimedId: FOREIGN_ROWID,
    },
  );
});

test("🛑 a send whose row does not survive the write throws on the read-back", () => {
  // The branch `changes === 1` cannot see. The insert really happened and was
  // really counted; the row is still gone.
  const db = freshDb();
  deleteMessagesOnInsert(db);

  assert.throws(
    () => dao.insertMessage(db, { from: "a", to: "b", body: "gone" }),
    {
      name: "MessageNotPersistedError",
      reason: "row-absent-on-reread",
    },
  );
});

test("a healthy send still returns its id and the row is readable", () => {
  // The positive control. A guard that rejects everything passes all three above.
  const db = freshDb();

  const sent = dao.insertMessage(db, { from: "a", to: "b", body: "lands" });

  assert.equal(typeof sent.id, "number");
  assert.equal(dao.busHealth(db).max_id, sent.id);
});

test("🛑 openDb pairs a SECOND connection with the handle, and it sees committed writes", (t) => {
  const db = openDb();
  // 🛑 IN `t.after`, NEVER AFTER THE ASSERTIONS. A connection left open keeps
  // `-wal` on disk and fails the close test further down this file.
  t.after(() => db.close());
  const witness = verifierFor(db);

  assert.ok(
    witness,
    "openDb registered no verifier, so every read-back is the writer marking its own work",
  );
  assert.notEqual(
    witness,
    db,
    "the verifier must not be the connection that wrote the row",
  );

  const sent = dao.insertMessage(db, {
    from: "a",
    to: "b",
    body: "crosses connections",
  });

  const seen = witness
    .prepare("SELECT from_handle FROM messages WHERE id = ?")
    .get(sent.id);
  assert.equal((seen as { from_handle: string } | undefined)?.from_handle, "a");
});

test("🛑 insertMessage reads back through the VERIFIER, not the writer", (t) => {
  // Non-vacuous proof that the second connection is the one consulted. With the
  // verifier closed the send must fail — while the primary can still read the
  // row, so the failure came from the witness rather than from the write.
  const db = openDb();
  t.after(() => db.close());
  const witness = verifierFor(db);
  assert.ok(witness);
  witness.close();

  assert.throws(() =>
    dao.insertMessage(db, { from: "a", to: "b", body: "no witness" }),
  );

  const maxId = dao.busHealth(db).max_id;
  assert.ok(
    maxId !== null,
    "the write itself landed, which is what makes this the witness failing",
  );
});

test("🛑 closing the handle closes its verifier, so the WAL does not outlive the close", () => {
  // A second live connection keeps `-wal` and `-shm` on disk past a clean
  // close, and those hold the newest traffic. `state-dir-perms` is what caught
  // this when the verifier closed with nothing.
  const db = openDb();
  const witness = verifierFor(db);
  assert.ok(witness);

  db.close();

  assert.throws(() => witness.prepare("SELECT 1").get(), /not open/i);
  // The file is the claim, not the error text. SQLite only removes these two on
  // a close with no connection left.
  assert.equal(existsSync(`${dbPath()}-wal`), false, "-wal outlived the close");
  assert.equal(existsSync(`${dbPath()}-shm`), false, "-shm outlived the close");
});

/**
 * 🛑 THE FALLBACK IN `insertMessage` ASSUMES `openDb` IS THE ONLY PLACE
 * PRODUCTION OPENS A DATABASE. A second call site would get the writing
 * connection as its own witness, silently, and nothing else would notice.
 */
test("🛑 src/ opens a database in exactly one place, so every handle gets a verifier", () => {
  // 🛑 `.tsx` TOO. The first cut filtered `.ts` and so scanned 90 of 108 files,
  // blind to all 18 Ink components. Raised by claude2 reviewing this PR.
  const files = sourceFiles();
  // Denominator: a listing that matched nothing would otherwise pass.
  assert.ok(files.length >= 100, `found only ${files.length} source files`);
  assert.ok(
    files.some((f) => f.endsWith(".tsx")),
    "no .tsx file in the scan, so the extension filter has regressed",
  );

  // Whitespace-tolerant: `new DatabaseSync (` would slip a literal match.
  const openers = files.filter((f) =>
    /new\s+DatabaseSync\s*\(/.test(readFileSync(f, "utf8")),
  );

  assert.deepEqual(openers, ["src/storage/db.ts"]);
});

/**
 * 🛑 THESE TWO SURFACES MUST STAY UP AND REPORT IN-BAND. Everything else —
 * a oneshot verb, an MCP tool, the web API — lets the throw out, which is the
 * loud path lee asked for.
 *
 * Counted rather than parsed: a bare call added later makes the two totals
 * disagree, and the message names the file.
 */
test("🛑 the TUI and the REPL route every send through sendOrReason", () => {
  for (const file of ["src/cli/ink/App.tsx", "src/cli/index.ts"]) {
    const src = readFileSync(file, "utf8");
    const sends = [
      ...src.matchAll(/(?:dao\.insertMessage|sendToRoom|announceToRoom)\s*\(/g),
    ].length;
    const wrapped = [...src.matchAll(/sendOrReason\s*\(/g)].length;

    // Denominator: a file with no sends would otherwise pass this vacuously.
    assert.ok(
      sends > 0,
      `${file} has no send call, so this guard reads nothing`,
    );
    assert.equal(
      wrapped,
      sends,
      `${file} has ${sends} send calls but ${wrapped} go through sendOrReason`,
    );
  }
});

/**
 * Every statement shape that writes a row into `messages`.
 *
 * 🛑 `INSERT OR IGNORE` IS THE SHAPE #138 IS ABOUT, so a pattern matching only
 * bare `INSERT INTO` is blind to the one statement that reaches
 * `lastInsertRowid` with `changes` at 0. `REPLACE`, a quoted identifier and a
 * `main.` qualifier are the same statement to SQLite and are counted here for
 * the same reason. `\b` keeps a future `messages_archive` from reading as a
 * writer of `messages`.
 */
const WRITES_MESSAGES =
  /(?:INSERT(?:\s+OR\s+\w+)?|REPLACE)\s+INTO\s+["'`[]?(?:main\.)?messages\b/i;

/**
 * 🛑 FOUR SURFACES WROTE `messages` WITH THEIR OWN INSERT, AND NONE OF THEM
 * CHECKED `changes`. `joinRoom`, the REPL's boot, the oneshot boot verb and the
 * `room_boot` tool each read `lastInsertRowid` straight back — which a swallowed
 * insert takes from ANOTHER TABLE — and two of them fed that id into a read
 * watermark. claude1 named one of the four; a whole-tree grep found the rest, so
 * this guard exists to count rather than to trust a grep somebody remembers to
 * run. #138.
 */
test("🛑 src/ writes the messages table in exactly one place", () => {
  const files = sourceFiles();

  // Denominator: a listing that matched nothing would otherwise pass.
  assert.ok(files.length >= 100, `found only ${files.length} source files`);

  const writers = files.filter((f) =>
    WRITES_MESSAGES.test(stripComments(readFileSync(f, "utf8"))),
  );

  assert.deepEqual(writers, ["src/storage/dao.ts"]);
});

/**
 * 🛑 THE GUARD ABOVE IS ONLY AS WIDE AS ITS PATTERN, AND A NARROW PATTERN READS
 * EXACTLY LIKE A CLEAN TREE. The first version counted `INSERT INTO messages`
 * alone. claude1 measured four mutants against it on #267: `INSERT OR IGNORE`,
 * `REPLACE INTO`, a quoted `"messages"` and `main.messages` all PASSED, so a
 * fifth writer in any of those shapes arrives silently.
 *
 * Each row below IS that mutant, asserted against the pattern itself rather
 * than installed into a source file — which makes the measurement repeatable
 * instead of a number in a review comment.
 */
test("🛑 the writer pattern catches every shape that writes messages", () => {
  for (const stmt of [
    "INSERT INTO messages (body) VALUES (?)",
    "INSERT OR IGNORE INTO messages (body) VALUES (?)",
    "INSERT OR REPLACE INTO messages (body) VALUES (?)",
    "INSERT OR ROLLBACK INTO messages (body) VALUES (?)",
    "REPLACE INTO messages (body) VALUES (?)",
    'INSERT INTO "messages" (body) VALUES (?)',
    "INSERT INTO `messages` (body) VALUES (?)",
    "INSERT INTO [messages] (body) VALUES (?)",
    "INSERT INTO main.messages (body) VALUES (?)",
    "insert\n  into messages (body) values (?)",
  ]) {
    assert.match(stmt, WRITES_MESSAGES, `a writer slipped the guard: ${stmt}`);
  }

  // The negative half: a pattern matching everything would pass the loop above
  // vacuously and then report every source file as a writer.
  for (const stmt of [
    "INSERT INTO messages_archive (body) VALUES (?)",
    "INSERT INTO room_members (handle) VALUES (?)",
    "SELECT * FROM messages WHERE id > ?",
    "UPDATE messages SET body = ? WHERE id = ?",
    "DELETE FROM messages WHERE id = ?",
  ]) {
    assert.doesNotMatch(
      stmt,
      WRITES_MESSAGES,
      `the guard over-matches, so its count is noise: ${stmt}`,
    );
  }
});

/**
 * 🛑 THE STRIPPER IS THE HALF THAT CAN FAIL SILENTLY, SO IT IS TESTED.
 * `room-announce.ts` QUOTES `INSERT INTO messages` in its docblock, to say what
 * it replaced. An unstripped grep counts that as a fifth writer and the guard
 * above then fails for a reason that has nothing to do with the code — the trap
 * being that the FIX quotes the defect it fixed.
 */
test("🛑 the comment stripper removes a quoted INSERT but not a real one", () => {
  const quoted = readFileSync("src/messaging/room-announce.ts", "utf8");
  const real = readFileSync("src/storage/dao.ts", "utf8");

  // The positive control: the string really is in that file, so a stripper that
  // deleted everything would pass the negative half below vacuously.
  assert.match(quoted, WRITES_MESSAGES);

  assert.doesNotMatch(
    stripComments(quoted),
    WRITES_MESSAGES,
    "room-announce.ts has a real messages insert, not just a quoted one",
  );
  assert.match(
    stripComments(real),
    WRITES_MESSAGES,
    "the stripper ate dao.ts's real insert, so the guard above is blind",
  );
});

/** Line and block comments out, so a docblock quoting SQL is not a call site. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * 🛑 UNSTAGED FILES TOO (#312). This guard's subject is a NEW module under
 * `src/` that opens a database or writes the messages table, and a new module
 * is invisible to an index-only listing until it is staged.
 */
function sourceFiles(): string[] {
  return committableFiles({ pathspec: "src" }).filter((f) => /\.tsx?$/.test(f));
}
