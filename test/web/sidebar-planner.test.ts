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

test("the five sections are declared in render order", () => {
  assert.deepEqual(
    SIDEBAR_SECTIONS.map((s) => s.key),
    ["claims", "agents", "peers", "rooms", "discover"],
  );
});

/**
 * 🛑 THE REGISTRATION SECTION IS GONE, NOT RENAMED. #397 moved its controls into
 * the settings dialog, which `renderSidebar` never calls. A key left here would
 * send `renderSidebar` to `SECTION_BUILDERS` for a builder that is not there.
 */
test("no sidebar section claims the registration controls", () => {
  assert.deepEqual(
    SIDEBAR_SECTIONS.filter((s) => s.key === "registration"),
    [],
  );
});

/**
 * 🛑 THE DEFECT ITSELF, AND IT IS STILL WORTH PINNING. The half-typed handle
 * now lives in the settings dialog, so a peer event cannot reach it structurally
 * — but `peers` must still not drag four other sections through a rebuild on
 * every status tick, which is the rest of what #399 bought.
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
 * ⚠️ THE CO-PRIMARY CONTROL, and the identity half above cannot fail without it:
 * a planner that returns [] for everything satisfies "peers was not rebuilt"
 * perfectly.
 *
 * ⚠️ ITS `registrationError` HALF WENT WITH THE SECTION. `claims` is an owned
 * input of a section that still exists, so the control keeps its power.
 */
test("a change a section DOES own rebuilds that section", () => {
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
test("a change to the activity Set alone rebuilds peers", () => {
  const due = plan((s) => {
    s.activity = new Set(["a"]);
  });

  // 🛑 AND NOT AGENTS, THOUGH ITS ROW IS A `sidebarItem` TOO. `activity`
  // moves on its own, and a rebuild of the agents section discards a half-typed
  // gate percent. `paintPulse` already dresses that row — see the pin below.
  assert.deepEqual(due, ["peers"]);
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
 * 🛑 THE HEADLINE CASE OF #399. `registrationDraft` was once an input of the
 * section it exists to protect, so typing was itself what triggered the rebuild
 * that swaps the focused <input> out.
 *
 * ⚠️ #397 MADE THIS STRUCTURAL RATHER THAN PLANNED. The form is in the settings
 * dialog now and no section reads the draft at all, so this guards against the
 * draft being signed again rather than against the original defect.
 */
test("no sidebar section is signed against the register form's draft", () => {
  const due = plan((s) => {
    s.registrationDraft = { handle: "cla", vendor: "cursor", mode: "docker" };
  });

  assert.deepEqual(due, []);
});

/**
 * 🛑 THE CLEAR MUST BE IN THE SUCCESS BRANCH, AND THE REPAINT AFTER BOTH.
 * A clear moved into the `catch` wipes what the operator typed at the one moment
 * they need it — the route has refused the pair and they have one field to fix.
 * A repaint moved inside the `try` builds the error message and never renders it.
 *
 * ⚠️ THIS REPLACED AN EPOCH PIN, and the claim is what survived, not the
 * mechanism. #397 moved the form out of the sidebar, so `registrationEpoch` had
 * no reader left and the panel repaints unconditionally.
 *
 * 🛑 `lastIndexOf`, NOT `indexOf`. The invalid-input path repaints too, and it
 * returns BEFORE the try — so the first hit would satisfy `caught < repaint`
 * for a tail that had been moved inside the try.
 */
test("submitRegistration clears in the success branch and repaints after both", () => {
  const fn = APP_CODE.slice(
    APP_CODE.indexOf("async function submitRegistration("),
  ).split("\n}")[0];

  const clear = fn.indexOf("state.registrationDraft = {");
  const caught = fn.indexOf("} catch");
  const repaint = fn.lastIndexOf("repaintSettings()");

  assert.notEqual(clear, -1, "no draft clear — the pin would be vacuous");
  assert.notEqual(caught, -1, "no catch — the ordering could not discriminate");
  assert.notEqual(repaint, -1, "submitRegistration never repaints the panel");
  assert.ok(clear < caught, "the clear is not in the SUCCESS branch");
  assert.ok(
    caught < repaint,
    "the repaint sits inside the try, so a refused pair never renders its error",
  );
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

/**
 * 🛑 #374 — THE AGENT ROW'S DOT COMES FROM `state.peers` AND `peers` IS STILL
 * NOT AN AGENTS INPUT. Declaring it would rebuild this section on every peer
 * event, and it holds a half-typed gate percent that `gateControl` keeps in the
 * DOM rather than in state — #399's registration defect in a second place.
 * `paintAgentDots` updates the dot in place, which is why the plan stays narrow.
 */
test("a peer going offline rebuilds peers only, never the gate editor's section", () => {
  const due = plan((s) => {
    s.peers = [{ handle: "a", online: false }];
  });

  assert.deepEqual(due, ["peers"]);
});

/**
 * ⚠️ THE PIN THAT MAKES THE SKIP SAFE. A dot that no rebuild announces must be
 * painted out of band, and that paint has to follow the rebuild loop — called
 * before it, a fresh section would overwrite what it just wrote.
 */
test("renderSidebar paints the agent dots after it rebuilds", () => {
  const paint = APP_CODE.indexOf("paintAgentDots()");
  const loop = APP_CODE.indexOf("SECTION_BUILDERS[key]()");

  assert.notEqual(paint, -1, "nothing calls paintAgentDots");
  assert.notEqual(loop, -1, "no rebuild loop — the pin would be vacuous");
  assert.ok(loop < paint, "the paint must follow the rebuild it corrects");
});

/**
 * 🛑 WHAT MAKES `activity`'s ABSENCE SAFE, AND IT IS A PROPERTY OF ONE
 * SELECTOR. `paintPulse` is not scoped to the peers section, so it already
 * dresses an agent row — which is built with `kind: "peer"` and therefore
 * carries `data-kind="peer"`. Scope that selector to a section and the agents
 * row silently stops pulsing, with the planner test above still green.
 *
 * ⚠️ ONE ROW PER HANDLE IS THE OTHER HALF. `querySelector` takes the first
 * match, and `peersMinusSupervised` is what guarantees a supervised child is
 * not also drawn in the peers section.
 */
test("the pulse selector reaches an agent row, not just a peers one", () => {
  const body = APP_CODE.slice(APP_CODE.indexOf("function paintPulse("));

  assert.ok(body.length > 0, "paintPulse not found in app.js");

  const selector = body.match(/`([^`]*sidebar__item[^`]*)`/);

  assert.notEqual(selector, null, "paintPulse no longer builds a selector");
  assert.match(
    selector![1]!,
    /\[data-kind="peer"\]/,
    "the pulse must key on the peer kind, which an agent row also carries",
  );
  assert.doesNotMatch(
    selector![1]!,
    /data-section|\.agent|sidebar__section/,
    "the pulse selector is scoped to a section, so it cannot reach an agent row",
  );
});
