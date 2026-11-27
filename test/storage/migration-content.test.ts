import { test } from "node:test";
import assert from "node:assert/strict";
import { migrationFingerprints, SCHEMA_VERSION } from "../../src/storage/db.js";

/**
 * 🛑 THE ONLY GUARD THAT FAILS WHEN A MIGRATION IS EDITED IN PLACE.
 *
 * `migrate` resumes from the version a database already stores, so editing an
 * earlier entry changes nothing on any existing machine. Measured: migration 7
 * was once made nullable in place, `MIGRATIONS.length` stayed at 7, and the
 * old NOT NULL table survived everywhere while every fresh-database test
 * passed. No behavioural test can reach that, because the edited code never
 * runs there.
 *
 * 🛑 A FAILURE HERE IS NOT FIXED BY UPDATING THE HASH. Append a new migration
 * that alters the schema instead. The hash is the record of what already
 * shipped to real databases.
 *
 * ⚠️ ONE EXCEPTION, AND IT IS MEASURED: a `--` comment inside a migration's
 * SQL is part of the hashed text, so correcting that wording moves the
 * fingerprint with no schema change. Re-pinning is correct there, and the
 * commit has to show the diff touches nothing but the comment.
 */
const SHIPPED: readonly string[] = [
  "d3774dcfc6758bb9", // 1
  "e7a38dfb3c134c01", // 2
  "b4152ef16f59f6fb", // 3
  "bedbcdf0f6580725", // 4
  "2f492b6a0ef8da88", // 5
  "e512c5be68c5b7cf", // 6
  "6d2a7577356c5c17", // 7
  "f0a555f67fb4b8a7", // 8
  "32f15000286ec32c", // 9
  "3453a07ed17f34dd", // 10
  "63aad8037c2c0bfd", // 11
  "e971c7566ddabfe3", // 12
  "a37f288f425cc9f4", // 13
  "c4598bf581a255fb", // 14
  "43ad1f7c2d0f0ad6", // 15
  "1d41af803f1f040a", // 16
  "8a27f968fc27f88d", // 17
  "b32fa842aa73dbc3", // 18
];

test("every shipped migration still has the content it shipped with", () => {
  const live = migrationFingerprints();

  for (const [i, shipped] of SHIPPED.entries()) {
    assert.equal(
      live[i],
      shipped,
      `migration ${i + 1} was EDITED. Existing databases already ran the old ` +
        `version and will never run this one. Append a new migration instead ` +
        `of updating this hash.`,
    );
  }
});

/**
 * ⚠️ THIS CATCHES AN ADDITION, NOT A DELETION. The loop above iterates
 * `SHIPPED`, so a deleted migration already fails it on an undefined entry —
 * measured. What nothing above can see is a migration APPENDED and left
 * unpinned, because the loop never visits an index `SHIPPED` lacks.
 */
test("every migration is pinned, including any just added", () => {
  assert.equal(
    SCHEMA_VERSION,
    SHIPPED.length,
    "a migration was added without pinning it here",
  );
});

test("no two migrations share a fingerprint", () => {
  const fp = migrationFingerprints();

  assert.equal(new Set(fp).size, fp.length);
});
