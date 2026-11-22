import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SIDEBAR_SECTIONS,
  sidebarSignatures,
  sectionsToRebuild,
} from "../../web/assets/logic.js";

/**
 * #399 — a peer event used to destroy the whole sidebar.
 *
 * 🛑 THESE ARE PLANNER TESTS. They prove which sections a change requires, not
 * that `renderSidebar` then replaces those nodes. No test in this repo runs
 * `app.js` in a browser — that half is #330, and a correct planner with a wrong
 * `replaceChild` is invisible to everything here.
 */

const APP = readFileSync(
  new URL("../../web/assets/app.js", import.meta.url),
  "utf8",
);

/** `app.js` with both comment forms gone, so prose cannot satisfy a code check. */
const APP_CODE = APP.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

type State = Record<string, unknown>;

/** Every input any section declares, at a value that is not the changed one. */
function baseState(): State {
  const s: State = {};
  for (const { inputs } of SIDEBAR_SECTIONS) {
    for (const k of inputs) s[k] = k === "activity" ? new Set<string>() : null;
  }
  s.peers = [{ handle: "a", online: true }];
  s.agents = [{ handle: "sup", child: { gauge: { show: true, percent: 10 } } }];
  s.rooms = [{ name: "#one", unread: 0 }];
  s.claims = [];
  s.discoverRooms = [];
  return s;
}

const plan = (mutate: (s: State) => void) => {
  const before = baseState();
  const prev = sidebarSignatures(before);
  const after = baseState();
  mutate(after);
  return sectionsToRebuild(prev, sidebarSignatures(after));
};

test("the six sections are declared in render order", () => {
  assert.deepEqual(
    SIDEBAR_SECTIONS.map((s) => s.key),
    ["claims", "agents", "registration", "peers", "rooms", "discover"],
  );
});

/**
 * 🛑 THE DEFECT ITSELF. A peer going online must not reach the registration
 * form, which is where a half-typed handle lives.
 */
test("a peers-only change rebuilds peers and NOTHING else", () => {
  const due = plan((s) => {
    s.peers = [
      { handle: "a", online: true },
      { handle: "b", online: true },
    ];
  });

  assert.deepEqual(due, ["peers"]);
});

/**
 * ⚠️ THE CO-PRIMARY CONTROL, and the identity half cannot fail without it: a
 * planner that returns [] for everything satisfies "registration was not
 * rebuilt" perfectly.
 */
test("a change a section DOES own rebuilds that section", () => {
  assert.deepEqual(
    plan((s) => {
      s.registrationError = "handle is already registered";
    }),
    ["registration"],
  );

  assert.deepEqual(
    plan((s) => {
      s.claims = [{ resource: "issue-399", holder: "claude2" }];
    }),
    ["claims"],
  );
});

/**
 * 🛑 THE `fillPercent` HAZARD. `app.js` captures a gauge percent at build time
 * and the gate risk note quotes it back — "this agent is at 72%". A signature
 * over `state.agents.length` would skip this and quote a stale number.
 */
test("a change to one agent's gauge percent alone rebuilds agents", () => {
  const due = plan((s) => {
    s.agents = [
      { handle: "sup", child: { gauge: { show: true, percent: 93 } } },
    ];
  });

  assert.deepEqual(due, ["agents"]);
});

/**
 * 🛑 `JSON.stringify(new Set())` IS `{}` FOR EVERY SET. Without the Set branch
 * the activity pulse compares equal forever and peers stops updating, which
 * looks exactly like success.
 */
test("a change to the activity Set alone rebuilds peers and agents", () => {
  const due = plan((s) => {
    s.activity = new Set(["a"]);
  });

  // 🛑 AGENTS IS IN HERE SINCE #374. Its row is a `sidebarItem`, so the
  // working pulse dresses an agent row exactly as it dresses a peer row.
  assert.deepEqual(due, ["agents", "peers"]);
});

test("Set membership is compared by CONTENT, not insertion order", () => {
  const a = baseState();
  a.activity = new Set(["x", "y"]);
  const b = baseState();
  b.activity = new Set(["y", "x"]);

  assert.deepEqual(
    sectionsToRebuild(sidebarSignatures(a), sidebarSignatures(b)),
    [],
  );
});

test("nothing changing rebuilds nothing", () => {
  assert.deepEqual(
    plan(() => {}),
    [],
  );
});

/** An empty `prev` is the first render, so every section is due. */
test("a first render rebuilds every section", () => {
  assert.deepEqual(
    sectionsToRebuild({}, sidebarSignatures(baseState())),
    SIDEBAR_SECTIONS.map((s) => s.key),
  );
});

/**
 * 🛑 THE WIPE IS THE BUG. If this line comes back, every test above still
 * passes and the operator's work is destroyed again.
 */
test("renderSidebar no longer wipes the sidebar", () => {
  assert.doesNotMatch(APP_CODE, /el\.sidebar\.innerHTML\s*=/);
});

test("every declared section has a builder wired in app.js", () => {
  for (const { key } of SIDEBAR_SECTIONS) {
    assert.match(
      APP_CODE,
      new RegExp(`\\b${key}:\\s*\\w+Section,`),
      `no builder wired for the "${key}" section`,
    );
  }
});

/**
 * ⚠️ THE SCROLL RESTORE IS A SOURCE PIN, not a measurement. happy-dom reports
 * scroll geometry as 0 (`logic.test.ts`), so the real check is #330's.
 */
test("renderSidebar reads scrollTop before mutating and restores it after", () => {
  const read = APP_CODE.indexOf("const prevScrollTop = el.sidebar.scrollTop");
  const write = APP_CODE.indexOf("el.sidebar.scrollTop = prevScrollTop");
  const mutate = APP_CODE.indexOf("el.sidebar.replaceChild");

  assert.notEqual(read, -1, "no scrollTop read");
  assert.notEqual(write, -1, "no scrollTop restore");
  assert.notEqual(mutate, -1, "no replaceChild — the pin would be vacuous");
  assert.ok(read < mutate, "the read must precede the first mutation");
  assert.ok(mutate < write, "the restore must follow the mutation");
});

/**
 * 🛑 `baseState`'s child is NOT the shape `/api/agents/live` sends. The route
 * spreads `gaugeFreshness` onto the child, so `fresh` and `age_ms` sit beside
 * `context_used`; `gauge` is derived in the browser and never arrives. The
 * tests below need the real shape, because the defect lives in those two keys.
 */
function liveState(child: Record<string, unknown> | null): State {
  const s = baseState();
  s.nowMinute = 1;
  s.agents = [{ handle: "sup", child }];
  return s;
}

const planFrom = (before: State, after: State) =>
  sectionsToRebuild(sidebarSignatures(before), sidebarSignatures(after));

/** A child that HAS reported, so `fresh` and `age_ms` are both populated. */
const reported = {
  context_used: 100,
  context_total: 1_000,
  context_reported_at: 500,
  fresh: true,
  age_ms: 1_000,
};

/**
 * 🛑 THE FROZEN CLOCK, AND #374 DID NOT REMOVE IT. The reason used to be
 * `bound Xm`, which is gone — but the projection below drops `fresh`, so the
 * minute bucket is now the ONLY thing that announces the 15-minute flip to the
 * stale gauge band. A childless supervisor still has a byte-stable payload.
 */
test("a childless supervisor rebuilds agents once the minute rolls", () => {
  const after = liveState(null);
  after.nowMinute = 2;

  assert.deepEqual(planFrom(liveState(null), after), ["agents"]);
});

/**
 * ⚠️ THE CONTROL FOR THE TEST ABOVE. A planner returning every key satisfies
 * it perfectly, so the same fixture with nothing moved must return nothing.
 */
test("a childless supervisor within the same minute rebuilds nothing", () => {
  assert.deepEqual(planFrom(liveState(null), liveState(null)), []);
});

/**
 * 🛑 THE SKIP WAS VACUOUS IN THE OTHER DIRECTION. `age_ms` is recomputed on
 * every request, so a signature holding it differed on every wake and the
 * agents section rebuilt every time.
 */
test("age_ms moving alone rebuilds nothing", () => {
  const after = liveState({ ...reported, age_ms: 61_000 });

  assert.deepEqual(planFrom(liveState({ ...reported }), after), []);
});

/** The same, for the other clock-derived field. */
test("fresh flipping alone rebuilds nothing", () => {
  const after = liveState({ ...reported, fresh: false });

  assert.deepEqual(planFrom(liveState({ ...reported }), after), []);
});

/**
 * 🛑 WHY THE TWO TESTS ABOVE ARE SAFE ONLY WITH THE MINUTE BUCKET. Dropping
 * `fresh` from the signature means nothing else announces the 15-minute flip to
 * the stale band, so the bucket has to carry it.
 */
test("a stale flip rebuilds agents on the next minute roll", () => {
  const after = liveState({ ...reported, fresh: false });
  after.nowMinute = 2;

  assert.deepEqual(planFrom(liveState({ ...reported }), after), ["agents"]);
});

/**
 * ⚠️ THE DISCRIMINATING CONTROL FOR THE PROJECTION. Stripping the whole child,
 * or the whole `agents` key, passes every test above. Real state inside the
 * child must still be seen.
 */
test("real child state still rebuilds agents", () => {
  assert.deepEqual(
    planFrom(
      liveState({ ...reported }),
      liveState({ ...reported, context_used: 900 }),
    ),
    ["agents"],
    "a gauge percent change must not be skipped",
  );

  assert.deepEqual(
    planFrom(
      liveState({ ...reported }),
      liveState({ ...reported, context_reported_at: 900 }),
    ),
    ["agents"],
    "a NEW report is real state, not a clock read",
  );
});

/**
 * 🛑 THE BUCKET MUST BE STAMPED AT RENDER TIME. `fetchLiveAgents` is not on a
 * timer — `refresh()` runs on an SSE wake — so a bucket stamped where the
 * payload is fetched would never tick on a wake that fetched nothing.
 */
test("renderSidebar stamps the minute before it signs", () => {
  const stamp = APP_CODE.indexOf("state.nowMinute = ");
  const sign = APP_CODE.indexOf("sidebarSignatures(state)");

  assert.notEqual(stamp, -1, "no minute stamp in app.js");
  assert.notEqual(sign, -1, "no signature call — the pin would be vacuous");
  assert.ok(stamp < sign, "the stamp must precede the signature");
  assert.equal(
    APP_CODE.match(/state\.nowMinute\s*=/g)?.length,
    1,
    "stamped in more than one place — one of them is not render time",
  );
});

/**
 * 🛑 THE TWO TESTS BELOW BACK CLAIMS THAT NOW SIT IN COMMENTS IN `app.js`.
 * A comment asserting render behaviour and nothing proving it is how the four
 * stale justifications this slice replaced got there in the first place.
 */
test("storing a pair rebuilds the registration section", () => {
  const due = plan((s) => {
    s.registrations = { agents: { "claude-x": { vendor: "cursor" } } };
  });

  assert.deepEqual(due, ["registration"]);
});

/**
 * `openMenuFor` is an input of agents, peers and rooms, so it rebuilds all
 * three. Agents joined them in #374, when its row became a `sidebarItem` with
 * the same (...) menu.
 */
test("an open (...) menu is an input of agents, peers AND rooms", () => {
  const due = plan((s) => {
    s.openMenuFor = "@alice";
  });

  assert.deepEqual(due, ["agents", "peers", "rooms"]);
});

/**
 * 🛑 THE HEADLINE CASE OF #399, AND SLICES 1 AND 2 DID NOT FIX IT.
 * `registrationDraft` was an input of the section it exists to protect, so
 * typing was itself what triggered the rebuild that swaps the <input> out.
 */
test("typing into the register form rebuilds nothing", () => {
  const due = plan((s) => {
    s.registrationDraft = { handle: "cla", vendor: "cursor", mode: "docker" };
  });

  assert.deepEqual(due, []);
});

/**
 * 🛑 WHY AN EXPLICIT EPOCH AND NOT JUST DROPPING THE DRAFT. On success
 * `submitRegistration` clears the draft, and the input only empties because the
 * section rebuilds. Re-submitting an IDENTICAL pair changes `registrations` by
 * zero bytes, so without this the cleared handle would stay on screen.
 */
test("a bumped epoch rebuilds registration even when nothing else moved", () => {
  const due = plan((s) => {
    s.registrationEpoch = 1;
  });

  assert.deepEqual(due, ["registration"]);
});

/**
 * 🛑 THE EPOCH MUST BUMP IN THE SUCCESS BRANCH, NOT MERELY SOMEWHERE NEARBY.
 * A bump moved into the `catch` keeps a co-location check green while the
 * clear goes invisible again, so this pins three indices the way the
 * `scrollTop` test above pins read < mutate < write.
 */
test("submitRegistration bumps the epoch after the clear and before the catch", () => {
  const fn = APP_CODE.slice(
    APP_CODE.indexOf("async function submitRegistration("),
  ).split("\n}")[0];

  const clear = fn.indexOf("state.registrationDraft = {");
  const bump = fn.indexOf("state.registrationEpoch++");
  const caught = fn.indexOf("} catch");

  assert.notEqual(clear, -1, "no draft clear — the pin would be vacuous");
  assert.notEqual(bump, -1, "no epoch bump");
  assert.notEqual(caught, -1, "no catch — the ordering could not discriminate");
  assert.ok(clear < bump, "the bump must follow the clear it announces");
  assert.ok(bump < caught, "the bump must be in the SUCCESS branch");
});

/**
 * 🛑 #374 — THE PEERS SECTION NOW HIDES SUPERVISED CHILDREN, so a child
 * appearing changes what it renders while `state.peers` is byte-identical.
 * Undeclared, the duplicate row would persist until some unrelated peer event
 * happened to rebuild the section.
 */
test("a supervised child appearing rebuilds agents AND peers", () => {
  const due = plan((s) => {
    s.agents = [
      {
        handle: "sup",
        child: { handle: "sup-agent", gauge: { show: true, percent: 10 } },
      },
    ];
  });

  assert.deepEqual(due, ["agents", "peers"]);
});

/**
 * ⚠️ THE CONTROL FOR THE TEST ABOVE, AND IT DISCRIMINATES IN BOTH DIRECTIONS.
 * Signing the whole `agents` payload for the peers section would rebuild it on
 * every gauge tick — the churn #399 existed to stop — and a projection that
 * returned a constant would satisfy the test above while never hiding anything.
 */
test("a clock-only agents change rebuilds neither agents nor peers", () => {
  const due = plan((s) => {
    s.agents = [
      {
        handle: "sup",
        child: { gauge: { show: true, percent: 10 }, age_ms: 61_000 },
      },
    ];
  });

  assert.deepEqual(due, []);
});
