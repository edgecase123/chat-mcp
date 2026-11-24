/**
 * Tells a reader WHICH KIND of red a test run was.
 *
 * A test file can die while its module loads, which Node reports as a failure
 * on the file itself with no assertion. The tests inside it never run, so the
 * total comes back short and the run looks exactly like a crash in the change
 * under test. Telling the two apart by hand costs a diagnosis round.
 *
 * 🛑 THE DISCRIMINATOR IS STRUCTURAL, NOT AN ERROR STRING. One occurrence of
 * this reported `ERANGE` on `open` and no `ERR_MODULE_NOT_FOUND` anywhere in
 * the log, so a detector keyed on the message would have missed it.
 *
 * Add it ALONGSIDE the default reporter, which it does not replace:
 *   node --test --test-reporter=spec --test-reporter-destination=stdout \
 *        --test-reporter=./scripts/file-death-reporter.mjs \
 *        --test-reporter-destination=stdout
 */

import { resolve } from "node:path";

/**
 * Node names a file-level death after the file; a real test carries its own name.
 *
 * 🛑 COMPARE WHAT THE PATHS RESOLVE TO, NEVER THE STRINGS. `name` is the path
 * AS INVOKED and `file` is always absolute, so a glob run — which is what
 * `npm test` does — reports a relative `name` and a literal `===` is false for
 * every real occurrence.
 */
const isFileDeath = (d) =>
  typeof d?.file === "string" &&
  typeof d?.name === "string" &&
  resolve(d.name) === resolve(d.file);

export function classify(events) {
  const fileDeaths = [];
  const testFailures = [];

  for (const e of events) {
    const d = e?.data;
    if (!d) continue;
    (isFileDeath(d) ? fileDeaths : testFailures).push(d);
  }

  return { fileDeaths, testFailures };
}

export function verdict({ fileDeaths, filesSeen }) {
  if (fileDeaths.length === 0) return null;

  const total = filesSeen.size;

  if (total > 1 && fileDeaths.length === total) {
    return [
      `🛑 EVERY TEST FILE DIED (${total} of ${total}). THE ENVIRONMENT IS BROKEN.`,
      ``,
      `   No file got as far as running a test, so this is not one bad file.`,
      `   The usual cause is a missing or partial install.`,
      ``,
      `     npm ci`,
      ``,
    ].join("\n");
  }

  const lines = [
    `🛑 ${fileDeaths.length} TEST FILE${fileDeaths.length > 1 ? "S" : ""} DIED BEFORE RUNNING ANY TEST — SEE #427.`,
    ``,
    `   Each file below failed with no assertion, so its module never finished`,
    `   loading and its tests never ran. The total count is short by however`,
    `   many they hold.`,
    ``,
  ];

  for (const d of fileDeaths) lines.push(`     ${d.file}`);

  lines.push(
    ``,
    `   Re-run the file alone. If it passes alone, this red is #427.`,
    `   It is NOT the change under test.`,
    ``,
  );

  return lines.join("\n");
}

export default async function* fileDeathReporter(source) {
  const failures = [];
  const filesSeen = new Set();

  for await (const e of source) {
    if (typeof e?.data?.file === "string") filesSeen.add(e.data.file);
    if (e.type === "test:fail") failures.push(e);
  }

  const v = verdict({ ...classify(failures), filesSeen });
  if (v) yield `\n${v}\n`;
}
