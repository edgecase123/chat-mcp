import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentRow,
  childOnline,
  peersMinusSupervised,
  supervisedChildHandles,
} from "../../web/assets/logic.js";

/**
 * #374 — a dockerized agent appeared TWICE in the sidebar, under two handles.
 *
 * 🛑 THE TWO ROWS WERE ONE AGENT. The Agents row was keyed by the SUPERVISOR
 * handle; the Peers row was its CHILD. An operator counted agents off the
 * panel and got the wrong number.
 *
 * lee ruled it on 2026-11-21: *"i'd like the dockerized agents to look like
 * other agents like yourselves look in the web ui"*, and of `bound Nm`,
 * *"that looks confusing to a user and i'm not sure of the value in displaying
 * it as it exists now"*.
 */

const NOW = 1_700_000_000_000;

const live = (over: Record<string, unknown> = {}) => ({
  handle: "smoke-container",
  boundAt: NOW - 2 * 60 * 60 * 1000,
  child: {
    handle: "smoke-container-agent",
    context_used: 32_673,
    context_total: 200_000,
    fresh: true,
    age_ms: 1000,
  },
  ...over,
});

/**
 * 🛑 THE LABEL IS THE HANDLE A HUMAN WOULD MESSAGE, AND THE STOP TARGET IS NOT.
 * `/api/agents/stop` accepts only the supervisor, so the row carries both —
 * one to read and one to post. Collapsing them to a single field is how a stop
 * comes to answer a tested, honest-looking `ok: false`.
 */
test("the row is labelled with the child handle, and still stops the supervisor", () => {
  const r = agentRow(live());

  assert.equal(r.label, "smoke-container-agent");
  assert.equal(r.handle, "smoke-container");
  assert.equal(r.childHandle, "smoke-container-agent");
});

/**
 * A supervisor binds its socket before the child's first bus touch, so a
 * childless row is normal rather than an error.
 *
 * ⚠️ IT MUST STILL BE LABELLED. Falling back to the supervisor handle is what
 * keeps a just-spawned agent visible instead of rendering a nameless row.
 */
test("a supervisor with no child is labelled with its own handle", () => {
  const r = agentRow(live({ child: null }));

  assert.equal(r.label, "smoke-container");
  assert.equal(r.childHandle, null);
});

/**
 * 🛑 lee RULED THE SOCKET AGE OUT, so the row must not carry it in any form.
 * This is an ABSENCE assert and it cannot fail by accident, which is why the
 * two tests above are its paired positive control — a row object stripped to
 * `{}` would satisfy this one alone.
 */
test("the row carries no socket age, because lee ruled bound Nm out", () => {
  const keys = Object.keys(agentRow(live()));

  assert.deepEqual(
    keys.filter((k) => /bound/i.test(k)),
    [],
    "a bound field is back on the row",
  );
});

test("the child handles of every live supervisor are listed, childless ones skipped", () => {
  assert.deepEqual(
    supervisedChildHandles([
      live(),
      live({ handle: "other", child: { handle: "other-agent" } }),
      live({ handle: "fresh", child: null }),
    ]),
    ["smoke-container-agent", "other-agent"],
  );
});

/**
 * ⚠️ A NON-ARRAY REACHES THIS BEFORE THE FIRST FETCH. `state.agents` starts
 * null, and a throw here blanks the whole sidebar rather than one section.
 */
test("an unfetched agents list yields no child handles", () => {
  assert.deepEqual(supervisedChildHandles(null), []);
  assert.deepEqual(supervisedChildHandles(undefined), []);
});

/**
 * 🛑 THE DEFECT. The child is a real peer on the bus, so `listAgents` returns
 * it and the Peers section drew a second row for an agent the Agents section
 * had already drawn.
 */
test("a peer that is a supervised child is dropped from the peers list", () => {
  const peers = [
    { handle: "claude2", online: true },
    { handle: "smoke-container-agent", online: true },
  ];

  assert.deepEqual(peersMinusSupervised(peers, [live()]), [
    { handle: "claude2", online: true },
  ]);
});

/**
 * ⚠️ THE CONTROL, and the test above cannot fail without it: a filter that
 * returned `[]` for everything would satisfy it perfectly.
 */
test("a peer that is nobody's child is kept", () => {
  const peers = [{ handle: "claude2", online: true }];

  assert.deepEqual(peersMinusSupervised(peers, [live()]), peers);
  assert.deepEqual(peersMinusSupervised(peers, []), peers);
  assert.deepEqual(peersMinusSupervised(peers, null), peers);
});

/**
 * 🛑 THE SUPERVISOR HANDLE IS NOT A PEER AND MUST NOT BE FILTERED ON. It never
 * registers on the bus, so matching it would be dead code that silently became
 * wrong the day a supervisor did register.
 */
test("the supervisor handle is not used as a filter key", () => {
  const peers = [{ handle: "smoke-container", online: true }];

  assert.deepEqual(peersMinusSupervised(peers, [live()]), peers);
});

/**
 * 🛑 A RUNNING SUPERVISOR IS NOT A CONNECTED CHILD. `cursorSpawn` spawns one
 * process per turn, so a Cursor handle is offline between turns while its
 * supervisor stays up. The first cut of this row hardcoded `online: true` and
 * rendered a permanently green dot for exactly that agent.
 */
test("the child's online flag is read from its own peer record", () => {
  const peers = [
    { handle: "claude2", online: true },
    { handle: "smoke-container-agent", online: true },
  ];

  assert.equal(childOnline(peers, "smoke-container-agent"), true);
});

/**
 * ⚠️ THE CONTROL, in both directions. A helper returning `true` for everything
 * satisfies the test above, and one returning `false` for everything satisfies
 * the offline half alone.
 */
test("a child that is registered but not connected reads as offline", () => {
  const peers = [{ handle: "smoke-container-agent", online: false }];

  assert.equal(childOnline(peers, "smoke-container-agent"), false);
});

/**
 * ⚠️ ABSENT READS AS OFFLINE, NEVER AS ONLINE. The fails-open direction here
 * is a green dot for an agent nobody can reach.
 */
test("an unknown or unfetched child reads as offline, never online", () => {
  assert.equal(
    childOnline([{ handle: "claude2", online: true }], "nobody"),
    false,
  );
  assert.equal(childOnline(null, "smoke-container-agent"), false);
  assert.equal(childOnline(undefined, "smoke-container-agent"), false);
  assert.equal(childOnline([{ handle: "claude2", online: true }], null), false);
});
