---
title: Schema migrations
updated: 2026-11-16
covers:
  - src/storage/db.ts
  - test/storage/migration-content.test.ts
  - test/storage/migrate-to.test.ts
  - test/storage/migration-8.test.ts
---

# Schema migrations

How the database reaches its current shape, why a migration may never be
edited once it has shipped, and how to test one on a database that predates it.

---

## The model

`MIGRATIONS` in `src/storage/db.ts` is a private array of functions, one per
version, applied in order. A database records how far it got in the
`schema_version` table.

```
SCHEMA_VERSION = MIGRATIONS.length      the version a fully migrated db reports
migrate(db)                             applies everything not yet applied
migrateTo(db, n)                        applies only up to version n
```

`migrate` resumes from the version the database already stores. That one line
is the source of the rule below.

## Never edit a shipped migration

**Append a new one instead.** A database that already recorded version `n` will
never re-run entry `n`, so editing it changes nothing on any existing machine
while every fresh-database test still passes.

This is not hypothetical. Migration 7 was once made nullable in place.
`MIGRATIONS.length` stayed at 7, so the loop ran zero times on existing
databases, the old `NOT NULL` table survived, and a permission denial hit the
constraint and was swallowed. Migration 8 exists only to repair that.

`test/storage/migration-content.test.ts` pins a content fingerprint per
migration and is the only guard that can fail on this. No behavioural test can
reach it, because the edited code never runs on the database that matters.

### When re-pinning is correct

A `--` comment inside a migration's SQL is part of the hashed text, so
rewording it moves the fingerprint with no schema change. That is the one case
where updating the pin is right, and the commit has to show the diff touches
nothing else. A `//` comment outside the SQL does not move a fingerprint.

## Testing a migration on an older database

Use `migrateTo` to build the database at the version before yours, seed it,
then call `migrate` and assert your change landed.

```ts
const db = new DatabaseSync(":memory:");
migrateTo(db, 7); // the version that shipped before migration 8
// seed here, with raw SQL
migrate(db); // carry it forward
```

## Common pitfalls

**The DAO cannot seed a historical database.** `dao.insertApproval` binds
`grant_entry`, a column added after migration 7, so calling it against a
version-7 table throws `table approvals has no column named grant_entry`. Seed
with raw SQL written against the columns that existed then.

**Seeding after `migrate` tests nothing about the data copy.** A fixture that
migrates to the current version and then inserts its "historic" row has no row
present while the rebuild runs. Measured: with migration 8's
`INSERT INTO approvals_new SELECT ... FROM approvals` deleted, so the rebuild
dropped every existing row, that fixture still reported green.

**A row carried up from version 7 has a null grant.** `grant_entry` did not
exist then, so `answerApproval(..., "approve", ...)` throws
`UnnameableApprovalError`. Such a row can only be denied.

---

## Source files

| File                                     | Role                                                     |
| ---------------------------------------- | -------------------------------------------------------- |
| `src/storage/db.ts`                      | `MIGRATIONS`, `migrate`, `migrateTo`, `SCHEMA_VERSION`   |
| `test/storage/migration-content.test.ts` | The frozen fingerprint pin — catches an in-place edit    |
| `test/storage/migrate-to.test.ts`        | That `migrateTo` stops where asked and `migrate` resumes |
| `test/storage/migration-8.test.ts`       | Migration 8 exercised on a real version-7 database       |

## Related docs

- [State directory](state-directory.md) — where the database file lives
