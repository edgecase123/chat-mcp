import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point CHAT_MCP_HOME at a scratch dir BEFORE importing anything that reads it.
process.env.CHAT_MCP_HOME = join(
  mkdtempSync(join(tmpdir(), "chat-mcp-writer-identity-")),
  "state",
);

const { migrate, openDb, DatabaseReplacedError } =
  await import("../../src/storage/db.js");
const { dbPath } = await import("../../src/util/paths.js");
const dao = await import("../../src/storage/dao.js");

const DAO = "src/storage/dao.ts";

/**
 * Where a table write is allowed to live without an identity check.
 *
 * 🛑 `db.ts` IS EXEMPT BECAUSE `migrate` HOLDS THE DATABASE ALONE. The
 * migrations and `applyMigrations` run before any identity is established, so
 * calling the guard there would be comparing a file against itself.
 *
 * ⚠️ IT IS NOT A NO-OP ENTRY. `WRITES_A_TABLE` ignores `CREATE` and `ALTER`,
 * so a reader can conclude `db.ts` would pass anyway. It would not: migration
 * 8's rebuild and the version row are ordinary DML. Emptying this list fails
 * the test below and names `db.ts`.
 */
const EXEMPT_FROM_THE_GUARD: readonly string[] = ["db.ts"];

/**
 * #268 — a claim could land in a database nobody reads, and nothing said so.
 *
 * 🛑 THE TICKET NAMED THREE UNGUARDED WRITERS. THERE WERE 23. `insertMessage`
 * was the only writer in `dao.ts` comparing its connection's file identity, so
 * every other table — claims, approvals, rooms, agents, read watermarks — could
 * be written into a replaced file and report success. The ticket's own stated
 * lesson is that an audit scoped to the names already in hand undercounts, and
 * it undercounted by 8x.
 *
 * A claim is how two agents avoid acting on the same resource at once. A lost
 * message is noticed when no reply comes; a lost claim is noticed when both
 * agents have already acted.
 */

// ---------------------------------------------------------------------------
// The source guard — per function, never per count
// ---------------------------------------------------------------------------

/**
 * A statement that writes a real table.
 *
 * 🛑 FOUR VERBS, NOT ONE. `#267` measured the narrow version of this on
 * `messages`: a pattern naming only `INSERT INTO` passed `INSERT OR IGNORE`,
 * `REPLACE INTO`, a quoted `"messages"` and `main.messages`. A guard is only as
 * wide as its pattern, and a narrow pattern reads exactly like a clean tree.
 */
const WRITES_A_TABLE =
  /(?:(?:INSERT|REPLACE)(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+["'`[]?(?:main\.)?\w+/i;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/**
 * A function that EXECUTES a write, which is both halves and not either one.
 *
 * ⚠️ THE STATEMENT PATTERN ALONE READ `detailFor` AS A WRITER. Its body
 * contains the prose "The INSERT into messages changed no rows" inside a
 * template string, so a pattern wide enough to catch `INSERT OR IGNORE` is also
 * wide enough to catch an error message quoting one. `.run(` alone is no better
 * — it matches a child-process call.
 *
 * 🛑 `dao.ts` HAS NO `.exec(`, VERIFIED, so `.run(` is the whole execution
 * surface. A writer added through `.exec()` would escape this, which is why the
 * pattern below names both.
 */
function isWriter(fn: { body: string }): boolean {
  return /\.(?:run|exec)\(/.test(fn.body) && WRITES_A_TABLE.test(fn.body);
}

/**
 * Any TOP-LEVEL DECLARATION, which is the boundary — not any declaration shape
 * this test knows how to call a function.
 *
 * 🛑 THE FIRST VERSION MATCHED `function NAME` ALONE AND WAS BLIND TO TWO
 * SHAPES. claude1 measured it on PR 272: an unguarded `export const w = () =>`
 * and an unguarded `export async function w` both left all 1715 tests GREEN.
 *
 * 🛑 AND THE MECHANISM IS WORSE THAN A MISSED NAME. Slicing from one
 * RECOGNISED start to the next ABSORBS an unrecognised declaration into the
 * previous one's body. When that neighbour is guarded, the absorbed writer
 * inherits its guard: presence passes and so does position. Appended at end of
 * file it does fail, and blames whichever function happens to sit last.
 *
 * So the boundary is every top-level declaration of any kind. An unguarded
 * writer then gets its OWN slice whatever keyword introduced it, and the
 * splitter cannot launder it through a neighbour.
 */
const TOP_LEVEL_DECL =
  /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|class|type|interface)\s+(\w+)/;

/** Every top-level declaration in a source file, as name plus its own body. */
function functionsOf(src: string): { name: string; body: string }[] {
  const lines = src.split("\n");
  const starts: { name: string; line: number }[] = [];

  lines.forEach((line, i) => {
    const m = TOP_LEVEL_DECL.exec(line);
    if (m?.[1]) starts.push({ name: m[1], line: i });
  });

  return starts.map((s, i) => ({
    name: s.name,
    body: lines.slice(s.line, starts[i + 1]?.line ?? lines.length).join("\n"),
  }));
}

/**
 * 🛑 THE SPLITTER'S OWN NON-VACUITY, WHICH NOTHING PROVED BEFORE. Every
 * assertion in this file is a statement about what `functionsOf` returned, so a
 * splitter that silently stopped seeing a shape would make all of them pass
 * while covering less. These rows are claude1's three mutants, kept as a
 * property of the splitter rather than as source installed by hand.
 */
test("🛑 THE WRITER CENSUS SEES EVERY DECLARATION SHAPE, each in its OWN slice", () => {
  const fixture = [
    "export function guarded(db: Db): void {",
    '  assertLiveDatabase(db, "guarded");',
    '  db.prepare("INSERT INTO claims (resource) VALUES (?)").run(1);',
    "}",
    "",
    "export function plain(db: Db): void {",
    '  db.prepare("INSERT INTO claims (resource) VALUES (?)").run(1);',
    "}",
    "",
    "export const arrow = (db: Db): void => {",
    '  db.prepare("UPDATE claims SET released_at = ?").run(1);',
    "};",
    "",
    "export async function waits(db: Db): Promise<void> {",
    '  db.prepare("DELETE FROM claims WHERE id = ?").run(1);',
    "}",
    "",
    "export function reader(db: Db): unknown {",
    '  return db.prepare("SELECT * FROM claims").all();',
    "}",
  ].join("\n");

  const found = functionsOf(fixture);

  assert.deepEqual(
    found.map((f) => f.name),
    ["guarded", "plain", "arrow", "waits", "reader"],
    "the splitter lost a declaration shape, so every census below under-counts",
  );

  // 🛑 EACH UNGUARDED WRITER IS NAMED SEPARATELY. A splitter that absorbed
  // `arrow` into `guarded`'s slice reports two writers here, not three, and
  // `arrow` inherits a guard it does not have.
  assert.deepEqual(
    found.filter(isWriter).map((f) => f.name),
    ["guarded", "plain", "arrow", "waits"],
    "a write shape was missed, or a read was counted as a write",
  );

  assert.deepEqual(
    found
      .filter(isWriter)
      .filter((f) => !f.body.includes("assertLiveDatabase"))
      .map((f) => f.name),
    ["plain", "arrow", "waits"],
    "an unguarded writer was laundered through a guarded neighbour's slice",
  );
});

/**
 * 🛑 PER FUNCTION, SO THERE IS NO NUMBER TO BUMP. claude1's finding on the plan:
 * a guard asserting "24 writers are covered" is satisfied by editing 24 to 25,
 * which is the cheapest way to make writer 25 green while leaving it unguarded.
 * Asserting a property of each function has no constant in it.
 */
test("🛑 EVERY dao WRITER CHECKS ITS CONNECTION'S FILE IDENTITY FIRST", () => {
  const source = stripComments(readFileSync(DAO, "utf8"));
  const writers = functionsOf(source).filter(isWriter);

  // Denominator: a splitter that matched nothing would otherwise pass.
  assert.ok(
    writers.length >= 24,
    `found only ${writers.length} writers in ${DAO}; the audit on 75469d8 found 24`,
  );

  const unguarded = writers
    .filter(
      (f) =>
        !f.body.includes("assertLiveDatabase") &&
        !f.body.includes("databaseWasReplaced"),
    )
    .map((f) => f.name);

  assert.deepEqual(
    unguarded,
    [],
    `${unguarded.length} of ${writers.length} writers reach .run() with no identity check`,
  );
});

/**
 * 🛑 A CLASS NESTS TWO WRITERS UNDER ONE TOP-LEVEL NAME, SO THE SECOND ONE
 * INHERITS THE FIRST ONE'S GUARD. claude1 measured it: a `ClaimWriter` with a
 * guarded `take` and an unguarded `drop` passes 1716/1716.
 *
 * ⚠️ THE ANSWER IS NOT A WIDER REGEX. A line-based census cannot do
 * method-level scoping, and widening it again is how the splitter grows a third
 * blind spot. So this BANS the laundering shape instead of parsing it, and the
 * day somebody wants a writing class the failure says why.
 *
 * 🛑 CORRECTION TO THE REVIEW THAT ASKED FOR THIS: "dao.ts declares no
 * top-level class" is FALSE. It declares three — `HandleClaimedError`,
 * `MessageNotPersistedError` and `UnnameableApprovalError`. They are Error
 * subclasses and none of them writes, so the ban that is both true and
 * sufficient is on a class that WRITES, not on a class.
 */
test("🛑 NO CLASS IN dao.ts WRITES, so no method can inherit another's guard", () => {
  const source = stripComments(readFileSync(DAO, "utf8"));
  const classes = functionsOf(source).filter((f) =>
    /^(?:export\s+)?class\s/.test(f.body),
  );

  // Denominator: a splitter blind to `class` would report no classes and pass
  // this vacuously, which is the exact failure mode this file already paid for.
  assert.ok(
    classes.length >= 3,
    `found only ${classes.length} classes in ${DAO}; there are 3 Error subclasses`,
  );

  const writing = classes.filter(isWriter).map((f) => f.name);

  assert.deepEqual(
    writing,
    [],
    `${writing.join(", ")} writes from inside a class, where this census cannot ` +
      `tell one method's guard from another's. Use a free function.`,
  );
});

/**
 * ⚠️ THE GUARD ABOVE PROVES PRESENCE, NOT POSITION. A call placed after a
 * writer's first statement still satisfies it, and that is exactly the shape
 * that turns a replaced file into PARTIAL state — `joinRoom` writes
 * `room_members` before it announces.
 */
test("🛑 the check precedes each writer's first write, not merely present", () => {
  const source = stripComments(readFileSync(DAO, "utf8"));
  const writers = functionsOf(source).filter(
    (f) => isWriter(f) && f.name !== "insertMessage",
  );

  assert.ok(writers.length >= 23, `found only ${writers.length} writers`);

  const late = writers
    .filter((f) => {
      const guard = f.body.indexOf("assertLiveDatabase");
      const write = f.body.search(WRITES_A_TABLE);

      return guard === -1 || guard > write;
    })
    .map((f) => f.name);

  assert.deepEqual(
    late,
    [],
    `${late.length} writers check identity after they have already written`,
  );
});

/**
 * 🛑 THE PATTERN'S OWN NON-VACUITY, asserted against statements rather than
 * installed into a source file — which makes the measurement repeatable instead
 * of a number in a review comment.
 */
test("🛑 the writer pattern catches every write shape, and no read", () => {
  for (const stmt of [
    "INSERT INTO claims (resource) VALUES (?)",
    "INSERT OR IGNORE INTO approvals (id) VALUES (?)",
    'REPLACE INTO "agents" (handle) VALUES (?)',
    "INSERT INTO main.room_members (handle) VALUES (?)",
    "UPDATE claims SET released_at = ?",
    "DELETE FROM room_reads WHERE handle = ?",
  ]) {
    assert.match(stmt, WRITES_A_TABLE, `a writer slipped the guard: ${stmt}`);
  }

  // The negative half: a pattern matching everything passes the loop above
  // vacuously and then reports every function as a writer.
  for (const stmt of [
    "SELECT * FROM claims WHERE resource = ?",
    "SELECT released_at FROM claims",
    "const updated = rows.map((r) => r.id)",
  ]) {
    assert.doesNotMatch(
      stmt,
      WRITES_A_TABLE,
      `the pattern reads a non-writer as a writer: ${stmt}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The mechanism — a real file, replaced, because presence proves nothing
// ---------------------------------------------------------------------------

/**
 * 🛑 THE SOURCE GUARDS ABOVE WOULD PASS ON A NO-OP. `databaseWasReplaced`
 * returns false for an unmarked connection, and a `:memory:` database has no
 * mark — so every test in the suite that uses one proves the call is present
 * and nothing about whether it fires. These two replace a real file.
 *
 * 🛑 THE `-wal` AND `-shm` MOVE TOO. On #138 a first probe moved only `chat.db`,
 * both files then shared one WAL, and the defect appeared not to exist.
 */
function replaceDatabaseFile(): DatabaseSync {
  const path = dbPath();

  for (const suffix of ["", "-wal", "-shm"]) {
    const p = `${path}${suffix}`;
    if (existsSync(p)) renameSync(p, `${p}.moved`);
  }

  const replacement = new DatabaseSync(path);
  replacement.exec("PRAGMA journal_mode = WAL");
  migrate(replacement);

  return replacement;
}

/**
 * ⚠️ `assert.throws` RETURNS undefined, so a test reading a field off its result
 * fails for a reason unrelated to the guard. That cost a round trip on #138.
 */
function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }

  assert.fail("the write did not throw");
}

const claimInput = (resource: string) => ({
  resource,
  holder: "claude2",
  note: null,
  claimed_at: Date.now(),
  expires_at: Date.now() + 60_000,
});

test("🚨 TAKING A CLAIM through a handle whose file was REPLACED throws", (t) => {
  const db = openDb();
  t.after(() => db.close());

  const replacement = replaceDatabaseFile();
  t.after(() => replacement.close());

  const err = thrown(() => dao.insertClaim(db, claimInput("the-gate")));

  assert.ok(
    err instanceof DatabaseReplacedError,
    `expected DatabaseReplacedError, got ${err.name}: ${err.message}`,
  );
  assert.match(err.message, /insertClaim/);

  // 🛑 THE SENTENCE HAS TO SAY RESTART. A replaced file is a property of the
  // CONNECTION, so every retry on this handle lands in the same orphaned inode.
  // Without the instruction the agent loops.
  assert.match(err.message, /RESTART/);

  // ⚠️ THE CONSEQUENCE, NOT ONLY THE THROW. Without this the test passes on a
  // guard that throws for an unrelated reason, and the point of the ticket is
  // that the claim becomes invisible to the other agent.
  assert.deepEqual(
    replacement.prepare("SELECT id FROM claims").all(),
    [],
    "the file at the path holds the claim after all, so this fixture is not the defect",
  );
});

/**
 * 🛑 AN UPDATE PATH, NOT A SECOND INSERT. `insertClaim` reads
 * `lastInsertRowid`; `releaseClaim` reads only `changes`. The ticket's own
 * check-list says the rowid route is already guarded in the claim writers, so
 * the verb that had NO second line of defence is the one worth a fixture.
 */
test("🚨 RELEASING a claim through a replaced handle throws too", (t) => {
  const db = openDb();
  t.after(() => db.close());

  const taken = dao.insertClaim(db, claimInput("the-stack"));
  assert.ok(taken, "the fixture could not take a claim to release");

  const replacement = replaceDatabaseFile();
  t.after(() => replacement.close());

  const err = thrown(() => dao.releaseClaim(db, taken.id, Date.now()));

  assert.ok(
    err instanceof DatabaseReplacedError,
    `expected DatabaseReplacedError, got ${err.name}: ${err.message}`,
  );
  assert.match(err.message, /releaseClaim/);
});

/**
 * 🛑 THE NON-VACUITY CONTROL. Both tests above pass against a guard that
 * refuses EVERY write, so an untouched handle has to be shown still working
 * through the same fixture machinery.
 */
test("a claim taken and released through an UNTOUCHED handle still works", (t) => {
  const db = openDb();
  t.after(() => db.close());

  const taken = dao.insertClaim(db, claimInput("the-deploy"));

  assert.ok(taken, "a healthy insertClaim returned null");
  assert.equal(dao.releaseClaim(db, taken.id, Date.now()), true);
});

/**
 * 🛑 THE GUARD ABOVE IS SCOPED TO ONE FILENAME, AND THAT IS THIS FILE'S OWN
 * STATED LESSON APPLIED TO ITSELF.
 *
 * `DAO` is a literal path, so a writer added in a NEW module under
 * `src/storage/` is not merely missed — it is unreachable by every assertion
 * above, and the suite reads exactly like a clean tree. #268's own write-up
 * says an audit scoped to the names already in hand undercounts, and it
 * undercounted by 8x. A second storage module is the same mistake one level up.
 *
 * So this asserts the SCOPE, not the contents: the only files under
 * `src/storage/` that contain a table write are the audited one and the
 * exempt one. A third gets named here the moment it appears, and whoever adds
 * it then chooses between moving the write into `dao.ts` and widening the
 * audit on purpose.
 *
 * ⚠️ IT IS NOT A COUNT. A new module with no writes does not fail it, and a
 * new module with one cannot be made green by editing a number.
 */
test("🛑 NO STORAGE MODULE OUTSIDE THE AUDITED ONE CONTAINS A TABLE WRITE", () => {
  const dir = "src/storage";
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

  // Denominator: a readdir that returned nothing would otherwise pass.
  assert.ok(
    files.includes("dao.ts") && files.length >= 2,
    `${dir} listed ${files.length} modules; the listing itself is broken`,
  );

  const audited = DAO.slice(dir.length + 1);
  const unaudited = files
    .filter((f) => f !== audited && !EXEMPT_FROM_THE_GUARD.includes(f))
    .filter((f) => {
      const source = stripComments(readFileSync(join(dir, f), "utf8"));
      return functionsOf(source).some(isWriter);
    });

  assert.deepEqual(
    unaudited,
    [],
    `${unaudited.join(", ")} write a table and no assertion in this file can ` +
      `reach them. Move the write into ${DAO}, or widen the audit here on ` +
      `purpose and say why.`,
  );
});
