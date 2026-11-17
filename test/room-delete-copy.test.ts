import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * What every surface TELLS a caller about deleting a room (#127).
 *
 * 🛑 THE RULE SHIPPED RIGHT AND THE COPY SHIPPED WRONG. #89 moved
 * authorisation into `dao.deleteRoom`, and `room-delete-authz.test.ts` pins
 * the behaviour. Six strings kept saying membership was enough, and two sent
 * a refused caller to a current member who also cannot delete. Nothing
 * asserted any of them, so all six stayed wrong for 12 days and 97 commits.
 *
 * The documented precondition cannot be derived at runtime: four of the six
 * are static strings an agent reads BEFORE it calls anything.
 */

/** Every `.ts`/`.tsx` file under `src/`. */
function sourceFiles(dir = "src"): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }

  return out;
}

function lines(): ReadonlyArray<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  for (const f of sourceFiles())
    for (const line of readFileSync(f, "utf8").split("\n")) out.push([f, line]);

  return out;
}

/** The departed-owner fallback. Half the rule, and the half copy keeps losing. */
const FALLBACK = "any member may delete once the owner has left";

/** The whole documented precondition, as the four static descriptions carry it. */
const FULL_RULE = `owner-only while the owner is still a member; ${FALLBACK}`;

const MEMBER_ALONE = /caller must be a[^.)]*member/i;

test("🛑 NO DELETE SURFACE SAYS MEMBERSHIP ALONE IS ENOUGH", () => {
  const all = lines();

  // ⚠️ THE DENOMINATOR, and it is a POSITIVE CONTROL rather than a count.
  // `room_boot` IS member-only, so its copy must keep matching this pattern.
  // If it stops, the pattern has drifted and the delete scan below is reading
  // nothing. A plain "N lines scanned" would not catch that.
  const boot = all.filter(
    ([, l]) => MEMBER_ALONE.test(l) && /\bboot\b/i.test(l),
  );
  assert.ok(
    boot.length >= 3,
    `only ${boot.length} room_boot member-only strings matched; the pattern has drifted`,
  );

  const offenders = all
    .filter(([, l]) => MEMBER_ALONE.test(l) && /delete/i.test(l))
    .map(([f, l]) => `${f}: ${l.trim()}`);

  assert.deepEqual(
    offenders,
    [],
    `a delete surface still says membership is enough:\n${offenders.join("\n")}`,
  );
});

test("🛑 NO DELETE SURFACE SENDS A REFUSED CALLER TO A CURRENT MEMBER", () => {
  const all = lines();

  // ⚠️ THE DENOMINATOR. Both `not-a-member` refusals must still offer
  // recovery advice, or this test passes by having nothing left to check.
  const advice = all.filter(([, l]) => /Join first/i.test(l));
  assert.ok(
    advice.length >= 2,
    `only ${advice.length} not-a-member recovery strings found; expected the MCP tool and the oneshot`,
  );

  const offenders = all
    .filter(([, l]) => /ask a current member/i.test(l))
    .map(([f, l]) => `${f}: ${l.trim()}`);

  assert.deepEqual(
    offenders,
    [],
    `a refused caller is sent to someone who also cannot delete:\n${offenders.join("\n")}`,
  );
});

/**
 * The six surfaces, each pinned to the wording `README.md` already uses.
 *
 * Pinned, not derived: a check that only forbade the wrong phrasing would go
 * green on copy that says nothing about the owner at all. Four of these are
 * static strings read before any call, so there is nothing to derive from.
 *
 * ⚠️ `room_delete.ts` appears TWICE and the match is file-wide, so the two
 * entries are distinguished by their phrasing, not by position. The `ask its
 * owner` prefix only ever appears in the refusal.
 */
const PINS: ReadonlyArray<readonly [string, string]> = [
  // The MCP tool description — the string agents actually read.
  ["src/shim/tools/room_delete.ts", FULL_RULE],
  // The server-instructions bullet, injected into every agent's context.
  ["src/shim/index.ts", FULL_RULE],
  // The CLI command description.
  ["src/index.ts", FULL_RULE],
  // The shell alias comment.
  ["src/shell/aliases.ts", FULL_RULE],
  // The two `not-a-member` refusals, which must not misdirect the caller.
  ["src/shim/tools/room_delete.ts", `ask its owner — ${FALLBACK}`],
  ["src/oneshot/delete_room.ts", `ask its owner — ${FALLBACK}`],
];

test("🛑 ALL SIX DELETE COPY SITES NAME THE OWNER CONDITION", () => {
  assert.equal(PINS.length, 6, "#127 names six surfaces; the list has drifted");

  const missing = PINS.filter(
    ([f, phrase]) => !readFileSync(f, "utf8").includes(phrase),
  ).map(([f, phrase]) => `${f}: missing ${JSON.stringify(phrase)}`);

  assert.deepEqual(missing, [], missing.join("\n"));
});

test("🛑 THE FALLBACK CASE IS STATED, NOT JUST THE OWNER-ONLY CASE", () => {
  // The rule has FOUR outcomes. "Only the owner may delete" is ALSO wrong: a
  // departed owner, and a room with no owner row, both fall back to any
  // member. See `roomDeleteVerdict` in dao.ts.
  const files = [...new Set(PINS.map(([f]) => f))];
  assert.equal(files.length, 5, "the pinned file list has drifted");

  const silent = files.filter(
    (f) => !readFileSync(f, "utf8").includes(FALLBACK),
  );

  assert.deepEqual(
    silent,
    [],
    `copy states owner-only without the departed-owner fallback: ${silent.join(", ")}`,
  );
});
