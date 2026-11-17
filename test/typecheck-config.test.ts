import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * 🛑 THE TYPECHECKER READ `src/` ONLY, SO A TEST COULD IMPORT A SYMBOL THAT
 * DOES NOT EXIST AND STILL GO GREEN. `tsx` erases types at run time, so a
 * wrong `import type` path failed nothing at all.
 *
 * These assert the CONFIG reaches the test tree. They say nothing about
 * whether it is free of errors — that is the rest of #166.
 */

const ROOT = join(import.meta.dirname, "..");

/** The resolved program, from the compiler rather than from the file's text. */
function showConfig(project: string): {
  files: string[];
  compilerOptions: Record<string, unknown>;
} {
  const out = execFileSync("npx", ["tsc", "--showConfig", "-p", project], {
    cwd: ROOT,
    encoding: "utf8",
  });

  return JSON.parse(out) as {
    files: string[];
    compilerOptions: Record<string, unknown>;
  };
}

/**
 * Every TypeScript file actually on disk under `test/`, so the count has a
 * denominator.
 *
 * 🛑 EVERY TS EXTENSION, NOT `.ts`. A denominator of `.ts` alone cannot see an
 * `include` narrowed by EXTENSION — `test/**\/*.ts` drops a `.tsx` file and
 * every guard below still passes. The repo already has 18 `.tsx` files under
 * `src/cli/ink/`, so an Ink component test is the next one and it lands here.
 */
const TS_FILE = /\.(ts|tsx|mts|cts)$/;

function testFilesOnDisk(dir = join(ROOT, "test")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);

    if (entry.isDirectory()) return testFilesOnDisk(full);

    return TS_FILE.test(entry.name) ? [full] : [];
  });
}

test("🛑 tsconfig.test.json puts the test tree in the program", () => {
  const { files } = showConfig("tsconfig.test.json");
  const inTest = files.filter((f) =>
    relative(ROOT, join(ROOT, f)).startsWith("test/"),
  );

  assert.ok(inTest.length > 0, "the test config resolved no files under test/");
});

test("🛑 it reaches EVERY test file, not a narrowing subset", () => {
  const { files } = showConfig("tsconfig.test.json");
  const resolved = new Set(
    files
      .map((f) => relative(ROOT, join(ROOT, f)))
      .filter((f) => f.startsWith("test/")),
  );
  const onDisk = testFilesOnDisk().map((f) => relative(ROOT, f));
  const missing = onDisk.filter((f) => !resolved.has(f));

  assert.deepEqual(
    missing,
    [],
    `the test config does not reach ${missing.length} file(s) on disk`,
  );
});

test("🛑 it still reaches src/, or a test import resolves against nothing", () => {
  const { files } = showConfig("tsconfig.test.json");
  const inSrc = files.filter((f) =>
    relative(ROOT, join(ROOT, f)).startsWith("src/"),
  );

  assert.ok(inSrc.length > 0, "the test config resolved no files under src/");
});

test("🛑 rootDir is the repo root — ./src gives 100 x TS6059 and checks nothing", () => {
  const { compilerOptions } = showConfig("tsconfig.test.json");

  assert.notEqual(
    compilerOptions.rootDir,
    "./src",
    'rootDir ./src makes every test file "not under rootDir" and typechecks none of them',
  );
});

/**
 * 🛑 THE BROWSER MODULE MUST BE IN THE PROGRAM, OR ITS CONSUMERS SEE `any`.
 *
 * Every test under `test/web/` imports `web/assets/logic.js`. Absent from the
 * program it resolves as `any`, so a wrong argument and a null deref both
 * typecheck — seventeen of them did, and its JSDoc types ten more.
 *
 * It needs `allowJs` AND the `include`; either one alone resolves no file.
 */
test("🛑 it reaches web/assets, or every test/web import is `any`", () => {
  const { files } = showConfig("tsconfig.test.json");
  const resolved = files.map((f) => relative(ROOT, join(ROOT, f)));

  assert.ok(
    resolved.includes("web/assets/logic.js"),
    "web/assets/logic.js is not in the program, so test/web imports it as any",
  );
});

/**
 * ⚠️ THE GUARD ABOVE PROVES THE CONSUMERS ARE CHECKED, NEVER THE MODULE BODY.
 *
 * `allowJs` without `checkJs` puts the file in the program and type-checks
 * nothing inside it, so "no errors in web/assets" is the only answer that
 * config can give.
 *
 * 🛑 THAT IS NOW A RULING, NOT AN UNBUDGETED GAP. lee on #177, 2026-11-16:
 * "No, web assets should not be typechecked." Hand-written browser ES modules
 * stay out, so flipping `checkJs` reverses a decision and fails this first.
 *
 * ⚠️ NO ERROR COUNT HERE ON PURPOSE. This comment used to carry one, and it
 * was already wrong by the time #177 closed. Nothing in the suite measures
 * that number, so a copy of it here can only go stale.
 */
test("⚠️ checkJs stays off — web/assets is UNCHECKED, not clean", () => {
  const { compilerOptions } = showConfig("tsconfig.test.json");

  assert.notEqual(
    compilerOptions.checkJs,
    true,
    "checkJs is on; web/assets is excluded by lee's ruling on #177, not pending",
  );
});

/**
 * 🛑 THE CONFIG BEING RIGHT IS NOT THE CONFIG BEING RUN. Slices 1 to 4 left a
 * `tsconfig.test.json` that reached every test file and reported zero errors,
 * and nothing executed it — so a type error could still land on `main`.
 *
 * These two assert the wiring, which is slice 5. They are the reason "tsc
 * clean" means the test tree from here on.
 */

test("🛑 npm run typecheck reads the TEST config, not the build one", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  assert.match(
    pkg.scripts.typecheck ?? "",
    /tsconfig\.test\.json/,
    "the typecheck script does not name tsconfig.test.json",
  );
});

test("🛑 CI runs the typecheck, or nothing enforces any of this", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

  assert.match(ci, /run: npm run typecheck/, "ci.yml does not run typecheck");

  // ⚠️ THE OLD SRC-ONLY RUN IS GONE, NOT KEPT BESIDE IT. Left in place it
  // passes while the test tree is broken, which is the whole defect of #166.
  assert.doesNotMatch(
    ci,
    /run: npx tsc --noEmit\s*$/m,
    "ci.yml still runs the src-only typecheck, which greens a broken test tree",
  );
});

/**
 * 🛑 A TEMPLATE-LITERAL `await import()` TYPES AS `any`, SO EVERY ARGUMENT AT
 * THAT CALL SITE IS UNCHECKED EVEN NOW.
 *
 * Measured while clearing #166: seven `ChildGrant` literals named a `tools`
 * field that does not exist, and tsc reported SIX. The seventh sat behind
 * `await import(\`…?order-test=${Date.now()}\`)`, which TypeScript cannot
 * resolve, so the whole module came back `any`.
 *
 * The specifier is a cache-buster for module-mock ordering and cannot simply
 * become a literal. The fix is a `typeof import("…")` cast at each site, which
 * is its own change.
 *
 * ⚠️ THIS PINS THE COUNT RATHER THAN BANNING THE SHAPE. A new one is then a
 * deliberate act with a failing test beside it, instead of a silent hole.
 */
test("⚠️ the dynamic imports that type as `any` are the nine already known", () => {
  const known = 9;
  // `testFilesOnDisk` already matches `.mts`, which is where one of the nine
  // lives, so the walk needs no second pass for it.
  const sites = testFilesOnDisk().flatMap((file) => {
    const text = readFileSync(file, "utf8");

    return [...text.matchAll(/await\s+import\(\s*`/g)].map(() =>
      relative(ROOT, file),
    );
  });

  assert.ok(
    sites.length > 0,
    "the scan found no dynamic imports at all, so it is not reading the tree",
  );
  assert.equal(
    sites.length,
    known,
    `template-literal dynamic imports moved from ${known} to ${sites.length}: ${[...new Set(sites)].join(", ")}`,
  );
});
