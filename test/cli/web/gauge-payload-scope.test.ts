import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * 🛑 THIS GUARD IS SCOPED TO A PATTERN, NOT TO A ROUTE NAME.
 *
 * `/api/agents` shipped `context_ramp` on the supervised child's row and
 * NOTHING could see it go away: every ramp assertion lived in
 * `whoami-ramp.test.ts`, which only ever fetches `/api/whoami`. Deleting the
 * child's ramp left 2022 of 2022 passing — measured by claude2 on PR 315.
 *
 * That child row is the whole subject of #135, and `gaugeDisplay`'s no-ramp
 * fallback renders a fill with NO colour, so the agent closest to a restart was
 * the one the guard could not reach. A test named `/api/agents` would fix this
 * instance and miss the next builder the same way, which is #268's own lesson.
 *
 * So the subject here is the PAIRING: every gauge payload in `server.ts` ships
 * a ramp, computed for the SAME receiver whose freshness it just spread.
 *
 * ⚠️ THE SHIM TOOLS ARE OUT OF SCOPE ON PURPOSE. `src/shim/tools/whoami.ts`
 * and `list_agents.ts` also call `gaugeFreshness`, and their consumer is an
 * agent reading JSON, not the browser that colours a gauge. Nothing renders a
 * band from them.
 */

const SERVER = readFileSync(
  new URL("../../../src/cli/web/server.ts", import.meta.url),
  "utf8",
);

/**
 * `server.ts` with both comment forms gone, so this docblock's own mention of
 * `gaugeFreshness` cannot satisfy the count below.
 */
const CODE = SERVER.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

type Site = { index: number; recv: string };

function sites(re: RegExp): Site[] {
  return [...CODE.matchAll(re)].map((m) => ({
    index: m.index!,
    recv: m[1]!,
  }));
}

/**
 * Where a gauge payload spreads a freshness verdict, and for whom.
 *
 * 🛑 `\??\.` IS NOT DEFENSIVE. `me` is the one nullable row in `handleWhoami`
 * and is already read as `me?.session_id`, so a self-gauge — the likeliest next
 * builder — would be written `me?.context_reported_at` and a `\w+\.` regex
 * cannot see it. MEASURED: such a payload with NO ramp passed 2 of 2 before
 * this. Raised by claude2 reviewing PR 315.
 */
function freshnessSites(): Site[] {
  return sites(/gaugeFreshness\(\s*(\w+)\??\.context_reported_at/g);
}

/** Where a gauge payload ships a ramp, and for whom. */
function rampSites(): Site[] {
  return sites(
    /context_ramp:\s*contextRampFor\(\s*\w+\??\.db,\s*(\w+)\??\.handle/g,
  );
}

test("🛑 EVERY gauge payload in server.ts ships a ramp beside its freshness", () => {
  const fresh = freshnessSites();
  const ramps = rampSites();

  // The non-vacuity floor. Both known builders must be visible to this test,
  // or a regex that matches nothing passes with two empty lists.
  assert.ok(
    fresh.length >= 2,
    `only ${fresh.length} gauge payloads found — the regex stopped matching`,
  );

  assert.equal(
    ramps.length,
    fresh.length,
    `${fresh.length} gauge payloads, ${ramps.length} ramps. Unpaired receivers: ` +
      fresh
        .map((f) => f.recv)
        .filter((r) => !ramps.some((p) => p.recv === r))
        .join(", "),
  );
});

/**
 * 🛑 THE COUNT ALONE WOULD LAUNDER A MISPLACED RAMP. Two ramps on one builder
 * and none on the other still totals two, and a ramp computed for the
 * SUPERVISOR's handle rather than the child's reads the wrong gate while
 * keeping the count intact.
 */
test("🛑 each ramp sits inside its OWN payload and names the same receiver", () => {
  const fresh = freshnessSites();
  const ramps = rampSites();

  assert.equal(
    ramps.length,
    fresh.length,
    "counts diverged — see the test above",
  );

  fresh.forEach((f, i) => {
    const r = ramps[i]!;
    const next = fresh[i + 1]?.index ?? CODE.length;

    assert.ok(
      r.index > f.index && r.index < next,
      `the ramp for \`${f.recv}\` is outside its own payload`,
    );
    assert.equal(
      r.recv,
      f.recv,
      `payload spreads \`${f.recv}\`'s freshness and ships \`${r.recv}\`'s ramp`,
    );
  });
});
