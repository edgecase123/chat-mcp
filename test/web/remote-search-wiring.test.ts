import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { oneLine } from "../support/source-text.js";

/**
 * 🛑 `search-remote.test.ts` PASSES WITH NOTHING WIRED AT ALL (#447).
 *
 * `searchRequestUrl`, `remoteOnlyHits` and `remoteHitsLabel` are pure, so their
 * own tests prove only that the decisions are right. Delete the fetch, or the
 * `appendRemoteHits` call, and all eleven stay green while the box still
 * reaches nothing past the loaded window. There is no DOM here, so the wiring
 * is asserted against the source — the same method as
 * `focus-search-wiring.test.ts`.
 *
 * ⚠️ EVERY ASSERTION IS GUARDED BY A FOUND-COUNT FIRST. A regex that stops
 * matching after a rename would otherwise report clean by matching nothing.
 */

const APP = readFileSync(
  new URL("../../web/assets/app.js", import.meta.url),
  "utf8",
);

/** `app.js` with `//` comments removed, so prose cannot satisfy a code check. */
const APP_CODE = APP.split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

const FLAT = oneLine(APP_CODE);

test("🛑 the request is built with the OPEN conversation as its target", () => {
  const calls = [...FLAT.matchAll(/searchRequestUrl\(([^)]*)\)/g)];

  assert.equal(calls.length, 1, "expected exactly one searchRequestUrl call");
  assert.match(
    calls[0]![1]!,
    /state\.currentTarget|\btarget\b/,
    "searchRequestUrl was called without the conversation target — lee ruled the search is scoped to the open DM or room",
  );
});

test("🛑 the target passed is read from state, not hardcoded or dropped", () => {
  assert.match(
    FLAT,
    /const target = state\.currentTarget;/,
    "fetchRemoteHits does not read the open conversation from state",
  );
});

test("typing schedules the search instead of firing one per keystroke", () => {
  const listeners = [
    ...FLAT.matchAll(/el\.paneSearch\.addEventListener\(['"]input['"]/g),
  ];
  assert.equal(listeners.length, 1, "expected one input listener on the box");

  const start = FLAT.indexOf("el.paneSearch.addEventListener('input'");
  const alt = FLAT.indexOf('el.paneSearch.addEventListener("input"');
  const at = start === -1 ? alt : start;
  const body = FLAT.slice(at, FLAT.indexOf("});", at));

  assert.match(
    body,
    /scheduleRemoteSearch\(\)/,
    "the input listener never schedules a remote search",
  );
  assert.doesNotMatch(
    body,
    /fetchRemoteHits\(/,
    "the input listener fetches directly, so every keystroke is a query",
  );
});

test("the debounce is a real delay, not zero", () => {
  const m = FLAT.match(/REMOTE_SEARCH_DEBOUNCE_MS = (\d+)/);
  assert.ok(m, "no debounce constant found");
  assert.ok(
    Number(m[1]) >= 100,
    `debounce is ${m[1]}ms, which does not batch a typed word`,
  );
});

/**
 * 🛑 THE GUARD THIS FILE EXISTS FOR. `renderMessages` returns from four
 * places, and a trailer added to three of them is invisible in the fourth.
 * One seam means `appendEphemeral` is called EXACTLY ONCE in the whole file —
 * from `appendTrailers` — and every exit calls `appendTrailers` instead.
 */
test("🛑 every renderMessages exit renders the remote hits, via one seam", () => {
  // ⚠️ `(?<!function )` IS LOAD-BEARING. Without it `function appendEphemeral()`
  // counts as a call site and this test fails on the definition it is checking
  // — which is exactly how its first cut failed.
  const trailerCalls = [...FLAT.matchAll(/(?<!function )appendTrailers\(\)/g)];
  const ephemeralCalls = [
    ...FLAT.matchAll(/(?<!function )appendEphemeral\(\)/g),
  ];

  assert.equal(
    trailerCalls.length,
    4,
    `expected all 4 renderMessages exits to call appendTrailers, found ${trailerCalls.length}`,
  );
  assert.equal(
    ephemeralCalls.length,
    1,
    "appendEphemeral is called from more than one place, so an exit can skip the remote hits",
  );
  assert.match(
    FLAT,
    /function appendTrailers\(\) \{ appendEphemeral\(\); appendRemoteHits\(\); \}/,
    "appendTrailers does not render both trailers",
  );
});

test("🛑 a hit row reuses the fragment route rather than a second jump path", () => {
  const start = FLAT.indexOf("function appendRemoteHits()");
  assert.notEqual(start, -1, "appendRemoteHits is not defined");

  const body = FLAT.slice(
    start,
    FLAT.indexOf("function appendTrailers", start),
  );

  assert.match(
    body,
    /href: messageHash\(hit\.id\)/,
    "a hit row does not carry the message fragment, so hashchange cannot route it",
  );
  assert.match(
    body,
    /remoteOnlyHits\(state\.remote\.hits, state\.renderedIds\)/,
    "the rendered hits are not filtered against what is already on screen",
  );
});

test("switching conversation drops hits scoped to the one you left", () => {
  const start = FLAT.indexOf("async function selectTarget(target)");
  assert.notEqual(start, -1, "selectTarget is not defined");

  const body = FLAT.slice(start, start + 600);

  assert.match(
    body,
    /scheduleRemoteSearch\(\)/,
    "selectTarget leaves the previous conversation's remote hits in state",
  );
});

/**
 * An out-of-order reply must not be shown against a term nobody typed. The
 * pure helpers cannot check this — the stale-response guard lives in the fetch.
 */
test("🛑 a reply that lands after the box moved on is discarded", () => {
  const start = FLAT.indexOf("async function fetchRemoteHits(term)");
  assert.notEqual(start, -1, "fetchRemoteHits is not defined");

  const body = FLAT.slice(
    start,
    FLAT.indexOf("function appendRemoteHits", start),
  );

  assert.match(
    body,
    /state\.searchTerm\.trim\(\) !== term\.trim\(\)/,
    "no term re-check, so a slow reply can overwrite newer hits",
  );
  assert.match(
    body,
    /state\.currentTarget !== target/,
    "no target re-check, so a reply can land in the wrong conversation",
  );
});
