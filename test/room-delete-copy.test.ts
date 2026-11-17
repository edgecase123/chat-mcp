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
 * ⚠️ FOUR OF THE SIX ARE ASSERTED LIVE, NOT HERE. A file-text pin matches a
 * docblock quoting the phrase, and this repo quotes copy in docblocks
 * everywhere — so a pin on the thrown refusals passed with the live messages
 * gutted. `test/messaging/room-delete-refusal.test.ts` drives the real
 * transport instead, for both refusals, the tool description and the injected
 * server instructions.
 *
 * What is left here is the two surfaces with no runtime to read them, plus
 * two repo-wide scans that catch a SEVENTH surface arriving.
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

const MEMBER_ALONE = /caller must be a[^.)]*member/i;

/**
 * ⚠️ THE DENOMINATOR FOR BOTH SCANS, and it is a POSITIVE CONTROL rather than
 * a row count. `room_boot` IS member-only, so its copy must keep matching.
 * If it stops, the scanner is reading nothing and every claim below is about
 * an empty list. A plain "N lines scanned" would not catch that.
 */
function assertScannerSees(
  all: ReadonlyArray<readonly [string, string]>,
): void {
  const boot = all.filter(
    ([, l]) => MEMBER_ALONE.test(l) && /\bboot\b/i.test(l),
  );

  assert.ok(
    boot.length >= 3,
    `only ${boot.length} room_boot member-only strings matched; the scanner has drifted`,
  );
}

test("🛑 NO DELETE SURFACE SAYS MEMBERSHIP ALONE IS ENOUGH", () => {
  const all = lines();
  assertScannerSees(all);

  const offenders = all
    .filter(([, l]) => MEMBER_ALONE.test(l) && /delete/i.test(l))
    .map(([f, l]) => `${f}: ${l.trim()}`);

  assert.deepEqual(
    offenders,
    [],
    `a delete surface still says membership is enough:\n${offenders.join("\n")}`,
  );
});

test("🛑 NO SURFACE SENDS A REFUSED CALLER TO SOMEONE WHO IS ALSO REFUSED", () => {
  const all = lines();
  assertScannerSees(all);

  // Both phrasings name a handle that is itself refused in the case the same
  // sentence describes. "a current member" cannot delete while the owner is
  // present; "its owner" is not a member once they have left.
  const offenders = all
    .filter(([, l]) => /ask a current member|ask its owner/i.test(l))
    .map(([f, l]) => `${f}: ${l.trim()}`);

  assert.deepEqual(
    offenders,
    [],
    `a refused caller is sent to someone who also cannot delete:\n${offenders.join("\n")}`,
  );
});

/** The whole documented precondition, as the static descriptions carry it. */
const FULL_RULE =
  "owner-only while the owner is still a member; any member may delete once the owner has left";

/**
 * The two surfaces nothing can read at runtime.
 *
 * `src/index.ts` builds a Commander description and `src/shell/aliases.ts`
 * emits shell text, so there is no served value to assert. A text pin is the
 * strongest instrument available for these two and the weakest for the other
 * four, which is why they are split.
 */
const PINS: ReadonlyArray<readonly [string, string]> = [
  ["src/index.ts", FULL_RULE],
  ["src/shell/aliases.ts", FULL_RULE],
];

test("🛑 THE TWO STATIC DESCRIPTIONS CARRY THE RULE, BOTH HALVES OF IT", () => {
  // The rule has FOUR outcomes. "Only the owner may delete" is ALSO wrong: a
  // departed owner, and a room with no owner row, both fall back to any
  // member. `FULL_RULE` states both halves. See `roomDeleteVerdict` in dao.ts.
  const missing = PINS.filter(
    ([f, phrase]) => !readFileSync(f, "utf8").includes(phrase),
  ).map(([f, phrase]) => `${f}: missing ${JSON.stringify(phrase)}`);

  assert.deepEqual(missing, [], missing.join("\n"));
});
