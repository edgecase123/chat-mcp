import { test } from "node:test";
import assert from "node:assert/strict";
import {
  remoteHitsLabel,
  remoteOnlyHits,
  searchRequestUrl,
} from "../../web/assets/logic.js";

/**
 * 🛑 THE OPERATOR'S SEARCH BOX FILTERED 200 LOADED ROWS AND NOTHING ELSE
 * (#447). These helpers are the pure half of reaching the rest: building the
 * request, dropping the hits already on screen, and counting what is left.
 *
 * 🛑 "EARLIER IN THIS CONVERSATION" HAS TO BE TRUE. A server hit whose id is
 * already loaded is NOT earlier, so `remoteOnlyHits` drops it rather than
 * letting the label lie. That also hides a loaded row the local filter
 * rejected, which is the status quo and better than a false location.
 */

test("a blank or whitespace term builds no URL — the server 400s on one", () => {
  for (const term of ["", "   ", "\t"])
    assert.equal(
      searchRequestUrl(term, "#gate", 50),
      null,
      `term ${JSON.stringify(term)} built a URL`,
    );
});

/** The control. Without it a helper that ALWAYS returned null would pass. */
test("a real term builds a URL carrying the term, the target and the limit", () => {
  const u = searchRequestUrl("gate", "#gate", 50);
  assert.ok(u, "a real term built no URL");
  assert.match(u, /^\/api\/search\?/);
  assert.match(u, /[?&]q=gate(&|$)/);
  assert.match(u, /[?&]target=%23gate(&|$)/);
  assert.match(u, /[?&]limit=50(&|$)/);
});

test("🛑 a term and a target are percent-encoded, so neither can inject a parameter", () => {
  const u = searchRequestUrl("a&limit=1 b", "peer+a", 50);
  assert.ok(u);
  assert.doesNotMatch(
    u,
    /q=a&limit=1/,
    "an & in the term leaked a second parameter",
  );
  assert.match(u, /q=a%26limit%3D1%20b/);
  assert.match(u, /target=peer%2Ba/);
});

test("an absent target searches across conversations rather than sending a blank one", () => {
  const u = searchRequestUrl("gate", null, 50);
  assert.ok(u);
  assert.doesNotMatch(u, /target=/, "a null target sent an empty target=");
});

test("🛑 hits already in the loaded window are dropped, so the label cannot claim they are earlier", () => {
  const hits = [{ id: 10 }, { id: 20 }, { id: 30 }];

  assert.deepEqual(
    remoteOnlyHits(hits, [20]).map((h) => h.id),
    [10, 30],
  );
});

/** The control: nothing loaded means nothing is dropped. */
test("an empty loaded window drops no hits", () => {
  const hits = [{ id: 10 }, { id: 20 }];

  assert.deepEqual(
    remoteOnlyHits(hits, []).map((h) => h.id),
    [10, 20],
  );
});

test("every hit being on screen leaves nothing to offer", () => {
  assert.deepEqual(remoteOnlyHits([{ id: 10 }], [10]), []);
});

test("no remote hits renders no line at all, rather than a zero", () => {
  assert.equal(remoteHitsLabel(0, false), null);
});

test("one hit is singular and more than one is plural", () => {
  assert.match(remoteHitsLabel(1, false), /^1 more match earlier/);
  assert.match(remoteHitsLabel(3, false), /^3 more matches earlier/);
});

/**
 * 🛑 A CAPPED COUNT MUST SAY SO. `returned === limit` cannot tell an exact 50
 * from a cap, and the server already answers that with `truncated` — dropping
 * it here would report a capped list as a total.
 */
test("🛑 a truncated result set is marked with a +, not reported as a total", () => {
  assert.match(remoteHitsLabel(50, true), /^50\+ more matches earlier/);
  assert.doesNotMatch(remoteHitsLabel(50, true), /^50 more/);
});

test("the label names the conversation, because the search is scoped to one", () => {
  assert.match(remoteHitsLabel(2, false), /in this conversation$/);
});
