import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every web-route test harness goes through `listenWithRoute` — #426.
 *
 * 🛑 THE HARNESS AND ITS OWN TESTS CANNOT MAKE THIS CLAIM. `route-server.test.ts`
 * proves the catch works; it says nothing about who uses it. Ten files built
 * their own `createServer` and one of them hand-copied production's catch, so
 * the behaviour was right in one place and absent in nine.
 *
 * 🛑 THIS IS THE TENTH-HARNESS GUARD. A new route test that writes its own
 * `createServer` reds HERE, which is the only place that can see it.
 */

const TEST_ROOT = dirname(fileURLToPath(import.meta.url));

/** The harness itself. It IS the permitted `route(req, res, ctx)` call site. */
const HARNESS = "support/route-server.ts";

/**
 * The file with its block comments and whole-line `//` comments removed.
 *
 * 🛑 A DOCBLOCK QUOTING `void route(req, res, ctx)` IS PROSE, NOT A CALL SITE.
 * Two files already quote the pattern in a comment and use the harness in
 * their code, so a raw text scan counts them and the next one to quote it
 * without using the harness would red for the wrong reason. Found by claude1
 * before this shipped; his naive pattern read 13 where the real count is 11.
 *
 * ⚠️ WHOLE-LINE `//` ONLY, NEVER A TRAILING ONE. These files build origins
 * like `http://127.0.0.1:${port}`, and a trailing-comment strip eats the rest
 * of any line holding a URL. A trailing comment that quotes the pattern
 * therefore still counts — that direction is a loud red, not a silent pass.
 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function sourceFiles(): string[] {
  return readdirSync(TEST_ROOT, { recursive: true, encoding: "utf8" })
    .filter((p) => p.endsWith(".ts"))
    .map((p) => p.split("\\").join("/"));
}

test("every test that drives `route` builds its server with listenWithRoute", () => {
  const files = sourceFiles();

  // 🛑 THE DENOMINATOR IS ASSERTED, NOT ASSUMED. A scan that walked the wrong
  // directory would report zero offenders and read as a clean sweep.
  assert.ok(
    files.length > 100,
    `expected to scan the whole test tree, saw ${files.length} .ts files`,
  );
  assert.ok(
    files.includes(HARNESS),
    `the scan must reach ${HARNESS}; it defines the one permitted call site`,
  );

  const drivesRoute = files.filter((rel) => {
    if (rel === HARNESS) return false;

    return /\broute\(req,\s*res/.test(
      codeOnly(readFileSync(join(TEST_ROOT, rel), "utf8")),
    );
  });

  // The same control one level down: if nothing drives `route` at all, the
  // regex has drifted and the assertion below is vacuous.
  assert.ok(
    drivesRoute.length > 0,
    "no file drives `route(req, res, …)`; the pattern has drifted",
  );

  const offenders = drivesRoute.filter(
    (rel) =>
      !readFileSync(join(TEST_ROOT, rel), "utf8").includes("listenWithRoute"),
  );

  assert.deepEqual(
    offenders,
    [],
    `these build their own route server instead of using ${HARNESS}:\n  ${offenders.join("\n  ")}`,
  );
});
