import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * #132 slice 4a — the registration card is actually WIRED.
 *
 * 🛑 EVERY TEST IN `registration-card.test.ts` PASSES WITH THIS CARD ABSENT.
 * Those helpers are pure, so they prove the strings and nothing about whether
 * a surface calls them. #224 shipped its bands three commits before anything
 * invoked them and a green suite said nothing for two sessions.
 *
 * There is no DOM harness for `app.js` here, so the wiring is asserted
 * against the source text, the same way `agents-wiring.test.ts` does.
 */

const APP = readFileSync(
  new URL("../../web/assets/app.js", import.meta.url),
  "utf8",
);

/**
 * `app.js` with BOTH comment forms removed, so prose cannot satisfy a code
 * check.
 *
 * 🛑 THE BLOCK FORM IS NOT OPTIONAL. A docblock naming `/api/agents` and the
 * word `admin` would otherwise pass a check about the code.
 */
const APP_CODE = APP.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

/** The body of one top-level function in `app.js`, comments already gone. */
function fnBody(name: string): string {
  const m = APP_CODE.match(
    new RegExp(`(?:async )?function ${name}\\([^)]*\\)[\\s\\S]*?\\n\\}`),
  );

  assert.notEqual(m, null, `${name}() not found in app.js`);

  // 🛑 THE CAPTURE'S OWN NON-VACUITY CONTROL, lifted from
  // `agents-wiring.test.ts`. The regex stops at the first line starting with
  // `}`, so a brace at column 0 inside the body truncates it and every
  // `doesNotMatch` then passes over the half that was cut.
  const depth = [...m![0]].reduce(
    (d, c) => d + (c === "{" ? 1 : c === "}" ? -1 : 0),
    0,
  );

  assert.equal(
    depth,
    0,
    `${name}()'s captured body is truncated — brace depth ${depth}`,
  );

  return m![0];
}

// ── the fetch ────────────────────────────────────────────────────────────

test("the card reads /api/agents, not /api/agents/live", () => {
  const body = fnBody("fetchRegistrations");

  assert.match(body, /"\/api\/agents"/, "fetchRegistrations reads elsewhere");
  assert.doesNotMatch(
    body,
    /agents\/live/,
    "the socket register answers a different question",
  );
});

/**
 * 🛑 A FAILED FETCH MUST NOT BLANK THE LIST. `fetchApprovals` carries the same
 * rule for the same reason: an empty card and a failed load look identical,
 * and here the thing that disappears is which agents are contained.
 */
test("🛑 a failed registrations fetch keeps the last known list", () => {
  const body = fnBody("fetchRegistrations");

  assert.match(body, /catch/, "fetchRegistrations has no catch");

  const afterCatch = body.slice(body.indexOf("catch"));

  assert.doesNotMatch(
    afterCatch,
    /state\.registrations\s*=/,
    "the catch branch overwrites the list it failed to load",
  );
});

// ── the render ───────────────────────────────────────────────────────────

test("🛑 the card is built by registrationRows, not by reading the route", () => {
  const found = APP_CODE.match(/registrationRows\(/g);

  assert.notEqual(found, null, "nothing calls registrationRows");
  assert.equal(
    found!.length,
    1,
    `expected 1 registrationRows call, got ${found!.length}`,
  );
});

test("🛑 app.js never maps a mode to a label itself", () => {
  assert.doesNotMatch(
    APP_CODE,
    /FULL HOST ACCESS/,
    "a second mode label in app.js can drift from the tested one",
  );
});

test("the empty state and the read-only notice both reach the render", () => {
  assert.match(APP_CODE, /registrationsPanelEmpty\(\)/);
  assert.match(APP_CODE, /registrationNotice\(/);
});

// ── the writes ───────────────────────────────────────────────────────────

test("registering POSTs to /api/agents", () => {
  const body = fnBody("submitRegistration");

  assert.match(body, /"\/api\/agents"/);
  assert.match(body, /method: "POST"/);
});

test("forgetting POSTs to /api/agents/forget", () => {
  const body = fnBody("forgetRegistration");

  assert.match(body, /"\/api\/agents\/forget"/);
  assert.match(body, /method: "POST"/);
});

/**
 * 🛑 THE FORM VALIDATES BEFORE IT POSTS. `POST /api/agents` accepts any
 * non-empty vendor string, so an unspawnable one is stored and only throws at
 * start time — one step removed from the operator who typed it.
 */
test("🛑 the draft is checked by registrationFormError before the POST", () => {
  const body = fnBody("submitRegistration");
  const check = body.indexOf("registrationFormError");
  const post = body.indexOf('"/api/agents"');

  assert.notEqual(check, -1, "submitRegistration never validates the draft");
  assert.ok(check < post, "the request is built before the draft is validated");
});

/**
 * 🛑 THE LOOSENING CONFIRM IS CONSULTED, AND BEFORE THE WRITE. Slice 2 settled
 * that a flag may tighten the mode and never loosen it, which makes this card
 * the only way out of `docker`.
 */
test("🛑 docker -> host is confirmed before the write, not after", () => {
  const body = fnBody("submitRegistration");
  const confirmText = body.indexOf("loosenConfirmText");
  const post = body.indexOf('"/api/agents"');

  assert.notEqual(confirmText, -1, "nothing consults loosenConfirmText");
  assert.ok(confirmText < post, "the write is issued before the confirm");
  assert.match(body, /confirm\(/, "the confirm text is computed but not shown");
});

test("forgetting is confirmed before the write", () => {
  const body = fnBody("forgetRegistration");
  const text = body.indexOf("forgetConfirmText");
  const post = body.indexOf('"/api/agents/forget"');

  assert.notEqual(text, -1, "nothing consults forgetConfirmText");
  assert.ok(text < post, "the write is issued before the confirm");
});

// ── the tier ─────────────────────────────────────────────────────────────

/**
 * 🛑 THE TIER COMES FROM `/api/whoami`, NOT FROM A MISSING `mode` KEY. An
 * empty agent list has no `mode` on any row, which would read as non-admin and
 * hide the form exactly when the operator has nothing registered yet.
 */
test("🛑 the capabilities come off whoami and reach the rows", () => {
  assert.match(
    APP_CODE,
    /state\.capabilities\s*=\s*(?:data|body|who)[^;]*capabilities/,
    "state.capabilities is not set from the whoami payload",
  );
  assert.match(
    APP_CODE,
    /registrationRows\([^)]*state\.capabilities/,
    "the rows are built without the caller's tier",
  );
});

test("🛑 the vendor control is fed by the served list, never a literal", () => {
  assert.match(APP_CODE, /state\.vendors/, "nothing stores the served list");
  assert.doesNotMatch(
    APP_CODE,
    /\[\s*"claude"\s*,\s*"cursor"\s*\]/,
    "app.js hardcodes the vendor list the server already sends",
  );
});
